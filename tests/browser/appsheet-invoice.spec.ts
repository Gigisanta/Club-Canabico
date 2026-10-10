import { randomUUID } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import { expect, test } from "./isolated";

type CommandEnvelope = {
  schemaVersion: number;
  requestId: string;
  targetId: string;
  expectedVersion: number;
  occurredAt: string;
  command: string;
  data: Record<string, unknown>;
};

const field = (container: ReturnType<Page["getByTestId"]>, name: string) =>
  container.locator(`[name="${name}"]`);

function isCommand(request: Request, command?: string) {
  if (request.method() !== "POST" || !request.url().endsWith("/api/operations/commands")) return false;
  try {
    return command === undefined || request.postDataJSON().command === command;
  } catch {
    return false;
  }
}

async function enterOrders(page: Page) {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
}

async function openInvoice(page: Page) {
  await page.getByTestId("appsheet-invoice-open").click();
  const dialog = page.getByTestId("appsheet-invoice-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function setSelectOrFill(container: ReturnType<Page["getByTestId"]>, name: string, value: string) {
  const control = field(container, name);
  const tagName = await control.evaluate(element => element.tagName);
  if (tagName === "SELECT") await control.selectOption(value);
  else await control.fill(value);
}

async function enableMoto(container: ReturnType<Page["getByTestId"]>) {
  await container.getByRole("radio", { name: "Sí", exact: true }).click();
}

async function selectMember(
  invoice: ReturnType<Page["getByTestId"]>,
  id: string,
  searchText: string,
  searchLabel = "Buscar cliente por nombre",
) {
  await invoice.getByRole("searchbox", { name: searchLabel, exact: true }).fill(searchText);
  const member = field(invoice, "memberId");
  await expect(member.locator(`option[value="${id}"]`)).toHaveCount(1);
  await member.selectOption(id);
}

async function addProduct(page: Page, invoice: ReturnType<Page["getByTestId"]>, values: {
  date: string;
  skuId: string;
  scale: string;
  quantity: string;
  total: string;
}) {
  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await field(product, "line-date").fill(values.date);
  const productChoice = field(product, "line-skuId");
  const pendingChoice = productChoice.locator(`option[data-sku-id="${values.skuId}"][data-source-lot-pending="true"]`);
  if (await pendingChoice.count() === 1) {
    const value = await pendingChoice.getAttribute("value");
    if (value === null) throw new Error("La opción pendiente de origen no tiene un valor seleccionable.");
    await productChoice.selectOption(value);
  } else {
    await productChoice.selectOption(values.skuId);
  }
  await setSelectOrFill(product, "line-scale", values.scale);
  await field(product, "line-quantity").fill(values.quantity);
  await field(product, "line-total").fill(values.total);
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);
}

async function addMoto(page: Page, invoice: ReturnType<Page["getByTestId"]>, values: {
  deliveryDate: string;
  paymentMethod: string;
  serviceType: string;
  destination: string;
  clientTariff: string;
  adminTariff: string;
  totalTariff: string;
  notes: string;
}, inspect?: (moto: ReturnType<Page["getByTestId"]>) => Promise<void>) {
  await invoice.getByTestId("appsheet-add-moto").click();
  const moto = page.getByTestId("appsheet-moto-dialog");
  await expect(moto).toBeVisible();
  await field(moto, "moto-deliveryDate").fill(values.deliveryDate);
  await field(moto, "moto-paymentMethod").selectOption(values.paymentMethod);
  await setSelectOrFill(moto, "moto-serviceType", values.serviceType);
  await field(moto, "moto-destination").fill(values.destination);
  await field(moto, "moto-clientTariff").fill(values.clientTariff);
  await field(moto, "moto-adminTariff").fill(values.adminTariff);
  await field(moto, "moto-totalTariff").fill(values.totalTariff);
  await field(moto, "moto-notes").fill(values.notes);
  if (inspect) await inspect(moto);
  await moto.getByRole("button", { name: "Añadir viaje en moto", exact: true }).click();
  await expect(moto).toHaveCount(0);
}

async function getJson(page: Page, path: string) {
  const response = await page.request.get(`/api/operations/${path}`);
  if (response.status() !== 200) {
    throw new Error(`${path}: ${await response.text()}`);
  }
  return response.json();
}

async function fulfillCatalogAvailability(route: Route, availability: (skuId: string) => string | undefined) {
  const response = await route.fetch();
  if (response.status() !== 200) return route.fulfill({ response });
  const body = await response.json() as { items?: Array<Record<string, unknown>> };
  const items = (body.items ?? []).map(item => {
    const appSheet = item.appSheet && typeof item.appSheet === "object" && !Array.isArray(item.appSheet)
      ? item.appSheet as Record<string, unknown>
      : {};
    const { availability: _previous, ...rest } = appSheet;
    const nextAvailability = availability(String(item.id));
    return { ...item, appSheet: nextAvailability === undefined ? rest : { ...rest, availability: nextAvailability } };
  });
  return route.fulfill({ response, json: { ...body, items } });
}

async function financeSnapshot(page: Page) {
  const [collections, accounts] = await Promise.all([
    getJson(page, "collections"),
    getJson(page, "accounts"),
  ]);
  const ledgers = await Promise.all(accounts.items.map(async (account: { id: string }) => {
    const ledger = await getJson(page, `accounts/${encodeURIComponent(account.id)}/ledger`);
    return [account.id, ledger.items.map((item: { id: string }) => item.id).sort()] as const;
  }));
  return {
    collections: collections.items.map((item: { id: string }) => item.id).sort(),
    ledgers: Object.fromEntries(ledgers.sort(([left], [right]) => left.localeCompare(right))),
  };
}

async function stockSnapshot(page: Page, skuId: string) {
  const catalog = await getJson(page, "catalog");
  const sku = catalog.items.find((item: { id: string }) => item.id === skuId);
  if (!sku) throw new Error(`No se encontró el SKU sintético ${skuId}`);
  return sku.lots.flatMap((lot: { id: string; balances: Array<Record<string, unknown>> }) =>
    lot.balances.map(balance => ({
      lotId: lot.id,
      balanceId: balance.id,
      quantity: balance.quantity,
      reserved: balance.reserved,
      availableQuantity: balance.availableQuantity,
    })),
  ).sort((left: { balanceId: unknown }, right: { balanceId: unknown }) => String(left.balanceId).localeCompare(String(right.balanceId)));
}

async function postCommand(page: Page, envelope: CommandEnvelope) {
  const response = await page.request.post("/api/operations/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: envelope,
  });
  const status = response.status();
  const text = status === 200 ? "" : await response.text();
  expect(status, text).toBe(200);
  return response.json();
}

async function saveResponse(page: Page, command: string) {
  return page.waitForResponse(response => isCommand(response.request(), command));
}

test("canceling product and moto subforms keeps the invoice local until Guardar", async ({ page }) => {
  await enterOrders(page);
  const invoice = await openInvoice(page);
  const initialTotals = await invoice.locator(".appsheet-totals").innerText();
  const commandPosts: Request[] = [];
  page.on("request", request => {
    if (isCommand(request)) commandPosts.push(request);
  });

  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await field(product, "line-skuId").selectOption("ops-sku-c");
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-quantity").fill("2.5");
  await field(product, "line-total").fill("9.99");
  await product.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(product).toHaveCount(0);
  await expect(invoice).toBeVisible();
  await expect(invoice.locator(".appsheet-totals")).toHaveText(initialTotals, { useInnerText: true });

  await enableMoto(invoice);
  const moto = page.getByTestId("appsheet-moto-dialog");
  await expect(moto).toBeVisible();
  await field(moto, "moto-deliveryDate").fill("2026-10-06");
  await field(moto, "moto-paymentMethod").selectOption("mercado_pago");
  await field(moto, "moto-destination").fill("Destino sintético no guardado");
  await field(moto, "moto-clientTariff").fill("10.00");
  await field(moto, "moto-adminTariff").fill("4.00");
  await field(moto, "moto-totalTariff").fill("14.00");
  await field(moto, "moto-notes").fill("Borrador de viaje cancelado.");
  await moto.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(moto).toHaveCount(0);
  await expect(invoice).toBeVisible();
  await expect(invoice.getByRole("radio", { name: "No", exact: true })).toBeChecked();
  await expect(invoice.locator(".appsheet-totals")).toHaveText(initialTotals, { useInnerText: true });

  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
  expect(commandPosts).toHaveLength(0);
});

