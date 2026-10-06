import type { Page, Request } from "@playwright/test";
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
  await expect(page.locator(".ops-home-page")).toBeVisible();
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
  await field(product, "line-skuId").selectOption(values.skuId);
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
}) {
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

test("invoice preserves editable line totals and separate product and moto terms after a lost acknowledgement", async ({ page }) => {
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
  await addMoto(page, invoice, moto);

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

test("an empty AppSheet preorder shell can be completed and reserved through one InvoiceUpdated save", async ({ page }) => {
  await enterOrders(page);
  const financeBefore = await financeSnapshot(page);
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
    preorder: false,
    lines: [{ skuId: "ops-sku-c", scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201" }],
  });
  expect(updatedBody.result).toMatchObject({ orderId: shellId, commercialState: "confirmed", quoteFrozen: true });

  const refreshedOrders = await (await updateRefresh).json();
  expect(refreshedOrders.items.filter((item: { id: string }) => item.id === shellId)).toHaveLength(1);
  await expect(editor).toHaveCount(0);
  const confirmed = await getJson(page, `orders/${encodeURIComponent(shellId)}`);
  expect(confirmed.order).toMatchObject({ id: shellId, memberId: "ops-member", commercialState: "confirmed", totalMinor: null, capturedBaseMinor: "1201" });
  expect(confirmed.order.quote.lines).toHaveLength(1);
  expect(confirmed.order.quote.lines[0]).toMatchObject({ date: invoiceDate, scale: "Precio_5_Gramos", requested: "3", explicitTotalMinor: "1201" });
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