test("AppSheet invoice retries the save, confirms an independent total, and settles product and moto receipts once", async ({ page }) => {
  await enterOrders(page);
  const financeBefore = await financeSnapshot(page);
  const invoice = await openInvoice(page);
  const invoiceDate = "2026-10-05";
  const note = "Nota sintética de la factura de ensayo.";
  const invoiceNumber = `E2E-${crypto.randomUUID()}`;
  await field(invoice, "invoiceNumber").fill(invoiceNumber);
  await field(invoice, "invoiceDate").fill(invoiceDate);
  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await expect(field(invoice, "address")).toHaveValue("Dirección sintética 123");
  await field(invoice, "address").fill("Domicilio sintético 44");
  await field(invoice, "productPaymentMethod").selectOption("cash");
  await field(invoice, "note").fill(note);
  await addProduct(page, invoice, {
    date: invoiceDate,
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3.007",
    total: "12.01",
  });
  const moto = {
    deliveryDate: "2026-10-06",
    paymentMethod: "mercado_pago",
    serviceType: "CABA",
    destination: "Destino sintético 44",
    clientTariff: "25.00",
    adminTariff: "17.00",
    totalTariff: "39.00",
    notes: "Moto sintética: tarifa de administración conservada aparte.",
  };
  await addMoto(page, invoice, moto, async dialog => {
    await expect(field(dialog, "moto-transfer")).toHaveValue("Pendiente de definición");
    await expect(field(dialog, "moto-subtotal")).toHaveValue("Pendiente de definición");
  });
  await expect(invoice.getByTestId("appsheet-moto-transfer-preview")).toHaveText("Pendiente de definición");
  await expect(invoice.getByTestId("appsheet-moto-subtotal-preview")).toHaveText("Pendiente de definición");
  await expect(invoice.getByTestId("appsheet-total-preview")).toHaveText("Pendiente de definición");

  const envelopes: CommandEnvelope[] = [];
  let committed: Record<string, unknown> | undefined;
  const loseFirstAcknowledgement = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    if (!isCommand(request, "InvoiceSaved")) return route.continue();
    envelopes.push(request.postDataJSON() as CommandEnvelope);
    if (envelopes.length === 1) {
      // Execute the actual API write, then drop only its response at the browser boundary.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = await response.json();
      await route.abort("failed");
      return;
    }
    await route.continue();
  };
  await page.route("**/api/operations/commands", loseFirstAcknowledgement);

  await invoice.getByTestId("appsheet-save-invoice").click();
  await expect(invoice.getByRole("alert")).toContainText("Confirmación pendiente");
  const formControls = invoice.locator("input:not([type=hidden]), select, textarea");
  await expect.poll(() => formControls.evaluateAll(elements => elements.every(element =>
    element.matches(":disabled") || ("readOnly" in element && Boolean((element as HTMLInputElement).readOnly)),
  ))).toBe(true);
  const retry = invoice.getByTestId("appsheet-retry-invoice").last();
  await expect(retry).toBeEnabled();
  expect(committed).toBeDefined();
  expect(envelopes).toHaveLength(1);

  const first = envelopes[0]!;
  expect(first.command).toBe("InvoiceSaved");
  expect(first.data).toMatchObject({
    memberId: "ops-member",
    invoiceNumber,
    invoiceDate,
    currency: "ARS",
    address: { address: "Domicilio sintético 44" },
    note,
    productPaymentMethod: "cash",
  });
  const firstData = first.data as Record<string, unknown> & { lines: Array<Record<string, unknown>>; moto: Record<string, unknown> };
  expect(firstData).not.toHaveProperty("productTransferMinor");
  expect(firstData.lines).toHaveLength(1);
  expect(firstData.lines[0]).toMatchObject({
    skuId: "ops-sku-c",
    date: invoiceDate,
    scale: "Precio_5_Gramos",
    quantity: "3.007",
    totalMinor: "1201",
  });
  expect(firstData.moto).toMatchObject({
    deliveryDate: moto.deliveryDate,
    paymentMethod: "mercado_pago",
    serviceType: moto.serviceType,
    destination: moto.destination,
    clientTariffMinor: "2500",
    adminTariffMinor: "1700",
    totalTariffMinor: "3900",
    notes: moto.notes,
  });
  expect(firstData.moto).not.toHaveProperty("transferMinor");

  const listRefresh = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders");
  const retryResponse = saveResponse(page, "InvoiceSaved");
  await retry.click();
  const response = await retryResponse;
  const responseStatus = response.status();
  const responseText = responseStatus === 200 ? "" : await response.text();
  expect(responseStatus, responseText).toBe(200);
  const replay = await response.json();
  expect(replay.replay).toBe(true);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[1]).toEqual(first);
  expect(replay.requestId).toBe(first.requestId);
  expect(replay.targetId).toBe(first.targetId);
  await page.unroute("**/api/operations/commands", loseFirstAcknowledgement);

  await expect(invoice).toHaveCount(0);
  const refreshed = await listRefresh;
  const orders = await refreshed.json();
  expect(orders.items.filter((item: { id: string }) => item.id === first.targetId)).toHaveLength(1);
  const refreshedRow = page.locator("tbody tr").filter({ hasText: invoiceNumber });
  await expect(refreshedRow).toHaveCount(1);
  await expect(refreshedRow).toBeVisible();

  const detail = await getJson(page, `orders/${encodeURIComponent(first.targetId)}`);
  expect(detail.order).toMatchObject({
    id: first.targetId,
    memberId: "ops-member",
    commercialState: "confirmed",
    totalMinor: null,
    capturedBaseMinor: "3701",
    subtotalMinor: null,
    capturedProductMinor: "1201",
    totalCalculationState: "pending_definition",
  });
  expect(detail.order.quote).toMatchObject({
    invoiceNumber,
    invoiceDate,
    note,
    subtotalCalculationState: "pending_definition",
  });
  expect(detail.order.quote.input.address).toEqual({ address: "Domicilio sintético 44" });
  expect(detail.order.quote.paymentComponents.products).toMatchObject({
    paymentMethod: "cash",
    transferMinor: null,
    transferCalculationState: "pending_definition",
    totalMinor: "1201",
  });
  expect(detail.order.quote.lines).toHaveLength(1);
  expect(detail.order.quote.lines[0]).toMatchObject({
    date: invoiceDate,
    scale: "Precio_5_Gramos",
    requested: "3.007",
    explicitTotalMinor: "1201",
  });
  expect(detail.order.lines).toHaveLength(1);
  expect(detail.order.lines[0].revenueMinor).toBe("1201");
  expect(detail.order.quote.moto).toMatchObject({
    deliveryDate: moto.deliveryDate,
    paymentMethod: "mercado_pago",
    serviceType: moto.serviceType,
    destination: moto.destination,
    clientTariffMinor: "2500",
    adminTariffMinor: "1700",
    totalTariffMinor: "3900",
    notes: moto.notes,
  });
  expect(detail.order.quote.paymentComponents.moto).toMatchObject({
    paymentMethod: "mercado_pago",
    transferMinor: null,
    transferCalculationState: "pending_definition",
    clientTariffMinor: "2500",
    adminTariffMinor: "1700",
    totalTariffMinor: "3900",
  });
  expect(detail.reservations).toHaveLength(1);
  expect(detail.reservations[0]).toMatchObject({
    lineId: firstData.lines[0]!.id,
    quantity: "3.007",
  });
  expect(detail.deliveries).toHaveLength(1);
  expect(detail.deliveries[0].address).toMatchObject({ motoDestination: moto.destination, motoDeliveryDate: moto.deliveryDate });
  expect((committed!.result as Record<string, unknown>).deliveryId).toBe(detail.deliveries[0].id);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  const stockBeforeTotalConfirmation = await stockSnapshot(page, "ops-sku-c");
  const financeBeforeTotalConfirmation = await financeSnapshot(page);
  const totalEnvelopes: CommandEnvelope[] = [];
  const trackTotalConfirmation = async (route: import("@playwright/test").Route) => {
    if (!isCommand(route.request(), "InvoiceTotalsConfirmed")) return route.continue();
    totalEnvelopes.push(route.request().postDataJSON() as CommandEnvelope);
    return route.continue();
  };
  await page.route("**/api/operations/commands", trackTotalConfirmation);
  await refreshedRow.getByRole("button", { name: "Confirmar total facturado", exact: true }).click();
  const totalDialog = page.getByRole("dialog");
  await expect(totalDialog.getByRole("heading", { name: "Confirmar total facturado", exact: true })).toBeVisible();
  await expect(totalDialog.getByLabel("Moneda de la factura", { exact: true })).toHaveValue("ARS");
  await totalDialog.getByLabel("Moneda de la factura", { exact: true }).selectOption("ARS");
  await totalDialog.getByLabel("Total de productos confirmado", { exact: true }).fill("13.51");
  await totalDialog.getByLabel("Total de moto confirmado", { exact: true }).fill("26.00");
  const totalEvidence = "Transcripción sintética de la factura fuente: productos ARS 13.51 y moto ARS 26.00.";
  await totalDialog.getByLabel("Evidencia del total facturado", { exact: true }).fill(totalEvidence);

  const totalOrdersRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  const totalConfirmationResponse = saveResponse(page, "InvoiceTotalsConfirmed");
  await totalDialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const totalResponse = await totalConfirmationResponse;
  const totalStatus = totalResponse.status();
  const totalText = totalStatus === 200 ? "" : await totalResponse.text();
  expect(totalStatus, totalText).toBe(200);
  const totalReceipt = await totalResponse.json();
  expect(totalEnvelopes).toHaveLength(1);
  const totalEnvelope = totalEnvelopes[0]!;
  expect(totalEnvelope).toMatchObject({
    command: "InvoiceTotalsConfirmed",
    targetId: first.targetId,
    expectedVersion: 1,
  });
  expect(totalEnvelope.data).toEqual({
    currency: "ARS",
    productsTotalMinor: "1351",
    motoClientTotalMinor: "2600",
    evidence: { note: totalEvidence },
  });
  expect(totalReceipt.result).toMatchObject({
    orderId: first.targetId,
    totalMinor: "3951",
    totalCalculationState: "staff_confirmed",
    totalCalculationSource: "staff_confirmation",
  });
  await page.unroute("**/api/operations/commands", trackTotalConfirmation);

  const totalOrders = await (await totalOrdersRefresh).json();
  expect(totalOrders.items.filter((item: { id: string }) => item.id === first.targetId)).toHaveLength(1);
  await expect(totalDialog).toHaveCount(0);
  await expect(refreshedRow).toContainText("ARS 39,51");
  await expect(refreshedRow).toContainText("Productos ARS 13,51 · Moto ARS 26,00");
  await expect(refreshedRow).toContainText("Confirmado por el personal");
  await expect(refreshedRow).not.toContainText("Pendiente de definición");
  await expect(refreshedRow.getByRole("button", { name: "Confirmar total facturado", exact: true })).toHaveCount(0);

  const confirmedDetail = await getJson(page, `orders/${encodeURIComponent(first.targetId)}`);
  expect(confirmedDetail.order).toMatchObject({
    totalMinor: "3951",
    quoteVersion: 1,
    capturedBaseMinor: "3701",
    capturedProductMinor: "1201",
    totalCalculationState: "staff_confirmed",
    totalCalculationSource: "staff_confirmation",
    financialResolution: {
      kind: "staff_confirmation",
      currency: "ARS",
      productsTotalMinor: "1351",
      motoClientTotalMinor: "2600",
      totalMinor: "3951",
      evidence: { note: totalEvidence },
    },
  });
  expect(confirmedDetail.order.quote).toMatchObject({
    totalMinor: "3951",
    totalCalculationState: "staff_confirmed",
    totalCalculationSource: "staff_confirmation",
    financialResolution: {
      kind: "staff_confirmation",
      productsTotalMinor: "1351",
      motoClientTotalMinor: "2600",
      totalMinor: "3951",
      evidence: { note: totalEvidence },
    },
    paymentComponents: {
      products: { totalMinor: "1351" },
      moto: { clientTotalMinor: "2600" },
    },
  });
  expect(confirmedDetail.order.quote.moto.clientTariffMinor).toBe("2500");
  expect(confirmedDetail.reservations).toEqual(detail.reservations);
  expect(confirmedDetail.deliveries).toEqual(detail.deliveries);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBeforeTotalConfirmation);
  expect(await financeSnapshot(page)).toEqual(financeBeforeTotalConfirmation);

  const financialResolution = confirmedDetail.order.financialResolution;
  expect(financialResolution).toMatchObject({
    kind: "staff_confirmation",
    currency: "ARS",
    productsTotalMinor: "1351",
    motoClientTotalMinor: "2600",
    totalMinor: "3951",
    evidence: { note: totalEvidence },
    quoteVersion: 1,
  });
  expect(financialResolution.actorId).toBeTruthy();
  expect(Date.parse(financialResolution.confirmedAt)).not.toBeNaN();
  expect(financialResolution.snapshotHash).toMatch(/^[a-f0-9]{64}$/i);

  const traceViewPosts: Request[] = [];
  const trackTraceViewPosts = (request: Request) => {
    if (request.method() === "POST") traceViewPosts.push(request);
  };
  page.on("request", trackTraceViewPosts);
  const traceButton = refreshedRow.getByRole("button", { name: "Ver confirmación del total", exact: true });
  if (!(await traceButton.isVisible())) await refreshedRow.locator("details.ops-row-actions-disclosure summary").click();
  await traceButton.click();
  const traceDialog = page.getByTestId("appsheet-invoice-total-trace-dialog");
  await expect(traceDialog.getByRole("heading", { name: "Confirmación del total facturado", exact: true })).toBeVisible();
  const traceField = (label: string) => traceDialog.locator(".ops-field").filter({ hasText: label });
  await expect(traceField("Total de productos confirmado")).toContainText("ARS 13,51");
  await expect(traceField("Total de moto confirmado")).toContainText("ARS 26,00");
  await expect(traceField("Total facturado confirmado")).toContainText("ARS 39,51");
  await expect(traceField("Evidencia registrada")).toContainText(financialResolution.evidence.note);
  await expect(traceField("Confirmado por")).toContainText(financialResolution.actorId);
  await expect(traceField("Fecha de confirmación")).toContainText(financialResolution.confirmedAt);
  await expect(traceField("Versión de cotización")).toContainText(String(financialResolution.quoteVersion));
  await expect(traceField("Huella del resumen confirmado")).toContainText(financialResolution.snapshotHash);
  await traceDialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(traceDialog).toHaveCount(0);
  page.off("request", trackTraceViewPosts);
  expect(traceViewPosts).toHaveLength(0);

  const accountsBeforeCollections = await getJson(page, "accounts");
  const cashBefore = BigInt(accountsBeforeCollections.items.find((account: { id: string }) => account.id === "ops-cash-ARS").balanceMinor);
  const bankBefore = BigInt(accountsBeforeCollections.items.find((account: { id: string }) => account.id === "ops-bank-ARS").balanceMinor);
  const collections = [
    { id: crypto.randomUUID(), method: "cash", amountMinor: "1351", accountId: "ops-cash-ARS", component: "productos" },
    { id: crypto.randomUUID(), method: "mercado_pago", amountMinor: "2600", accountId: "ops-bank-ARS", component: "moto" },
  ];
  for (const collection of collections) {
    const reportEnvelope: CommandEnvelope = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      targetId: collection.id,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
      command: "CollectionReported",
      data: {
        orderId: first.targetId,
        method: collection.method,
        currency: "ARS",
        amountMinor: collection.amountMinor,
        evidence: { note: `Reporte sintético recibido para ${collection.component}.` },
      },
    };
    const reportReceipt = await postCommand(page, reportEnvelope);
    expect(reportReceipt.result).toMatchObject({ effect: "reported_only", report: { id: collection.id, status: "reported" } });
  }
  const financeAfterReports = await financeSnapshot(page);
  expect(financeAfterReports.collections).toEqual(
    [...financeBeforeTotalConfirmation.collections, ...collections.map(({ id }) => id)].sort(),
  );
  expect(financeAfterReports.ledgers).toEqual(financeBeforeTotalConfirmation.ledgers);
  const orderBeforeCollectionVerification = await getJson(page, `orders/${encodeURIComponent(first.targetId)}`);
  expect(orderBeforeCollectionVerification.order).toMatchObject({
    totalMinor: "3951",
    verifiedMinor: "0",
    financialState: "unpaid",
  });
  const accountsAfterReports = await getJson(page, "accounts");
  expect(BigInt(accountsAfterReports.items.find((account: { id: string }) => account.id === "ops-cash-ARS").balanceMinor)).toBe(cashBefore);
  expect(BigInt(accountsAfterReports.items.find((account: { id: string }) => account.id === "ops-bank-ARS").balanceMinor)).toBe(bankBefore);

  const verificationEnvelopes: CommandEnvelope[] = [];
  for (const collection of collections) {
    const verificationEnvelope: CommandEnvelope = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      targetId: collection.id,
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      command: "CollectionVerified",
      data: {
        accountId: collection.accountId,
        evidence: { note: `Verificación sintética independiente de ${collection.component}.` },
      },
    };
    const verifiedReceipt = await postCommand(page, verificationEnvelope);
    expect(verifiedReceipt.result).toMatchObject({ collectionId: collection.id, appliedMinor: collection.amountMinor, excessMinor: "0" });
    verificationEnvelopes.push(verificationEnvelope);
  }
  const paidDetail = await getJson(page, `orders/${encodeURIComponent(first.targetId)}`);
  expect(paidDetail.order).toMatchObject({ totalMinor: "3951", verifiedMinor: "3951", financialState: "paid" });
  expect(BigInt(paidDetail.order.totalMinor) - BigInt(paidDetail.order.verifiedMinor)).toBe(0n);
  expect(collections.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n)).toBe(BigInt(paidDetail.order.totalMinor));
  const verifiedCollections = await getJson(page, "collections");
  expect(collections.map(({ id }) => verifiedCollections.items.find((item: { id: string }) => item.id === id))).toMatchObject([
    { status: "verified", accountId: "ops-cash-ARS", amountMinor: "1351", appliedMinor: "1351" },
    { status: "verified", accountId: "ops-bank-ARS", amountMinor: "2600", appliedMinor: "2600" },
  ]);
  const accountsAfterCollections = await getJson(page, "accounts");
  expect(BigInt(accountsAfterCollections.items.find((account: { id: string }) => account.id === "ops-cash-ARS").balanceMinor)).toBe(cashBefore + 1351n);
  expect(BigInt(accountsAfterCollections.items.find((account: { id: string }) => account.id === "ops-bank-ARS").balanceMinor)).toBe(bankBefore + 2600n);
  const financeAfterCollections = await financeSnapshot(page);
  for (const accountId of ["ops-cash-ARS", "ops-bank-ARS"]) {
    const beforeIds = financeBeforeTotalConfirmation.ledgers[accountId] ?? [];
    const afterIds = financeAfterCollections.ledgers[accountId] ?? [];
    expect(afterIds.filter(id => !beforeIds.includes(id))).toHaveLength(1);
  }
  const [cashLedger, bankLedger] = await Promise.all([
    getJson(page, "accounts/ops-cash-ARS/ledger"),
    getJson(page, "accounts/ops-bank-ARS/ledger"),
  ]);
  const cashBeforeIds = financeBeforeTotalConfirmation.ledgers["ops-cash-ARS"] ?? [];
  const bankBeforeIds = financeBeforeTotalConfirmation.ledgers["ops-bank-ARS"] ?? [];
  const cashCollectionLeg = cashLedger.items.find((item: { id: string }) => !cashBeforeIds.includes(item.id));
  const bankCollectionLeg = bankLedger.items.find((item: { id: string }) => !bankBeforeIds.includes(item.id));
  expect(cashCollectionLeg).toMatchObject({
    accountId: "ops-cash-ARS",
    currency: "ARS",
    amountMinor: "1351",
    event: {
      kind: "collection",
      sourceObjectId: collections[0]!.id,
      metadata: { orderId: first.targetId, appliedMinor: "1351", appliedCurrency: "ARS" },
    },
  });
  expect(bankCollectionLeg).toMatchObject({
    accountId: "ops-bank-ARS",
    currency: "ARS",
    amountMinor: "2600",
    event: {
      kind: "collection",
      sourceObjectId: collections[1]!.id,
      metadata: { orderId: first.targetId, appliedMinor: "2600", appliedCurrency: "ARS" },
    },
  });
  expect(financeAfterCollections.collections).toEqual(
    [...financeBeforeTotalConfirmation.collections, ...collections.map(({ id }) => id)].sort(),
  );
  const replayedVerification = await postCommand(page, verificationEnvelopes[1]!);
  expect(replayedVerification.replay).toBe(true);
  expect(await financeSnapshot(page)).toEqual(financeAfterCollections);
  const afterReplay = await getJson(page, `orders/${encodeURIComponent(first.targetId)}`);
  expect(afterReplay.order).toMatchObject({ totalMinor: "3951", verifiedMinor: "3951", financialState: "paid" });
});

test("an unverified member rejection retains the invoice draft for a corrected real retry", async ({ page }) => {
  await enterOrders(page);
  const suffix = crypto.randomUUID();
  const unverifiedMemberId = crypto.randomUUID();
  const createMember = await page.request.post("/api/operations/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      targetId: unverifiedMemberId,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
      command: "MemberCreated",
      data: { name: `Socio sintético sin permiso ${suffix}`, address: {}, preferences: {} },
    },
  });
  const createMemberStatus = createMember.status();
  const createMemberText = createMemberStatus === 200 ? "" : await createMember.text();
  expect(createMemberStatus, createMemberText).toBe(200);

  const invoice = await openInvoice(page);
  const date = "2026-10-04";
  const note = "Borrador sintético que debe sobrevivir al rechazo.";
  await field(invoice, "invoiceDate").fill(date);
  await selectMember(invoice, unverifiedMemberId, `Socio sintético sin permiso ${suffix}`);
  await field(invoice, "address").fill("Domicilio sintético 55");
  await field(invoice, "productPaymentMethod").selectOption("cash");
  await field(invoice, "note").fill(note);
  await addProduct(page, invoice, {
    date,
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3",
    total: "18.73",
  });

  const attempts: CommandEnvelope[] = [];
  const trackInvoice = async (route: import("@playwright/test").Route) => {
    if (!isCommand(route.request(), "InvoiceSaved")) return route.continue();
    attempts.push(route.request().postDataJSON() as CommandEnvelope);
    return route.continue();
  };
  await page.route("**/api/operations/commands", trackInvoice);

  const rejectedPromise = saveResponse(page, "InvoiceSaved");
  await invoice.getByTestId("appsheet-save-invoice").click();
  const rejected = await rejectedPromise;
  expect(rejected.status()).toBe(423);
  expect(await rejected.json()).toMatchObject({ code: "MEMBER_PERMISSION_PENDING" });
  await expect(invoice).toBeVisible();
  await expect(field(invoice, "memberId")).toHaveValue(unverifiedMemberId);
  await expect(field(invoice, "invoiceDate")).toHaveValue(date);
  await expect(field(invoice, "note")).toHaveValue(note);
  await expect(invoice.getByRole("alert")).toContainText(/permiso|vigente/i);
  expect(attempts).toHaveLength(1);
  const rejectedData = attempts[0]!.data as Record<string, unknown> & { lines: Array<Record<string, unknown>> };
  expect(rejectedData.address).toEqual({ address: "Domicilio sintético 55" });
  expect(rejectedData.lines[0]).toMatchObject({ skuId: "ops-sku-c", quantity: "3", totalMinor: "1873" });
  const absentOrder = await page.request.get(`/api/operations/orders/${encodeURIComponent(attempts[0]!.targetId)}`);
  expect(absentOrder.status()).toBe(404);

  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await expect(field(invoice, "address")).toHaveValue("Dirección sintética 123");
  const savedPromise = saveResponse(page, "InvoiceSaved");
  await invoice.getByTestId("appsheet-save-invoice").click();
  const saved = await savedPromise;
  const savedStatus = saved.status();
  const savedText = savedStatus === 200 ? "" : await saved.text();
  expect(savedStatus, savedText).toBe(200);
  const savedBody = await saved.json();
  expect(savedBody.replay).toBeFalsy();
  expect(attempts).toHaveLength(2);
  const repairedData = attempts[1]!.data as Record<string, unknown> & { lines: Array<Record<string, unknown>> };
  expect(repairedData.memberId).toBe("ops-member");
  expect(repairedData.address).toEqual({ street: "Dirección sintética 123", address: "Dirección sintética 123" });
  expect(repairedData.invoiceDate).toBe(date);
  expect(repairedData.note).toBe(note);
  expect(repairedData.lines).toEqual(rejectedData.lines);
  await page.unroute("**/api/operations/commands", trackInvoice);

  await expect(invoice).toHaveCount(0);
  const detail = await getJson(page, `orders/${encodeURIComponent(savedBody.targetId)}`);
  expect(detail.order).toMatchObject({ id: savedBody.targetId, memberId: "ops-member", commercialState: "confirmed" });
  expect(detail.order.quote.input.address).toEqual(repairedData.address);
  expect(detail.order.quote.lines[0]).toMatchObject({ requested: "3", explicitTotalMinor: "1873" });
  expect(detail.order.lines).toHaveLength(1);
  expect(detail.deliveries).toHaveLength(0);
});

test("a synthetic replacement-profile preview calculates product and moto transfers independently", async ({ page }) => {
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, cutoverProfile: "appsheet-replacement" },
    } });
  });
  // This client-only replacement profile is a synthetic preview, not real authority or source-lot proof.
  await page.route("**/api/operations/catalog**", route => fulfillCatalogAvailability(route, skuId => {
    if (skuId === "ops-sku-c") return "Sí";
    return "NO";
  }));
  const commandPosts: Request[] = [];
  page.on("request", request => { if (isCommand(request)) commandPosts.push(request); });
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await selectMember(invoice, "ops-member", "Socio de ensayo");

  // An incomplete replacement invoice has no product formula yet, but selecting a
  // payment method must leave the form usable instead of dereferencing a missing preview.
  await field(invoice, "productPaymentMethod").selectOption("transfer");
  await expect(invoice).toBeVisible();
  await expect(field(invoice, "productTransfer")).toHaveValue("Pendiente de definición");

  await enableMoto(invoice);
  const moto = page.getByTestId("appsheet-moto-dialog");
  await expect(moto).toBeVisible();
  await field(moto, "moto-deliveryDate").fill("2026-10-06");
  await field(moto, "moto-paymentMethod").selectOption("transfer");
  await field(moto, "moto-serviceType").selectOption("CABA");
  await field(moto, "moto-destination").fill("Destino sintético de preview");
  await field(moto, "moto-clientTariff").fill("25.00");
  await field(moto, "moto-adminTariff").fill("17.00");
  await field(moto, "moto-totalTariff").fill("42.00");
  await field(moto, "moto-notes").fill("Preview sintético sin escritura.");
  await expect(field(moto, "moto-transfer")).toHaveValue("ARS 1,25");
  await expect(field(moto, "moto-subtotal")).toHaveValue("ARS 26,25");
  await field(moto, "moto-clientTariff").fill("-1.00");
  await expect(field(moto, "moto-transfer")).toHaveValue("Pendiente de definición");
  await expect(field(moto, "moto-subtotal")).toHaveValue("Pendiente de definición");
  await field(moto, "moto-clientTariff").fill("25.00");
  await expect(field(moto, "moto-transfer")).toHaveValue("ARS 1,25");

  await field(moto, "moto-paymentMethod").selectOption("mercado_pago");
  await expect(field(moto, "moto-transfer")).toHaveValue("ARS 1,25");
  await expect(field(moto, "moto-subtotal")).toHaveValue("ARS 26,25");
  await field(moto, "moto-paymentMethod").selectOption("cash");
  await expect(field(moto, "moto-transfer")).toHaveValue("ARS 0,00");
  await expect(field(moto, "moto-subtotal")).toHaveValue("ARS 25,00");
  await field(moto, "moto-paymentMethod").selectOption("transfer");

  await moto.getByRole("button", { name: "Añadir viaje en moto", exact: true }).click();
  await expect(moto).toHaveCount(0);
  await expect(invoice.getByTestId("appsheet-moto-transfer-preview")).toContainText("1,25");
  await expect(invoice.getByTestId("appsheet-moto-subtotal-preview")).toContainText("26,25");
  await expect(invoice.getByTestId("appsheet-total-preview")).toHaveText("Pendiente de definición");
  await expect(field(invoice, "productTransfer")).toHaveValue("Pendiente de definición");

  await addProduct(page, invoice, {
    date: "2026-10-05",
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3",
    total: "12.01",
  });

  await expect(invoice.getByTestId("appsheet-product-transfer-preview")).toContainText("0,60");
  await expect(invoice.getByTestId("appsheet-moto-transfer-preview")).toContainText("1,25");
  await expect(invoice.getByTestId("appsheet-moto-subtotal-preview")).toContainText("26,25");
  await expect(invoice.getByTestId("appsheet-total-preview")).toContainText("38,86");
  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
  expect(commandPosts).toHaveLength(0);
});

test("replacement invoice enforces AppSheet quantity bounds and exact catalog availability without writing", async ({ page }) => {
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, cutoverProfile: "appsheet-replacement" },
    } });
  });
  await page.route("**/api/operations/catalog**", route => fulfillCatalogAvailability(route, skuId => {
    if (skuId === "ops-sku-c") return "Sí";
    if (skuId === "ops-sku-a") return "NO";
    return undefined;
  }));
  const commandPosts: Request[] = [];
  page.on("request", request => { if (isCommand(request)) commandPosts.push(request); });
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await invoice.getByTestId("appsheet-add-product").click();

  const product = page.getByTestId("appsheet-product-dialog");
  const sku = field(product, "line-skuId");
  const skuOptions = await sku.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(skuOptions).toContain("ops-sku-c");
  expect(skuOptions).not.toContain("ops-sku-a");
  expect(skuOptions).not.toContain("ops-sku-b");
  await sku.selectOption("ops-sku-c");
  await field(product, "line-date").fill("2026-10-05");
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-total").fill("5.00");

  const quantity = field(product, "line-quantity");
  await expect(quantity).toHaveAttribute("type", "number");
  await expect(quantity).toHaveAttribute("min", "1");
  await expect(quantity).toHaveAttribute("max", "99");
  await expect(quantity).toHaveAttribute("step", "any");
  await expect(product.getByText("1–99 gramos, hasta tres decimales.", { exact: true })).toBeVisible();
  for (const outOfRange of ["0.999", "99.001"]) {
    await quantity.fill(outOfRange);
    expect(await quantity.evaluate(element => (element as HTMLInputElement).checkValidity())).toBe(false);
    await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
    await expect(product.getByRole("alert")).toContainText("1 y 99");
    await expect(quantity).toHaveValue(outOfRange);
  }

  await quantity.fill("1.2345");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product.getByRole("alert")).toContainText("hasta tres decimales");
  await expect(quantity).toHaveValue("1.2345");
  await quantity.fill("1");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(1);

  await invoice.getByTestId("appsheet-add-product").click();
  const upperBoundary = page.getByTestId("appsheet-product-dialog");
  await field(upperBoundary, "line-skuId").selectOption("ops-sku-c");
  await field(upperBoundary, "line-date").fill("2026-10-05");
  await field(upperBoundary, "line-scale").selectOption("Precio_5_Gramos");
  await field(upperBoundary, "line-quantity").fill("99");
  await field(upperBoundary, "line-total").fill("5.00");
  await upperBoundary.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(upperBoundary).toHaveCount(0);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(2);
  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
  expect(commandPosts).toHaveLength(0);
});

test("a catalog SKU that disappears after selection stays in the invoice draft and blocks save", async ({ page }) => {
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, cutoverProfile: "appsheet-replacement" },
    } });
  });
  let skuCAvailability = "Sí";
  let catalogReads = 0;
  await page.route("**/api/operations/catalog**", async route => {
    catalogReads += 1;
    return fulfillCatalogAvailability(route, skuId => skuId === "ops-sku-c" ? skuCAvailability : "NO");
  });
  const commandPosts: Request[] = [];
  page.on("request", request => { if (isCommand(request)) commandPosts.push(request); });
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await addProduct(page, invoice, {
    date: "2026-10-05",
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3",
    total: "12.01",
  });
  expect(catalogReads).toBeGreaterThan(0);
  skuCAvailability = "NO";
  const catalogReadsBeforeRefresh = catalogReads;
  const refreshedCatalog = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/catalog" && catalogReads > catalogReadsBeforeRefresh);
  await page.getByRole("button", { name: "↻ Actualizar", exact: true }).evaluate(element => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await refreshedCatalog;
  await expect(invoice.locator(".appsheet-subtle-error[role='alert']")).toContainText("ya no está disponible");

  await invoice.getByTestId("appsheet-save-invoice").click();
  await expect(invoice.locator(".ops-inline-error[role='alert']")).toContainText("elegí una variedad disponible");
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(1);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toContainText("3 g");
  expect(commandPosts).toHaveLength(0);
  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
});

test("legacy invoice keeps the not-NO catalog rule and positive sub-gram quantities", async ({ page }) => {
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, cutoverProfile: "legacy" },
    } });
  });
  await page.route("**/api/operations/catalog**", route => fulfillCatalogAvailability(route, skuId => skuId === "ops-sku-c" ? undefined : "NO"));
  const commandPosts: Request[] = [];
  page.on("request", request => { if (isCommand(request)) commandPosts.push(request); });
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  const quantity = field(product, "line-quantity");
  await expect(quantity).toHaveAttribute("type", "text");
  await expect(field(product, "line-skuId").locator('option[value="ops-sku-c"]')).toHaveCount(1);
  await field(product, "line-skuId").selectOption("ops-sku-c");
  await field(product, "line-date").fill("2026-10-05");
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await quantity.fill("0.5");
  await field(product, "line-total").fill("5.00");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(1);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toContainText("0.5 g");
  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
  expect(commandPosts).toHaveLength(0);
});

test("saving an AppSheet preorder stays pending until the separate confirmation command", async ({ page }) => {
  let skuCAvailability = "Sí";
  let catalogReads = 0;
  await page.route("**/api/operations/catalog**", async route => {
    catalogReads += 1;
    return fulfillCatalogAvailability(route, skuId => skuId === "ops-sku-c" ? skuCAvailability : "NO");
  });
  const invoiceUpdatedPosts: Request[] = [];
  const invoiceConfirmedPosts: Request[] = [];
  page.on("request", request => {
    if (isCommand(request, "InvoiceUpdated")) invoiceUpdatedPosts.push(request);
    if (isCommand(request, "InvoiceConfirmed")) invoiceConfirmedPosts.push(request);
  });
  await enterOrders(page);
  const financeBefore = await financeSnapshot(page);
  const stockBefore = await stockSnapshot(page, "ops-sku-c");
  await page.getByTestId("appsheet-preorder-open").click();
  const shell = page.getByTestId("appsheet-invoice-dialog");
  await expect(shell).toBeVisible();
  const invoiceDate = await field(shell, "invoiceDate").inputValue();
  await expect(field(shell, "invoiceDate")).toBeDisabled();
  await expect(field(shell, "memberId")).toHaveAttribute("required", "");
  await selectMember(shell, "ops-member", "Socio de ensayo", "Buscar nombre del asociado por nombre");

  const shellRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  const shellSavedPromise = saveResponse(page, "InvoiceSaved");
  await shell.getByTestId("appsheet-save-invoice").click();
  const shellSaved = await shellSavedPromise;
  const shellStatus = shellSaved.status();
  const shellText = shellStatus === 200 ? "" : await shellSaved.text();
  expect(shellStatus, shellText).toBe(200);
  const shellBody = await shellSaved.json();
  const shellSavedEnvelope = shellSaved.request().postDataJSON() as CommandEnvelope;
  const shellId = shellBody.targetId as string;
  expect(shellSavedEnvelope.command).toBe("InvoiceSaved");
  expect(shellSavedEnvelope.data.lines).toEqual([]);
  expect(shellBody.result).toMatchObject({
    orderId: shellId,
    commercialState: "preorder",
    deliveryId: null,
    reservations: null,
    quoteFrozen: false,
  });
  const shellOrders = await (await shellRefresh).json();
  expect(shellOrders.items.some((item: { id: string }) => item.id === shellId)).toBe(true);

  let preorderRow = page.locator("tbody tr").filter({ hasText: `Factura #${shellId.slice(0, 8).toUpperCase()}` });
  await expect(preorderRow).toHaveCount(1);
  const shellDetail = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(shellDetail.order).toMatchObject({ id: shellId, memberId: "ops-member", commercialState: "preorder" });
  expect(shellDetail.order.quote.input.lines).toEqual([]);
  expect(shellDetail.order.quote.lines).toEqual([]);
  expect(shellDetail.reservations).toHaveLength(0);
  expect(shellDetail.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  await preorderRow.getByRole("button", { name: "Formulario de venta", exact: true }).click();
  const initialEditor = page.getByTestId("appsheet-invoice-dialog");
  await expect(initialEditor).toBeVisible();
  await addProduct(page, initialEditor, {
    date: invoiceDate,
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3",
    total: "12.01",
  });
  await expect(initialEditor.locator(".appsheet-dialog-lines li")).toHaveCount(1);

  const initialUpdatePromise = saveResponse(page, "InvoiceUpdated");
  await initialEditor.getByTestId("appsheet-save-invoice").click();
  const initialUpdate = await initialUpdatePromise;
  const initialUpdateStatus = initialUpdate.status();
  const initialUpdateText = initialUpdateStatus === 200 ? "" : await initialUpdate.text();
  expect(initialUpdateStatus, initialUpdateText).toBe(200);
  const initialUpdateBody = await initialUpdate.json();
  const initialUpdateEnvelope = initialUpdate.request().postDataJSON() as CommandEnvelope;
  expect(initialUpdateEnvelope.command).toBe("InvoiceUpdated");
  expect(initialUpdateEnvelope.targetId).toBe(shellId);
  expect(initialUpdateEnvelope.data).toMatchObject({
    memberId: "ops-member",
    invoiceDate,
    preorder: true,
    lines: [{ skuId: "ops-sku-c", scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201" }],
  });
  expect(Object.hasOwn((initialUpdateEnvelope.data.lines as Array<Record<string, unknown>>)[0]!, "pricePerGramMinor")).toBe(false);
  expect(initialUpdateBody.result).toMatchObject({ orderId: shellId, commercialState: "preorder", quoteFrozen: false });
  await expect(initialEditor).toHaveCount(0);
  const persistedLineDetail = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(persistedLineDetail.order.quote.lines).toHaveLength(1);
  expect(Object.hasOwn(persistedLineDetail.order.quote.input.lines[0], "pricePerGramMinor")).toBe(false);
  expect(Object.hasOwn(persistedLineDetail.order.quote.lines[0], "pricePerGramMinor")).toBe(false);
  expect(persistedLineDetail.order.quote.lines[0]).toMatchObject({ date: invoiceDate, scale: "Precio_5_Gramos", requested: "3", explicitTotalMinor: "1201" });
  expect(persistedLineDetail.reservations).toHaveLength(0);
  expect(persistedLineDetail.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  await page.route("**/api/operations/orders", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = (body.items ?? []).map(item => {
      if (item.id !== shellId) return item;
      const quote = item.quote && typeof item.quote === "object" && !Array.isArray(item.quote)
        ? item.quote as Record<string, unknown>
        : {};
      const input = quote.input && typeof quote.input === "object" && !Array.isArray(quote.input)
        ? quote.input as Record<string, unknown>
        : {};
      const lines = Array.isArray(input.lines) ? input.lines.map((line, index) =>
        index === 0 && line && typeof line === "object" && !Array.isArray(line)
          ? { ...(line as Record<string, unknown>), pricePerGramMinor: "400" }
          : line,
      ) : [];
      return { ...item, quote: { ...quote, lines: Array.isArray(quote.lines) ? quote.lines.map((line, index) => index === 0 ? { ...(line as Record<string, unknown>), pricePerGramMinor: "400" } : line) : quote.lines, input: { ...input, lines } } };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });
  const historicalSnapshotRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  await page.getByRole("button", { name: "↻ Actualizar", exact: true }).evaluate(element => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await historicalSnapshotRefresh;
  preorderRow = page.locator("tbody tr").filter({ hasText: `Factura #${shellId.slice(0, 8).toUpperCase()}` });
  await preorderRow.getByRole("button", { name: "Formulario de venta", exact: true }).click();
  const editor = page.getByTestId("appsheet-invoice-dialog");
  await expect(editor).toBeVisible();
  const historicalLine = editor.locator(".appsheet-dialog-lines li");
  await expect(historicalLine).toHaveCount(1);
  await expect(historicalLine).toContainText("3 g");
  await expect(historicalLine.locator("[data-testid^='appsheet-edit-product-']")).toBeVisible();

  await expect(field(editor, "acceptance")).toHaveCount(0);
  await expect(editor.getByTestId("appsheet-save-invoice")).toBeEnabled();
  expect(await getJson(page, `orders/${encodeURIComponent(shellId)}`)).toMatchObject({
    order: { commercialState: "preorder" },
    reservations: [],
    deliveries: [],
  });
  const note = "Aclaración editada antes de confirmar.";
  await field(editor, "note").fill(note);
  await expect(editor.getByTestId("appsheet-save-invoice")).toBeEnabled();

  const refreshCatalog = async () => {
    const priorReads = catalogReads;
    const refreshed = page.waitForResponse(response =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/catalog" && catalogReads > priorReads,
    );
    await page.getByRole("button", { name: "↻ Actualizar", exact: true }).evaluate(element => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    });
    await refreshed;
  };

  skuCAvailability = "NO";
  await refreshCatalog();
  await expect(historicalLine).toHaveCount(1);
  await expect(historicalLine.locator("[data-testid^='appsheet-edit-product-']")).toBeVisible();
  await expect(historicalLine.locator("small[role='alert']")).toContainText("Variedad conservada desde la preventa original");
  await expect(historicalLine.locator("small[role='alert']")).toContainText("disponibilidad actual en el catálogo para confirmar");

  await editor.getByTestId("appsheet-save-invoice").click();
  await expect(editor.locator(".ops-inline-error[role='alert']")).toContainText("requiere disponibilidad actual en el catálogo para confirmar");
  expect(invoiceUpdatedPosts).toHaveLength(1);
  const afterBlockedConfirmation = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(afterBlockedConfirmation.order).toMatchObject({ commercialState: "preorder" });
  expect(afterBlockedConfirmation.order.quote.lines).toEqual(persistedLineDetail.order.quote.lines);
  expect(afterBlockedConfirmation.reservations).toHaveLength(0);
  expect(afterBlockedConfirmation.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);
  await expect(historicalLine).toHaveCount(1);
  await expect(historicalLine).toContainText("3 g");

  skuCAvailability = "Sí";
  await refreshCatalog();
  await expect(historicalLine.locator("small[role='alert']")).toHaveCount(0);
  await expect(field(editor, "acceptance")).toHaveCount(0);
  await expect(editor.getByTestId("appsheet-save-invoice")).toBeEnabled();

  const collisionOrderId = randomUUID();
  const collisionLineId = randomUUID();
  const savedEnvelope = shellSaved.request().postDataJSON() as CommandEnvelope;
  const savedLines = initialUpdateEnvelope.data.lines as Array<Record<string, unknown>>;
  const collisionEnvelope: CommandEnvelope = {
    ...savedEnvelope,
    requestId: randomUUID(),
    targetId: collisionOrderId,
    data: {
      ...savedEnvelope.data,
      lines: savedLines.map((line, index) => index === 0 ? { ...line, id: collisionLineId } : line),
    },
  };
  await postCommand(page, collisionEnvelope);
  const collisionBefore = await getJson(page, `orders/${encodeURIComponent(collisionOrderId)}`);
  expect(collisionBefore.order.quote.lines).toHaveLength(1);
  expect(collisionBefore.order.quote.lines[0].id).toBe(collisionLineId);

  let injectedCollision = false;
  let injectedCollisionEnvelope: CommandEnvelope | null = null;
  await page.route("**/api/operations/commands", async route => {
    if (!injectedCollision && isCommand(route.request(), "InvoiceUpdated")) {
      injectedCollision = true;
      const envelope = route.request().postDataJSON() as CommandEnvelope;
      const lines = envelope.data.lines as Array<Record<string, unknown>>;
      injectedCollisionEnvelope = {
        ...envelope,
        data: { ...envelope.data, lines: lines.map((line, index) => index === 0 ? { ...line, id: collisionLineId } : line) },
      };
      await route.continue({ postData: JSON.stringify(injectedCollisionEnvelope) });
      return;
    }
    await route.continue();
  });
  const rollbackPromise = saveResponse(page, "InvoiceUpdated");
  await editor.getByTestId("appsheet-save-invoice").click();
  const rolledBack = await rollbackPromise;
  expect(injectedCollision).toBe(true);
  expect(injectedCollisionEnvelope).not.toBeNull();
  expect(injectedCollisionEnvelope!.data.lines).toEqual(expect.arrayContaining([expect.objectContaining({ id: collisionLineId })]));
  expect(rolledBack.status()).toBeGreaterThanOrEqual(400);
  await expect(editor.getByRole("alert")).toContainText("Resultado del guardado pendiente");
  await expect(editor.getByTestId("appsheet-retry-invoice")).toBeEnabled();
  await expect(field(editor, "note")).toHaveValue(note);
  await expect(historicalLine).toHaveCount(1);
  const afterRolledBackUpdate = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(invoiceUpdatedPosts).toHaveLength(2);
  expect(afterRolledBackUpdate.order).toMatchObject({ commercialState: "preorder" });
  expect(afterRolledBackUpdate.order.quote.lines).toEqual(persistedLineDetail.order.quote.lines);
  expect(afterRolledBackUpdate.reservations).toHaveLength(0);
  expect(afterRolledBackUpdate.deliveries).toHaveLength(0);
  const collisionAfter = await getJson(page, `orders/${encodeURIComponent(collisionOrderId)}`);
  expect(collisionAfter.order.quote.lines).toEqual(collisionBefore.order.quote.lines);
  expect(collisionAfter.reservations).toHaveLength(0);
  expect(collisionAfter.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  const updateRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  const updatedPromise = saveResponse(page, "InvoiceUpdated");
  await editor.getByTestId("appsheet-retry-invoice").click();
  const updated = await updatedPromise;
  expect(invoiceUpdatedPosts).toHaveLength(3);
  const updatedStatus = updated.status();
  const updatedText = updatedStatus === 200 ? "" : await updated.text();
  expect(updatedStatus, updatedText).toBe(200);
  const updatedBody = await updated.json();
  const updatedEnvelope = updated.request().postDataJSON() as CommandEnvelope;
  expect(updatedEnvelope.command).toBe("InvoiceUpdated");
  expect(updatedEnvelope.targetId).toBe(shellId);
  expect(updatedEnvelope.data).toMatchObject({
    memberId: "ops-member",
    invoiceDate,
    preorder: true,
    lines: [{ skuId: "ops-sku-c", scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201", pricePerGramMinor: "400" }],
  });
  expect(Object.hasOwn(updatedEnvelope.data, "acceptance")).toBe(false);
  const updatedLines = updatedEnvelope.data.lines as Array<Record<string, unknown>>;
  expect(updatedLines[0]).toMatchObject({ totalMinor: "1201", pricePerGramMinor: "400" });
  expect(updatedLines[0]!.id).toBe(persistedLineDetail.order.quote.lines[0].id);
  expect(updatedLines[0]!.id).not.toBe(collisionLineId);
  expect(updatedBody.result).toMatchObject({ orderId: shellId, commercialState: "preorder", quoteFrozen: false });
  expect(invoiceConfirmedPosts).toHaveLength(0);

  const refreshedOrders = await (await updateRefresh).json();
  expect(refreshedOrders.items.filter((item: { id: string }) => item.id === shellId)).toHaveLength(1);
  await expect(editor).toHaveCount(0);
  const pending = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(pending.order).toMatchObject({ id: shellId, memberId: "ops-member", commercialState: "preorder", quoteFrozen: false });
  expect(pending.order.quote.lines).toHaveLength(1);
  expect(pending.order.quote.input.lines[0]).toMatchObject({ totalMinor: "1201", pricePerGramMinor: "400" });
  expect(pending.order.quote.lines[0]).toMatchObject({ date: invoiceDate, scale: "Precio_5_Gramos", requested: "3", explicitTotalMinor: "1201" });
  expect(Object.hasOwn(pending.order.quote.input.lines[0], "pricePerGramMinor")).toBe(true);
  expect(pending.order.quote.lines[0]).toMatchObject({ pricePerGramMinor: "400" });
  expect(pending.reservations).toHaveLength(0);
  expect(pending.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  preorderRow = page.locator("tbody tr").filter({ hasText: `Factura #${shellId.slice(0, 8).toUpperCase()}` });
  await preorderRow.getByRole("button", { name: "Confirmar preventa", exact: true }).click();
  const confirmationDialog = page.getByTestId("appsheet-invoice-dialog");
  await expect(confirmationDialog).toBeVisible();
  await expect(confirmationDialog.getByText("Nota de confirmación · opcional")).toBeVisible();
  await expect(field(confirmationDialog, "acceptance")).toHaveValue("");
  await expect(confirmationDialog.getByTestId("appsheet-confirm-preorder")).toBeEnabled();
  const confirmationPromise = saveResponse(page, "InvoiceConfirmed");
  await confirmationDialog.getByTestId("appsheet-confirm-preorder").click();
  const confirmedResponse = await confirmationPromise;
  const confirmationStatus = confirmedResponse.status();
  const confirmationText = confirmationStatus === 200 ? "" : await confirmedResponse.text();
  expect(confirmationStatus, confirmationText).toBe(200);
  const confirmationEnvelope = confirmedResponse.request().postDataJSON() as CommandEnvelope;
  expect(confirmationEnvelope.command).toBe("InvoiceConfirmed");
  expect(confirmationEnvelope.targetId).toBe(shellId);
  expect(confirmationEnvelope.data).toEqual({ acceptance: { method: "operator_confirmed_saved_preorder" } });
  expect(invoiceConfirmedPosts).toHaveLength(1);
  await expect(confirmationDialog).toHaveCount(0);
  const confirmed = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(confirmed.order).toMatchObject({ id: shellId, commercialState: "confirmed", quote: { acceptance: { method: "operator_confirmed_saved_preorder" } } });
  expect(confirmed.reservations).toHaveLength(1);
  expect(confirmed.reservations[0]).toMatchObject({ quantity: "3" });
  expect(confirmed.deliveries).toHaveLength(0);
  expect(await financeSnapshot(page)).toEqual(financeBefore);
});

function mockedCataloguePage(prefix: string, count: number, nextCursor: string | null) {
  const items = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const id = `${prefix}-${suffix}`;
    return {
      id,
      code: id,
      name: id,
      variety: `Variedad ${id}`,
      category: "Variedad sintética",
      unit: "g",
      active: true,
      appSheet: { availability: "Sí", segment: null, price5Grams: null },
    };
  });
  return {
    items,
    versions: Object.fromEntries(items.map(item => [item.id, 1])),
    hasMore: Boolean(nextCursor),
    nextCursor,
  };
}

test("a late catalog page cannot leak rows or its cursor into a newer search", async ({ page }) => {
  let releaseLateAPage!: () => void;
  const lateAPageGate = new Promise<void>(resolve => { releaseLateAPage = resolve; });
  let markLateAPageStarted!: () => void;
  const lateAPageStarted = new Promise<void>(resolve => { markLateAPageStarted = resolve; });
  let markLateAPageHandled!: () => void;
  const lateAPageHandled = new Promise<void>(resolve => { markLateAPageHandled = resolve; });
  let markBPageRequest!: (value: { query: string; cursor: string | null }) => void;
  const bPageRequest = new Promise<{ query: string; cursor: string | null }>(resolve => { markBPageRequest = resolve; });
  const commandPosts: string[] = [];
  const catalogueRequests: Array<{ query: string; cursor: string | null }> = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/operations/commands")) commandPosts.push(request.url());
  });

  await page.route("**/api/operations/catalogue-sheets**", async route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q") ?? "";
    const cursor = url.searchParams.get("cursor");
    catalogueRequests.push({ query, cursor });
    const reply = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (!query && !cursor) return reply(mockedCataloguePage("initial", 200, "initial-next"));
    if (query === "A" && !cursor) return reply(mockedCataloguePage("A-first", 200, "cursor-A-next"));
    if (query === "A" && cursor === "cursor-A-next") {
      markLateAPageStarted();
      await lateAPageGate;
      try {
        await reply(mockedCataloguePage("A-late", 1, "cursor-A-late-next"));
      } catch {
        // The updated query may abort this request; the late server response is still attempted.
      } finally {
        markLateAPageHandled();
      }
      return;
    }
    if (query === "B" && cursor) {
      markBPageRequest({ query, cursor });
      return reply(cursor === "cursor-B-next"
        ? mockedCataloguePage("B-late", 1, null)
        : mockedCataloguePage("unexpected-cursor", 0, null));
    }
    if (query === "B") return reply(mockedCataloguePage("B-first", 1, "cursor-B-next"));
    return reply(mockedCataloguePage("unexpected-query", 0, null));
  });

  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
  await page.getByRole("button", { name: "Catálogo y stock", exact: true }).click();

  const catalogue = page.getByRole("region", { name: "Fichas comerciales del catálogo", exact: true });
  const table = catalogue.getByRole("table", { name: "Fichas comerciales del catálogo", exact: true });
  const search = catalogue.getByRole("searchbox", { name: "Buscar producto", exact: true });
  await expect(search).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(201);

  await search.fill("A");
  await expect(table.getByText("A-first-001", { exact: true })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(201);
  await catalogue.getByRole("button", { name: "Cargar más productos", exact: true }).click();
  await lateAPageStarted;

  await search.fill("B");
  await expect(table.getByText("B-first-001", { exact: true })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(2);

  releaseLateAPage();
  await lateAPageHandled;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(table.getByText("A-late-001", { exact: true })).toHaveCount(0);
  const moreB = catalogue.getByRole("button", { name: "Cargar más productos", exact: true });
  await expect(moreB).toBeEnabled();
  await moreB.click();
  await expect(table.getByText("B-late-001", { exact: true })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByText("A-late-001", { exact: true })).toHaveCount(0);
  expect(await bPageRequest).toEqual({ query: "B", cursor: "cursor-B-next" });
  expect(catalogueRequests).toContainEqual({ query: "B", cursor: "cursor-B-next" });
  expect(commandPosts).toEqual([]);
});

test("an AppSheet source-lot invoice choice transports the explicit non-FIFO SKU and lot pair", async ({ page }) => {
  const selectedLotId = "source-lot-later-selected";
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, mode: "active", cutoverProfile: "appsheet-replacement" },
    } });
  });
  await page.route("**/api/operations/catalog**", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = (body.items ?? []).map(item => {
      if (item.id !== "ops-sku-c") return item;
      const appSheet = item.appSheet && typeof item.appSheet === "object" && !Array.isArray(item.appSheet)
        ? item.appSheet as Record<string, unknown>
        : {};
      return {
        ...item,
        appSheet: { ...appSheet, availability: "Sí" },
        requiresAppSheetSourceLot: true,
        appSheetSourceLots: [
          { sourceLotId: "source-lot-older-fifo", receivedDate: "2026-10-01", availableQuantity: "30" },
          { sourceLotId: selectedLotId, receivedDate: "2026-10-08", availableQuantity: "18",
            sourceLabelIdentity: { variety: "Variedad fuente", description: "Descripción capturada", purchaseLotId: "COMPRA-2026-77" } },
          { sourceLotId: "source-lot-unavailable", receivedDate: "2026-10-09", availableQuantity: "0" },
        ],
      };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });

  let savedEnvelope: CommandEnvelope | null = null;
  await page.route("**/api/operations/commands", async route => {
    if (isCommand(route.request(), "InvoiceSaved")) {
      savedEnvelope = route.request().postDataJSON() as CommandEnvelope;
      return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Rechazo sintético: la prueba verifica el transporte sin escribir." }) });
    }
    return route.continue();
  });

  await enterOrders(page);
  const invoice = await openInvoice(page);
  const invoiceDate = "2026-10-09";
  await field(invoice, "invoiceDate").fill(invoiceDate);
  await selectMember(invoice, "ops-member", "Socio de ensayo");
  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  const combinedChoice = field(product, "line-skuId");
  await expect(field(product, "line-sourceLotId")).toHaveCount(0);
  const selectedOption = combinedChoice.locator(`option[data-sku-id="ops-sku-c"][data-source-lot-id="${selectedLotId}"]`);
  await expect(selectedOption).toHaveCount(1);
  await expect(selectedOption).toHaveText("Variedad fuente |Descripción capturada - COMPRA-2026-77 (18 gr)");
  await expect(combinedChoice.locator('option[data-source-lot-id="source-lot-unavailable"]')).toHaveCount(0);
  const selectedOptionValue = await selectedOption.getAttribute("value");
  if (selectedOptionValue === null) throw new Error("La opción combinada de variedad y lote no tiene valor.");
  await combinedChoice.selectOption(selectedOptionValue);
  await expect(combinedChoice).toHaveValue(selectedOptionValue);
  await field(product, "line-date").fill(invoiceDate);
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-quantity").fill("3");
  await field(product, "line-total").fill("12.01");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);

  const saveResponsePromise = saveResponse(page, "InvoiceSaved");
  await invoice.getByTestId("appsheet-save-invoice").click();
  const response = await saveResponsePromise;
  expect(response.status()).toBe(422);
  await expect(invoice.getByRole("alert")).toContainText("Rechazo sintético");
  expect(savedEnvelope).not.toBeNull();
  expect(savedEnvelope!.command).toBe("InvoiceSaved");
  expect(savedEnvelope!.data.lines).toMatchObject([{ skuId: "ops-sku-c", sourceLotId: selectedLotId }]);
});

test("an empty AppSheet preorder shell saves as pending, rejects failed writes, and blocks an invalid snapshot", async ({ page }) => {
  let rejectNextUpdate = true;
  let rejectedUpdateEnvelope: CommandEnvelope | null = null;
  await page.route("**/api/operations/commands", async route => {
    const request = route.request();
    if (rejectNextUpdate && isCommand(request, "InvoiceUpdated")) {
      rejectNextUpdate = false;
      rejectedUpdateEnvelope = request.postDataJSON() as CommandEnvelope;
      return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Rechazo sintético para comprobar que la preventa no se escribe." }) });
    }
    return route.continue();
  });
  const invoiceUpdatedPosts: CommandEnvelope[] = [];
  const invoiceConfirmedPosts: Request[] = [];
  page.on("request", request => {
    if (isCommand(request, "InvoiceUpdated")) invoiceUpdatedPosts.push(request.postDataJSON() as CommandEnvelope);
    if (isCommand(request, "InvoiceConfirmed")) invoiceConfirmedPosts.push(request);
  });
  await enterOrders(page);
  const financeBefore = await financeSnapshot(page);
  const stockBefore = await stockSnapshot(page, "ops-sku-c");
  await page.getByTestId("appsheet-preorder-open").click();
  const shell = page.getByTestId("appsheet-invoice-dialog");
  await expect(shell).toBeVisible();
  const invoiceDate = await field(shell, "invoiceDate").inputValue();
  await expect(field(shell, "invoiceDate")).toBeDisabled();
  await expect(field(shell, "memberId")).toHaveAttribute("required", "");
  await selectMember(shell, "ops-member", "Socio de ensayo", "Buscar nombre del asociado por nombre");

  const shellRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  const shellSavedPromise = saveResponse(page, "InvoiceSaved");
  await shell.getByTestId("appsheet-save-invoice").click();
  const shellSaved = await shellSavedPromise;
  const shellStatus = shellSaved.status();
  const shellText = shellStatus === 200 ? "" : await shellSaved.text();
  expect(shellStatus, shellText).toBe(200);
  const shellBody = await shellSaved.json();
  const shellId = shellBody.targetId as string;
  expect(shellBody.result).toMatchObject({
    orderId: shellId,
    commercialState: "preorder",
    deliveryId: null,
    reservations: null,
    quoteFrozen: false,
  });
  const shellOrders = await (await shellRefresh).json();
  expect(shellOrders.items.some((item: { id: string }) => item.id === shellId)).toBe(true);

  let preorderRow = page.locator("tbody tr").filter({ hasText: `Factura #${shellId.slice(0, 8).toUpperCase()}` });
  await expect(preorderRow).toHaveCount(1);
  const shellDetail = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(shellDetail.order).toMatchObject({ id: shellId, memberId: "ops-member", commercialState: "preorder" });
  expect(shellDetail.order.quote.lines).toEqual([]);
  expect(shellDetail.reservations).toHaveLength(0);
  expect(shellDetail.deliveries).toHaveLength(0);

  await preorderRow.getByRole("button", { name: "Formulario de venta", exact: true }).click();
  const editor = page.getByTestId("appsheet-invoice-dialog");
  await expect(editor).toBeVisible();
  await addProduct(page, editor, {
    date: invoiceDate,
    skuId: "ops-sku-c",
    scale: "Precio_5_Gramos",
    quantity: "3",
    total: "12.01",
  });

  const productRow = editor.locator(".appsheet-dialog-lines li");
  await expect(productRow).toHaveCount(1);
  await productRow.getByRole("button", { name: "Editar producto", exact: true }).click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  const productChoice = field(product, "line-skuId");
  await expect(productChoice).toHaveValue("ops-sku-c");
  await expect(field(product, "line-sourceLotId")).toHaveCount(0);
  await product.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(product).toHaveCount(0);
  await expect(editor.getByTestId("appsheet-save-invoice")).toBeEnabled();
  await expect(field(editor, "acceptance")).toHaveCount(0);
  expect(await getJson(page, `orders/${encodeURIComponent(shellId)}`)).toMatchObject({
    order: { commercialState: "preorder" },
    reservations: [],
    deliveries: [],
  });
  const note = "Aclaración editada en la preventa pendiente.";
  await field(editor, "note").fill(note);
  await expect(editor.getByTestId("appsheet-save-invoice")).toBeEnabled();

  const rejectedPromise = saveResponse(page, "InvoiceUpdated");
  await editor.getByTestId("appsheet-save-invoice").click();
  const rejected = await rejectedPromise;
  expect(rejected.status()).toBe(422);
  expect(rejectedUpdateEnvelope).not.toBeNull();
  expect(rejectedUpdateEnvelope!.data).toMatchObject({ preorder: true, lines: [{ totalMinor: "1201" }] });
  expect(Object.hasOwn(rejectedUpdateEnvelope!.data, "acceptance")).toBe(false);
  await expect(editor.getByRole("alert")).toContainText("Rechazo sintético");
  await expect(field(editor, "note")).toHaveValue(note);
  await expect(productRow).toHaveCount(1);
  const afterRejectedUpdate = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(afterRejectedUpdate.order).toMatchObject({ commercialState: "preorder" });
  expect(afterRejectedUpdate.order.quote.lines).toEqual([]);
  expect(afterRejectedUpdate.reservations).toHaveLength(0);
  expect(afterRejectedUpdate.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  const updateRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  const updatedPromise = saveResponse(page, "InvoiceUpdated");
  await editor.getByTestId("appsheet-save-invoice").click();
  const updated = await updatedPromise;
  const updatedStatus = updated.status();
  const updatedText = updatedStatus === 200 ? "" : await updated.text();
  expect(updatedStatus, updatedText).toBe(200);
  const updatedBody = await updated.json();
  const updatedEnvelope = updated.request().postDataJSON() as CommandEnvelope;
  expect(updatedEnvelope.command).toBe("InvoiceUpdated");
  expect(updatedEnvelope.targetId).toBe(shellId);
  expect(updatedEnvelope.data).toMatchObject({
    memberId: "ops-member",
    invoiceDate,
    preorder: true,
    note,
    lines: [{ skuId: "ops-sku-c", scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201" }],
  });
  expect(Object.hasOwn(updatedEnvelope.data, "acceptance")).toBe(false);
  expect(invoiceUpdatedPosts).toHaveLength(2);
  expect(invoiceConfirmedPosts).toHaveLength(0);
  expect(updatedBody.result).toMatchObject({ orderId: shellId, commercialState: "preorder", quoteFrozen: false });

  const refreshedOrders = await (await updateRefresh).json();
  expect(refreshedOrders.items.filter((item: { id: string }) => item.id === shellId)).toHaveLength(1);
  await expect(editor).toHaveCount(0);
  const pending = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(pending.order).toMatchObject({ id: shellId, memberId: "ops-member", commercialState: "preorder", quoteFrozen: false, note });
  expect(pending.order.quote.lines).toHaveLength(1);
  expect(pending.order.quote.lines[0]).toMatchObject({ date: invoiceDate, scale: "Precio_5_Gramos", requested: "3", explicitTotalMinor: "1201" });
  expect(Object.hasOwn(pending.order.quote.input.lines[0], "sourceLotId")).toBe(false);
  expect(pending.reservations).toHaveLength(0);
  expect(pending.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);

  const malformedOrderId = randomUUID();
  const updatedLinesForMalformedOrder = updatedEnvelope.data.lines as Array<Record<string, unknown>>;
  const secondMalformedOrderLine = { ...updatedLinesForMalformedOrder[0]!, id: randomUUID() };
  await postCommand(page, {
    ...updatedEnvelope,
    requestId: randomUUID(),
    targetId: malformedOrderId,
    expectedVersion: 0,
    command: "InvoiceSaved",
    data: { ...updatedEnvelope.data, lines: [...updatedLinesForMalformedOrder, secondMalformedOrderLine] },
  });
  const malformedOrderBefore = await getJson(page, `orders/${encodeURIComponent(malformedOrderId)}`);
  expect(malformedOrderBefore.order.quote.input.lines).toHaveLength(2);
  expect(malformedOrderBefore.order.quote.lines).toHaveLength(2);

  let invalidSnapshotKind: "malformed-lines" | "invalid-currency" = "malformed-lines";
  await page.route("**/api/operations/orders", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = (body.items ?? []).map(item => {
      if (item.id !== malformedOrderId) return item;
      const quote = item.quote && typeof item.quote === "object" && !Array.isArray(item.quote)
        ? item.quote as Record<string, unknown>
        : {};
      const input = quote.input && typeof quote.input === "object" && !Array.isArray(quote.input)
        ? quote.input as Record<string, unknown>
        : {};
      const inputLines = Array.isArray(input.lines) ? input.lines : [];
      const invalidInput = invalidSnapshotKind === "malformed-lines"
        ? { ...input, lines: inputLines.map((line, index) => index === 1 ? null : line) }
        : { ...input, currency: "JPY" };
      return { ...item, quote: { ...quote, input: invalidInput } };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });
  const invalidSnapshotRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  await page.getByRole("button", { name: "↻ Actualizar", exact: true }).evaluate(element => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await invalidSnapshotRefresh;
  let invalidSnapshotRow = page.locator("tbody tr").filter({ hasText: `Factura #${malformedOrderId.slice(0, 8).toUpperCase()}` });
  await invalidSnapshotRow.getByRole("button", { name: "Formulario de venta", exact: true }).click();
  let invalidSnapshotDialog = page.getByTestId("appsheet-invoice-dialog");
  await expect(invalidSnapshotDialog.getByRole("alert")).toContainText("no conserva todos sus renglones e identidades válidos");
  await expect(invalidSnapshotDialog.getByTestId("appsheet-save-invoice")).toHaveCount(0);
  await expect(invalidSnapshotDialog.getByTestId("appsheet-add-product")).toHaveCount(0);
  expect(invoiceUpdatedPosts).toHaveLength(2);
  expect(invoiceConfirmedPosts).toHaveLength(0);
  const storedAfterMalformedSnapshot = await getJson(page, `orders/${encodeURIComponent(malformedOrderId)}`);
  expect(storedAfterMalformedSnapshot.order.quote.input.lines).toHaveLength(2);
  expect(storedAfterMalformedSnapshot.order.quote.lines).toHaveLength(2);
  expect(storedAfterMalformedSnapshot.order.commercialState).toBe("preorder");
  expect(storedAfterMalformedSnapshot.reservations).toHaveLength(0);
  expect(storedAfterMalformedSnapshot.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);
  await invalidSnapshotDialog.getByRole("button", { name: "Cerrar", exact: true }).click();

  invalidSnapshotKind = "invalid-currency";
  const currencySnapshotRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/orders",
  );
  await page.getByRole("button", { name: "↻ Actualizar", exact: true }).evaluate(element => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await currencySnapshotRefresh;
  invalidSnapshotRow = page.locator("tbody tr").filter({ hasText: `Factura #${malformedOrderId.slice(0, 8).toUpperCase()}` });
  await invalidSnapshotRow.getByRole("button", { name: "Formulario de venta", exact: true }).click();
  invalidSnapshotDialog = page.getByTestId("appsheet-invoice-dialog");
  await expect(invalidSnapshotDialog.getByRole("alert")).toContainText("moneda admitida (ARS o USD)");
  await expect(invalidSnapshotDialog.getByTestId("appsheet-save-invoice")).toHaveCount(0);
  await expect(invalidSnapshotDialog.getByTestId("appsheet-add-product")).toHaveCount(0);
  expect(invoiceUpdatedPosts).toHaveLength(2);
  expect(invoiceConfirmedPosts).toHaveLength(0);
  const storedAfterInvalidSnapshot = await getJson(page, `orders/${encodeURIComponent(malformedOrderId)}`);
  expect(storedAfterInvalidSnapshot.order.quote.input).toMatchObject({ currency: "ARS", preorder: true });
  expect(storedAfterInvalidSnapshot.order.commercialState).toBe("preorder");
  expect(storedAfterInvalidSnapshot.order.quote.input.lines).toHaveLength(2);
  expect(storedAfterInvalidSnapshot.order.quote.lines).toHaveLength(2);
  expect(storedAfterInvalidSnapshot.reservations).toHaveLength(0);
  expect(storedAfterInvalidSnapshot.deliveries).toHaveLength(0);
  expect(await stockSnapshot(page, "ops-sku-c")).toEqual(stockBefore);
  expect(await financeSnapshot(page)).toEqual(financeBefore);
});

test("an invoice line keeps its optional price-per-gram separate through draft editing and save", async ({ page }) => {
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json() as { authority?: Record<string, unknown> };
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, cutoverProfile: "appsheet-replacement" },
    } });
  });
  await page.route("**/api/operations/catalog**", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = (body.items ?? []).map(item => {
      if (item.id !== "ops-sku-a" && item.id !== "ops-sku-c" && item.id !== "ops-sku-b") return item;
      const appSheet = item.appSheet && typeof item.appSheet === "object" && !Array.isArray(item.appSheet)
        ? item.appSheet as Record<string, unknown>
        : {};
      return {
        ...item,
        appSheet: {
          ...appSheet,
          availability: "Sí",
          price5Grams: item.id === "ops-sku-a"
            ? { amountMinor: "1200", currency: "ARS" }
            : item.id === "ops-sku-c"
              ? { amountMinor: "1200", currency: "USD" }
              : { amountMinor: "720" },
        },
      };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });

  await enterOrders(page);
  const invoice = await openInvoice(page);
  const invoiceDate = await field(invoice, "invoiceDate").inputValue();
  await selectMember(invoice, "ops-member", "Socio de ensayo");

  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await field(product, "line-date").fill(invoiceDate);
  await field(product, "line-skuId").selectOption("ops-sku-a");
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-quantity").fill("3");
  const priceDetails = product.getByTestId("appsheet-line-price-details");
  await expect(priceDetails).toHaveJSProperty("open", false);
  await priceDetails.locator("summary").click();
  const priceField = field(product, "line-pricePerGram");
  await expect(priceField).toHaveValue("12");
  await priceField.fill("9.85");
  await field(product, "line-total").fill("12.01");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);

  const lineRows = invoice.locator(".appsheet-dialog-lines li");
  await expect(lineRows).toHaveCount(1);
  await lineRows.nth(0).locator("[data-testid^='appsheet-edit-product-']").click();
  const reopenedProduct = page.getByTestId("appsheet-product-dialog");
  await expect(reopenedProduct).toBeVisible();
  const reopenedPriceDetails = reopenedProduct.getByTestId("appsheet-line-price-details");
  await expect(reopenedPriceDetails).toHaveJSProperty("open", false);
  await reopenedPriceDetails.locator("summary").click();
  await expect(field(reopenedProduct, "line-pricePerGram")).toHaveValue("9.85");
  await expect(field(reopenedProduct, "line-total")).toHaveValue("12.01");
  await field(reopenedProduct, "line-date").fill("2026-10-06");
  await expect(field(reopenedProduct, "line-pricePerGram")).toHaveValue("9.85");
  await expect(field(reopenedProduct, "line-total")).toHaveValue("12.01");
  await reopenedProduct.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(reopenedProduct).toHaveCount(0);

  await invoice.getByTestId("appsheet-add-product").click();
  const productWithCurrencyMismatch = page.getByTestId("appsheet-product-dialog");
  await expect(productWithCurrencyMismatch).toBeVisible();
  await field(productWithCurrencyMismatch, "line-date").fill(invoiceDate);
  await field(productWithCurrencyMismatch, "line-skuId").selectOption("ops-sku-c");
  await field(productWithCurrencyMismatch, "line-scale").selectOption("Precio_5_Gramos");
  await field(productWithCurrencyMismatch, "line-quantity").fill("1");
  const mismatchDetails = productWithCurrencyMismatch.getByTestId("appsheet-line-price-details");
  await expect(mismatchDetails).toHaveJSProperty("open", false);
  await mismatchDetails.locator("summary").click();
  await expect(field(productWithCurrencyMismatch, "line-pricePerGram")).toHaveValue("");
  await field(productWithCurrencyMismatch, "line-total").fill("7.20");
  await productWithCurrencyMismatch.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(productWithCurrencyMismatch).toHaveCount(0);

  await invoice.getByTestId("appsheet-add-product").click();
  const productWithoutSourceCurrency = page.getByTestId("appsheet-product-dialog");
  await expect(productWithoutSourceCurrency).toBeVisible();
  await field(productWithoutSourceCurrency, "line-date").fill(invoiceDate);
  await field(productWithoutSourceCurrency, "line-skuId").selectOption("ops-sku-b");
  await field(productWithoutSourceCurrency, "line-scale").selectOption("Precio_5_Gramos");
  await field(productWithoutSourceCurrency, "line-quantity").fill("1");
  const missingCurrencyDetails = productWithoutSourceCurrency.getByTestId("appsheet-line-price-details");
  await expect(missingCurrencyDetails).toHaveJSProperty("open", false);
  await missingCurrencyDetails.locator("summary").click();
  await expect(field(productWithoutSourceCurrency, "line-pricePerGram")).toHaveValue("");
  await field(productWithoutSourceCurrency, "line-total").fill("5.00");
  await productWithoutSourceCurrency.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(productWithoutSourceCurrency).toHaveCount(0);

  const savedPromise = saveResponse(page, "InvoiceSaved");
  await invoice.getByTestId("appsheet-save-invoice").click();
  const saved = await savedPromise;
  expect(saved.status()).toBe(200);
  const savedBody = await saved.json();
  const savedEnvelope = saved.request().postDataJSON() as CommandEnvelope;
  expect(savedEnvelope.data).toMatchObject({
    currency: "ARS",
    preorder: false,
    lines: [
      { skuId: "ops-sku-a", date: "2026-10-06", scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201", pricePerGramMinor: "985" },
      { skuId: "ops-sku-c", scale: "Precio_5_Gramos", quantity: "1", totalMinor: "720" },
      { skuId: "ops-sku-b", scale: "Precio_5_Gramos", quantity: "1", totalMinor: "500" },
    ],
  });
  const orderId = savedBody.targetId as string;
  const detail = await getJson(page, `orders/${encodeURIComponent(orderId)}`);
  expect(detail.order.quote.input.lines[0]).toMatchObject({ totalMinor: "1201", pricePerGramMinor: "985" });
  expect(detail.order.quote.lines[0]).toMatchObject({ date: "2026-10-06", requested: "3", explicitTotalMinor: "1201", pricePerGramMinor: "985" });
  for (const [index, totalMinor] of [[1, "720"], [2, "500"]] as const) {
    expect(detail.order.quote.input.lines[index]).toMatchObject({ totalMinor });
    expect(Object.hasOwn(detail.order.quote.input.lines[index], "pricePerGramMinor")).toBe(false);
    expect(Object.hasOwn(detail.order.quote.lines[index], "pricePerGramMinor")).toBe(false);
  }
  expect(detail.order.lines[0].revenueMinor).toBe("1201");
});
