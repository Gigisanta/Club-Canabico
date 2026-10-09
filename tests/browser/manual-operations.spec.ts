import type { Page, Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expect, getIsolatedE2EPassword, test } from "./isolated";

type StockBalance = {
  id: string;
  quantity: string;
  reserved: string;
  locationId: string;
  custodianId: string;
};
type StockLot = { id: string; label: string; balances: StockBalance[] };
type StockSku = { id: string; active: boolean; lots: StockLot[] };
type StockCatalog = { items: StockSku[] };
type PurchaseLine = { lineId: string; skuId: string; unit: string; quantity: string; unitCost: string };
type PurchaseOrder = { id: string; status: string; items: PurchaseLine[] };
type PurchaseList = {
  items: PurchaseOrder[];
  receipts: Array<{ id: string; purchaseId: string; items: Array<{ lineId: string; quantity: string }> }>;
  versions: Record<string, number>;
};
type InventoryBalance = {
  lotId: string;
  lotLabel: string;
  skuId: string;
  locationId: string;
  custodianId: string;
  unit: string;
  balanceQuantity: string;
  reservedQuantity: string;
  availableQuantity: string;
};
type InventoryReport = {
  summary: { metrics: { current: { availableBalancesByLotLocationCustodian: InventoryBalance[] } } };
};
type OrderDetail = {
  order: {
    id: string;
    channel: string;
    commercialState: string;
    fulfillmentState: string;
    lines: Array<{ id: string; skuId: string; skuName: string | null; unit: string; requested: string; prepared: string; delivered: string }>;
  };
  reservations: Array<{
    lineId: string;
    balanceId: string;
    quantity: string;
    consumed: string;
    balance: { id: string; lotId: string; skuId: string; skuName: string; unit: string; lotLabel: string } | null;
  }>;
  allocations: Array<{
    lineId: string;
    lotId: string;
    balanceId: string;
    requestedQuantity: string;
    actualQuantity: string;
    deliveredQuantity: string;
    state: string;
  }>;
  version: number;
};
type CommandEnvelope = {
  command: string;
  targetId: string;
  expectedVersion: number;
  data: Record<string, unknown>;
};
type CatalogSkuFields = {
  id: string;
  code: string;
  name: string;
  variety: string;
  category: string;
  unit: string;
  minQuantity: string;
  minVarieties: number;
};
type CatalogSku = CatalogSkuFields & { active: boolean; lots: StockLot[] };

function catalogSkuSnapshot(sku: CatalogSku) {
  return {
    ...sku,
    lots: sku.lots
      .map(lot => ({ ...lot, balances: [...lot.balances].sort((left, right) => left.id.localeCompare(right.id)) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function gramsInMilliunits(value: unknown): bigint {
  expect(typeof value).toBe("string");
  const decimal = value as string;
  expect(decimal).toMatch(/^\d+(?:\.\d+)?$/);
  const [whole, fraction = ""] = decimal.split(".");
  expect(fraction.slice(3), `gram quantity ${decimal} has no nonzero precision below 0.001`).toMatch(/^0*$/);
  return BigInt(whole!) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, "0"));
}

function expectGrams(actual: unknown, expected: string) {
  expect(gramsInMilliunits(actual)).toBe(gramsInMilliunits(expected));
}

async function login(page: Page) {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
}

async function getOperation<T>(client: Pick<Page, "request">, path: string): Promise<T> {
  const response = await client.request.get(`/api/operations/${path}`);
  expect(response.status(), `GET /api/operations/${path}`).toBe(200);
  return response.json() as Promise<T>;
}

async function getInventoryReport(client: Pick<Page, "request">): Promise<InventoryReport> {
  const response = await client.request.get("/api/reports/operations/metrics/inventory");
  expect(response.status(), "GET /api/reports/operations/metrics/inventory").toBe(200);
  return response.json() as Promise<InventoryReport>;
}

function inventoryReportSnapshot(report: InventoryReport) {
  return report.summary.metrics.current.availableBalancesByLotLocationCustodian
    .map(balance => ({ ...balance }))
    .sort((left, right) => [left.skuId, left.lotId, left.locationId, left.custodianId].join("/")
      .localeCompare([right.skuId, right.lotId, right.locationId, right.custodianId].join("/")));
}

function watchCommandPosts(page: Page) {
  const envelopes: CommandEnvelope[] = [];
  const onRequest = (request: Request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/operations/commands")) return;
    envelopes.push(request.postDataJSON() as CommandEnvelope);
  };
  page.on("request", onRequest);
  return {
    envelopes,
    stop: () => page.off("request", onRequest),
  };
}

function commandEnvelope(command: string, targetId: string, expectedVersion: number, data: Record<string, unknown>) {
  return { schemaVersion: 1, requestId: randomUUID(), targetId, expectedVersion, occurredAt: new Date().toISOString(), command, data };
}

async function restoreActiveSku(page: Page, sku: CatalogSkuFields, evidenceReference: string) {
  const before = await getOperation<{
    items: Array<{ id: string; active: boolean }>;
    versions: Record<string, number>;
  }>(page, "catalogue-sheets");
  const currentSku = before.items.find(item => item.id === sku.id);
  expect(currentSku, `SKU ${sku.id} still exists during cleanup`).toBeDefined();
  const currentVersion = before.versions[sku.id];
  expect(Number.isInteger(currentVersion), `version for SKU ${sku.id} is available during cleanup`).toBe(true);

  if (!currentSku!.active) {
    const origin = new URL(page.url()).origin;
    const response = await page.request.post("/api/operations/commands", {
      headers: { Origin: origin },
      data: commandEnvelope("CatalogSkuUpdated", sku.id, currentVersion, {
        code: sku.code,
        name: sku.name,
        variety: sku.variety,
        category: sku.category,
        unit: sku.unit,
        minQuantity: sku.minQuantity,
        minVarieties: sku.minVarieties,
        active: true,
        evidence: { reference: evidenceReference, scope: "synthetic rehearsal fixture cleanup" },
      }),
    });
    const body = await response.json();
    expect(response.status(), `CatalogSkuUpdated restore: ${JSON.stringify(body)}`).toBe(200);
    expect(body.version).toBe(currentVersion + 1);
    expect(body.result.sku).toMatchObject({ id: sku.id, active: true });
  }

  const after = await getOperation<{
    items: Array<{ id: string; active: boolean }>;
    versions: Record<string, number>;
  }>(page, "catalogue-sheets");
  expect(after.items.find(item => item.id === sku.id)).toMatchObject({ id: sku.id, active: true });
  expect(after.versions[sku.id]).toBe(currentVersion + (currentSku!.active ? 0 : 1));
}

async function submitCommand(page: Page, command: string, submitLabel: string) {
  const responsePromise = page.waitForResponse(response => {
    if (!response.url().endsWith("/api/operations/commands") || response.request().method() !== "POST") return false;
    try {
      return response.request().postDataJSON().command === command;
    } catch {
      return false;
    }
  });
  await page.getByRole("dialog").getByRole("button", { name: submitLabel, exact: true }).click();
  const response = await responsePromise;
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return { envelope: response.request().postDataJSON() as CommandEnvelope, body };
}

function inventorySnapshot(catalog: StockCatalog) {
  return {
    skuIds: catalog.items.map(sku => sku.id).sort(),
    balances: catalog.items.flatMap(sku => sku.lots.flatMap(lot => lot.balances.map(balance => ({
      skuId: sku.id,
      lotId: lot.id,
      balanceId: balance.id,
      quantity: balance.quantity,
      reserved: balance.reserved,
      locationId: balance.locationId,
      custodianId: balance.custodianId,
    })))).sort((left, right) => left.balanceId.localeCompare(right.balanceId)),
  };
}

async function openCatalog(page: Page) {
  await page.getByRole("button", { name: "Catálogo y stock", exact: true }).click();
  return page.getByRole("region", { name: "Administración manual de catálogo y stock" });
}

// This browser owner proves the canonical UI command and its persisted API result.
// The rehearsal runner and seed are synthetic; this does not claim production acceptance.
test("manual stock opening uses a named second preparer and persists the selected references", async ({ page }) => {
  await login(page);
  const context = await getOperation<{ userId: string; rehearsal: boolean; authority: { mode: string } }>(page, "context");
  expect(context.rehearsal).toBe(true);
  expect(context.authority.mode).toBe("shadow");
  expect(context.userId).not.toBe("ops-stock");

  const catalogBefore = await getOperation<StockCatalog>(page, "catalog");
  const fixtureSku = catalogBefore.items.find(sku => sku.id === "ops-sku-a");
  expect(fixtureSku?.active).toBe(true);
  const references = await getOperation<{ locations: Array<{ id: string }>; custodians: Array<{ id: string }> }>(page, "stock/reference-data");
  expect(references.locations.some(location => location.id === "ops-warehouse")).toBe(true);
  expect(references.custodians.some(custodian => custodian.id === context.userId)).toBe(true);
  const preparers = await getOperation<{ items: Array<{ id: string; name: string; active: boolean }> }>(page, "manual-reference-data/preparers");
  expect(preparers.items).toContainEqual({ id: "ops-stock", name: "Preparación de ensayo" });

  const region = await openCatalog(page);
  const openingButton = page.getByRole("button", { name: "Registrar apertura de stock", exact: true });
  await expect(openingButton).toBeVisible();
  const commandPosts = watchCommandPosts(page);
  const lotLabel = `E2E apertura ${randomUUID().slice(0, 8)}`;

  await openingButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Registrar apertura de stock" })).toBeVisible();
  await dialog.getByLabel("Producto activo").selectOption("ops-sku-a");
  await dialog.getByLabel("Etiqueta del lote").fill(lotLabel);
  await dialog.getByLabel("Cantidad inicial").fill("8.25");
  await dialog.getByLabel("Costo unitario conocido").fill("2000");
  await dialog.getByLabel("Moneda del costo").selectOption("ARS");
  await dialog.getByLabel("Ubicación visible").selectOption("ops-warehouse");
  await dialog.getByLabel("Persona que preparó el relevamiento (distinta de quien aprueba)").selectOption("ops-stock");
  await dialog.getByLabel("Motivo o evidencia del cambio").fill("Apertura sintética desde el formulario manual.");
  const accepted = await submitCommand(page, "StockOpeningRecorded", "Registrar y aprobar apertura");
  commandPosts.stop();

  expect(accepted.envelope.command).toBe("StockOpeningRecorded");
  expect(accepted.envelope.data).toMatchObject({
    skuId: "ops-sku-a",
    label: lotLabel,
    quantity: "8.25",
    unitCost: "2000",
    costCurrency: "ARS",
    locationId: "ops-warehouse",
    preparedBy: "ops-stock",
  });
  const opening = accepted.body.result.opening as { preparedBy: string; approvedBy: string };
  expect(opening.preparedBy).toBe("ops-stock");
  expect(opening.approvedBy).toBe(context.userId);
  expect(opening.preparedBy).not.toBe(opening.approvedBy);
  expect(accepted.body.result.balance.custodianId).toBe(context.userId);

  const catalogAfter = await getOperation<StockCatalog>(page, "catalog");
  const persistedSku = catalogAfter.items.find(sku => sku.id === "ops-sku-a");
  const persistedLot = persistedSku?.lots.find(lot => lot.id === accepted.envelope.targetId);
  expect(persistedLot).toBeDefined();
  expect(persistedLot?.balances).toContainEqual(expect.objectContaining({
    quantity: "8.25",
    locationId: "ops-warehouse",
    custodianId: context.userId,
  }));
  expect(commandPosts.envelopes.filter(envelope => envelope.command === "StockOpeningRecorded")).toHaveLength(1);
  await expect(region).toBeVisible();
});

test("an empty visible-location list keeps manual stock opening unavailable without writes", async ({ page }) => {
  await login(page);
  const before = inventorySnapshot(await getOperation<StockCatalog>(page, "catalog"));
  const commandPosts = watchCommandPosts(page);
  // Preserve each real endpoint's response shape; only remove its locations collection.
  const emptyLocations = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, locations: [] } });
  };
  await page.route("**/api/operations/manual-reference-data", emptyLocations);
  await page.route("**/api/operations/stock/reference-data", emptyLocations);

  const region = await openCatalog(page);
  await expect(region).toContainText("Sin ubicaciones activas visibles");
  await expect(page.getByRole("button", { name: "Registrar apertura de stock", exact: true })).toHaveCount(0);
  expect(commandPosts.envelopes).toHaveLength(0);
  expect(inventorySnapshot(await getOperation<StockCatalog>(page, "catalog"))).toEqual(before);
  commandPosts.stop();
});

test("a failed preparer-list response keeps manual stock opening unavailable without writes", async ({ page }) => {
  await login(page);
  const before = inventorySnapshot(await getOperation<StockCatalog>(page, "catalog"));
  const commandPosts = watchCommandPosts(page);
  // The 500 payload matches the server's `{ error: string }` failure contract.
  await page.route("**/api/operations/manual-reference-data/preparers", route => route.fulfill({
    status: 500,
    contentType: "application/json",
    json: { error: "No se pudo completar la operación. Reintentá." },
  }));

  const region = await openCatalog(page);
  await expect(region).toContainText("No se pudieron cargar personas preparadoras");
  await expect(page.getByRole("button", { name: "Registrar apertura de stock", exact: true })).toHaveCount(0);
  expect(commandPosts.envelopes).toHaveLength(0);
  expect(inventorySnapshot(await getOperation<StockCatalog>(page, "catalog"))).toEqual(before);
  commandPosts.stop();
});

test("a catalog failure blocks receiving only the pending line after another SKU is fully received and deactivated", async ({ page, browser }) => {
  await login(page);
  const ownerContext = await getOperation<{ userId: string; rehearsal: boolean; authority: { mode: string } }>(page, "context");
  expect(ownerContext.rehearsal).toBe(true);
  expect(ownerContext.authority.mode).toBe("shadow");
  expect(ownerContext.userId).not.toBe("ops-stock");

  const catalogBefore = await getOperation<{
    items: Array<{ id: string; code: string; name: string; variety: string; category: string; unit: string; active: boolean; minQuantity: string; minVarieties: number }>;
    versions: Record<string, number>;
  }>(page, "catalog");
  const skuA = catalogBefore.items.find(sku => sku.id === "ops-sku-a");
  const skuB = catalogBefore.items.find(sku => sku.id === "ops-sku-b");
  expect(skuA?.active).toBe(true);
  expect(skuB?.active).toBe(true);
  expect(skuA).toBeDefined();
  expect(skuB).toBeDefined();

  // Create the disposable pending fixture through the canonical command API.
  // The stock account is a real seeded actor with purchases.write; its cookie
  // stays in a separate context so the owner UI remains independently approved.
  const appOrigin = new URL(page.url()).origin;
  const stockContext = await browser.newContext({ baseURL: appOrigin, extraHTTPHeaders: { Origin: appOrigin } });
  let purchaseId = "";
  let purchaseLineA = "";
  let purchaseLineB = "";
  let skuADeactivationAttempted = false;
  try {
    const stockLogin = await stockContext.request.post("/api/auth/login", {
      data: { email: "ops-stock@demo.bombo.local", password: getIsolatedE2EPassword() },
    });
    expect(stockLogin.status()).toBe(200);
    const stockActor = await getOperation<{ userId: string; capabilities: string[] }>(stockContext, "context");
    expect(stockActor.userId).toBe("ops-stock");
    expect(stockActor.capabilities).toContain("purchases.write");
    expect(stockActor.capabilities).toContain("stock.receive");
    const stockReferences = await getOperation<{ locations: Array<{ id: string }> }>(stockContext, "stock/reference-data");
    expect(stockReferences.locations.some(location => location.id === "ops-warehouse")).toBe(true);

    purchaseId = randomUUID();
    purchaseLineA = randomUUID();
    purchaseLineB = randomUUID();
    const agreementDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const createdResponse = await stockContext.request.post("/api/operations/commands", {
      data: commandEnvelope("PurchaseOrderCreated", purchaseId, 0, {
        supplierId: "ops-supplier",
        agreementDate,
        currency: "ARS",
        items: [
          { lineId: purchaseLineA, skuId: skuA!.id, unit: skuA!.unit, quantity: "13", unitCost: "1200" },
          { lineId: purchaseLineB, skuId: skuB!.id, unit: skuB!.unit, quantity: "17", unitCost: "1300" },
        ],
        evidence: { reference: "e2e-two-line-pending-purchase", scope: "synthetic rehearsal fixture" },
      }),
    });
    const createdBody = await createdResponse.json();
    expect(createdResponse.status(), JSON.stringify(createdBody)).toBe(200);
    expect(createdBody.result.purchaseOrder).toMatchObject({ id: purchaseId, status: "draft" });

    const approvedResponse = await page.request.post("/api/operations/commands", {
      headers: { Origin: appOrigin },
      data: commandEnvelope("PurchaseOrderApproved", purchaseId, createdBody.version, {
        evidence: { reference: "e2e-independent-approval", scope: "synthetic rehearsal fixture" },
      }),
    });
    const approvedBody = await approvedResponse.json();
    expect(approvedResponse.status(), JSON.stringify(approvedBody)).toBe(200);
    expect(approvedBody.result.purchaseOrder).toMatchObject({ id: purchaseId, status: "approved" });

    const approvedBeforeReceipt = await getOperation<PurchaseList>(page, "purchases");
    expect(approvedBeforeReceipt.items.find(purchase => purchase.id === purchaseId)).toMatchObject({
      id: purchaseId,
      status: "approved",
      items: [
        expect.objectContaining({ lineId: purchaseLineA, skuId: skuA!.id, unit: skuA!.unit, quantity: "13.000" }),
        expect.objectContaining({ lineId: purchaseLineB, skuId: skuB!.id, unit: skuB!.unit, quantity: "17.000" }),
      ],
    });
    expect(approvedBeforeReceipt.receipts.filter(receipt => receipt.purchaseId === purchaseId)).toHaveLength(0);

    // Receive the first SKU canonically, leaving only the second SKU pending.
    const receiptId = randomUUID();
    const receivedDate = agreementDate;
    const receiptResponse = await stockContext.request.post("/api/operations/commands", {
      data: commandEnvelope("GoodsReceived", receiptId, 0, {
        purchaseId,
        receivedDate,
        locationId: "ops-warehouse",
        items: [{ lineId: purchaseLineA, quantity: "13", lotLabel: `E2E recibido A ${randomUUID().slice(0, 8)}` }],
        evidence: { reference: "e2e-complete-line-a", scope: "synthetic rehearsal fixture" },
      }),
    });
    const receiptBody = await receiptResponse.json();
    expect(receiptResponse.status(), JSON.stringify(receiptBody)).toBe(200);
    expect(receiptBody.result.receipt).toMatchObject({ id: receiptId, purchaseId });
    expect(receiptBody.result.lots).toContainEqual(expect.objectContaining({ lineId: purchaseLineA, quantity: "13.000" }));
    expect(receiptBody.result.purchaseOrder).toMatchObject({ id: purchaseId, status: "partially_received" });

    const afterReceipt = await getOperation<PurchaseList>(page, "purchases");
    expect(afterReceipt.items.find(purchase => purchase.id === purchaseId)).toMatchObject({ id: purchaseId, status: "partially_received" });
    const receivedPurchaseLines = afterReceipt.receipts.filter(receipt => receipt.purchaseId === purchaseId);
    expect(receivedPurchaseLines).toHaveLength(1);
    expect(receivedPurchaseLines[0]?.items).toContainEqual(expect.objectContaining({ lineId: purchaseLineA, quantity: "13.000" }));
    expect(receivedPurchaseLines[0]?.items).not.toContainEqual(expect.objectContaining({ lineId: purchaseLineB }));

    // Deactivate the now-fully-received SKU; the remaining active SKU must stay receivable.
    const catalogAfterReceipt = await getOperation<{
      items: Array<{ id: string; code: string; name: string; variety: string; category: string; unit: string; active: boolean; minQuantity: string; minVarieties: number }>;
      versions: Record<string, number>;
    }>(page, "catalog");
    const currentSkuA = catalogAfterReceipt.items.find(sku => sku.id === skuA!.id);
    expect(currentSkuA?.active).toBe(true);
    expect(currentSkuA).toBeDefined();
    skuADeactivationAttempted = true;
    const deactivateResponse = await page.request.post("/api/operations/commands", {
      headers: { Origin: appOrigin },
      data: commandEnvelope("CatalogSkuUpdated", skuA!.id, catalogAfterReceipt.versions[skuA!.id], {
        code: currentSkuA!.code,
        name: currentSkuA!.name,
        variety: currentSkuA!.variety,
        category: currentSkuA!.category,
        unit: currentSkuA!.unit,
        minQuantity: currentSkuA!.minQuantity,
        minVarieties: currentSkuA!.minVarieties,
        active: false,
        evidence: { reference: "e2e-deactivate-fully-received-line", scope: "synthetic rehearsal fixture" },
      }),
    });
    const deactivateBody = await deactivateResponse.json();
    expect(deactivateResponse.status(), JSON.stringify(deactivateBody)).toBe(200);
    expect(deactivateBody.result.sku).toMatchObject({ id: skuA!.id, active: false });
    const catalogAfterDeactivation = await getOperation<StockCatalog>(page, "catalog");
    expect(catalogAfterDeactivation.items.some(sku => sku.id === skuA!.id)).toBe(false);
    expect(catalogAfterDeactivation.items.some(sku => sku.id === skuB!.id)).toBe(true);

    const pendingBeforeFailure = await getOperation<PurchaseList>(page, "purchases");
    const purchaseBeforeFailure = pendingBeforeFailure.items.find(purchase => purchase.id === purchaseId);
    expect(purchaseBeforeFailure).toMatchObject({ id: purchaseId, status: "partially_received" });
    expect(purchaseBeforeFailure?.items).toEqual([
      expect.objectContaining({ lineId: purchaseLineA, skuId: skuA!.id, quantity: "13.000" }),
      expect.objectContaining({ lineId: purchaseLineB, skuId: skuB!.id, quantity: "17.000" }),
    ]);
    expect(pendingBeforeFailure.receipts.filter(receipt => receipt.purchaseId === purchaseId)).toEqual(receivedPurchaseLines);
    const purchaseVersionBeforeFailure = pendingBeforeFailure.versions[purchaseId];
    const purchaseSnapshotBeforeFailure = {
      order: purchaseBeforeFailure,
      receipts: pendingBeforeFailure.receipts.filter(receipt => receipt.purchaseId === purchaseId),
      version: purchaseVersionBeforeFailure,
    };
    const inventoryBeforeFailure = inventoryReportSnapshot(await getInventoryReport(page));

    const commandPosts = watchCommandPosts(page);
    const catalogPath = (url: string) => new URL(url).pathname === "/api/operations/catalog";
    const readyCatalogRead = page.waitForResponse(response =>
      catalogPath(response.url()) && response.request().method() === "GET" && response.status() === 200,
    );
    await page.goto(`/app/operations?section=purchases`);
    await readyCatalogRead;
    const purchasePrefix = purchaseId.slice(0, 8).toUpperCase();
    const purchaseRow = page.getByRole("row", { name: new RegExp(`^Compra #${purchasePrefix}\\b`) });
    await expect(purchaseRow).toBeVisible();
    await expect(purchaseRow.getByRole("button", { name: "Registrar recepción", exact: true })).toBeVisible();
    await purchaseRow.getByRole("button", { name: "Registrar recepción", exact: true }).click();
    const receiveDialog = page.getByRole("dialog");
    const pendingLineLabel = `Cantidad recibida · ${skuB!.name.trim()} · 17 ${skuB!.unit}`;
    const completedLineLabel = `Cantidad recibida · ${skuA!.name.trim()} · 13 ${skuA!.unit}`;
    await expect(receiveDialog.getByLabel(pendingLineLabel)).toBeVisible();
    await expect(receiveDialog.getByLabel(completedLineLabel)).toHaveCount(0);

    await page.route("**/api/operations/catalog**", async route => {
      if (route.request().method() === "GET" && catalogPath(route.request().url())) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          json: { error: "No se pudo completar la operación. Reintentá." },
        });
        return;
      }
      await route.continue();
    });
    const failedCatalogRead = page.waitForResponse(response =>
      catalogPath(response.url()) && response.request().method() === "GET" && response.status() === 503,
    );
    const readyLocationRead = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/operations/stock/reference-data" && response.request().method() === "GET" && response.status() === 200,
    );
    await page.reload();
    await Promise.all([failedCatalogRead, readyLocationRead]);

    await expect(purchaseRow).toBeVisible();
    await expect(purchaseRow.getByRole("button", { name: "Registrar recepción", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(commandPosts.envelopes).toHaveLength(0);
    const pendingAfter = await getOperation<PurchaseList>(page, "purchases");
    const purchaseAfterFailure = pendingAfter.items.find(purchase => purchase.id === purchaseId);
    expect({
      order: purchaseAfterFailure,
      receipts: pendingAfter.receipts.filter(receipt => receipt.purchaseId === purchaseId),
      version: pendingAfter.versions[purchaseId],
    }).toEqual(purchaseSnapshotBeforeFailure);
    expect(inventoryReportSnapshot(await getInventoryReport(page))).toEqual(inventoryBeforeFailure);
    commandPosts.stop();
  } finally {
    try {
      if (skuADeactivationAttempted) {
        await restoreActiveSku(page, skuA!, "e2e-restore-sku-a-after-receiving-guard");
      }
    } finally {
      await stockContext.close();
    }
  }
});

test("a confirmed reservation remains preparable by lot after its SKU is deactivated", async ({ page }) => {
  await login(page);
  const owner = await getOperation<{ userId: string; rehearsal: boolean; authority: { mode: string } }>(page, "context");
  expect(owner.rehearsal).toBe(true);
  expect(owner.authority.mode).toBe("shadow");

  const appOrigin = new URL(page.url()).origin;
  const seedSkuId = "ops-sku-b";
  const catalogBefore = await getOperation<{
    items: CatalogSku[];
    versions: Record<string, number>;
  }>(page, "catalog");
  const seedSku = catalogBefore.items.find(item => item.id === seedSkuId);
  expect(seedSku?.active).toBe(true);
  expect(seedSku).toBeDefined();
  const seedSkuSnapshot = catalogSkuSnapshot(seedSku!);
  const seedSkuVersion = catalogBefore.versions[seedSkuId];
  expect(Number.isInteger(seedSkuVersion)).toBe(true);
  const seedInventoryBefore = inventoryReportSnapshot(await getInventoryReport(page))
    .filter(balance => balance.skuId === seedSkuId);
  expect(seedInventoryBefore.length).toBeGreaterThan(0);
  const seededBalance = seedSku!.lots.flatMap(lot => lot.balances.map(balance => ({ lot, balance })))
    .find(({ lot, balance }) => balance.locationId === "ops-warehouse" && lot.label === "Etiqueta repetida de ensayo");
  expect(seededBalance).toBeDefined();
  const { lot: sharedSeedLot, balance: sharedSeedBalance } = seededBalance!;
  const seedBalanceRow = seedInventoryBefore.filter(balance =>
    balance.lotId === sharedSeedLot.id && balance.locationId === sharedSeedBalance.locationId
      && balance.custodianId === sharedSeedBalance.custodianId,
  );
  expect(seedBalanceRow).toHaveLength(1);
  const inventoryBefore = seedBalanceRow[0]!;
  expectGrams(sharedSeedBalance.quantity, inventoryBefore.balanceQuantity);
  expectGrams(sharedSeedBalance.reserved, inventoryBefore.reservedQuantity);
  expect(gramsInMilliunits(inventoryBefore.availableQuantity)).toBe(
    gramsInMilliunits(inventoryBefore.balanceQuantity) - gramsInMilliunits(inventoryBefore.reservedQuantity),
  );

  const assertSeedSkuUnchanged = async (report: InventoryReport) => {
    const currentCatalog = await getOperation<{ items: CatalogSku[]; versions: Record<string, number> }>(page, "catalog");
    const currentSeedSku = currentCatalog.items.find(item => item.id === seedSkuId);
    expect(currentSeedSku).toBeDefined();
    expect(catalogSkuSnapshot(currentSeedSku!)).toEqual(seedSkuSnapshot);
    expect(currentCatalog.versions[seedSkuId]).toBe(seedSkuVersion);
    expect(inventoryReportSnapshot(report).filter(balance => balance.skuId === seedSkuId)).toEqual(seedInventoryBefore);
  };

  const postCommand = async (command: string, targetId: string, expectedVersion: number, data: Record<string, unknown>) => {
    const response = await page.request.post("/api/operations/commands", {
      headers: { Origin: appOrigin },
      data: commandEnvelope(command, targetId, expectedVersion, data),
    });
    const body = await response.json();
    expect(response.status(), `${command}: ${JSON.stringify(body)}`).toBe(200);
    return body as { version: number; result: Record<string, any> };
  };

  const skuId = randomUUID();
  const skuCode = `E2E-${skuId.replaceAll("-", "").toUpperCase()}`;
  const skuName = `SKU E2E ${skuId}`;
  const skuVariety = `Variedad E2E ${skuId}`;
  let sku: CatalogSkuFields | null = null;
  let skuDeactivationAttempted = false;
  try {
    const createdSku = await postCommand("CatalogSkuCreated", skuId, 0, {
      code: skuCode,
      name: skuName,
      variety: skuVariety,
      category: seedSku!.category,
      unit: seedSku!.unit,
      minQuantity: seedSku!.minQuantity,
      minVarieties: seedSku!.minVarieties,
      evidence: { reference: `e2e-own-sku-${randomUUID()}`, scope: "synthetic rehearsal fixture" },
    });
    sku = createdSku.result.sku as CatalogSkuFields;
    expect(createdSku.version).toBe(1);
    expect(sku).toMatchObject({ id: skuId, code: skuCode, name: skuName, variety: skuVariety, active: true });
    const catalogAfterCreate = await getOperation<{ items: CatalogSku[]; versions: Record<string, number> }>(page, "catalog");
    const createdCatalogSku = catalogAfterCreate.items.find(item => item.id === skuId);
    expect(createdCatalogSku).toMatchObject({ ...sku, active: true });
    const skuVersion = catalogAfterCreate.versions[skuId];
    expect(Number.isInteger(skuVersion)).toBe(true);
    await assertSeedSkuUnchanged(await getInventoryReport(page));

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const ownLotId = randomUUID();
    const ownLotLabel = `E2E lote propio ${randomUUID().slice(0, 8)}`;
    const openingEvidence = `e2e-own-reservation-stock-${randomUUID()}`;
    const opening = await postCommand("StockOpeningRecorded", ownLotId, 0, {
      skuId,
      label: ownLotLabel,
      quantity: "5",
      unitCost: "2000",
      costCurrency: "ARS",
      receivedDate: today,
      locationId: sharedSeedBalance.locationId,
      custodianId: owner.userId,
      preparedBy: "ops-stock",
      evidence: { reference: openingEvidence, scope: "synthetic rehearsal fixture" },
    });
    expect(opening.result.lot).toMatchObject({ id: ownLotId, label: ownLotLabel, skuId });
    const ownStock = opening.result.balance as StockBalance;
    expect(ownStock).toMatchObject({ id: expect.any(String), locationId: sharedSeedBalance.locationId, custodianId: owner.userId });
    expect(gramsInMilliunits(ownStock.quantity)).toBe(5000n);
    expect(gramsInMilliunits(ownStock.reserved)).toBe(0n);
    expect(opening.result.opening).toMatchObject({ preparedBy: "ops-stock", approvedBy: owner.userId });
    expectGrams(opening.result.opening.quantity, "5");

    const ownInventoryBalance = (report: InventoryReport) => {
      const matchingBalances = report.summary.metrics.current.availableBalancesByLotLocationCustodian.filter(balance =>
        balance.lotId === ownLotId && balance.skuId === skuId && balance.locationId === sharedSeedBalance.locationId
          && balance.custodianId === owner.userId,
      );
      expect(matchingBalances, `synthetic balance visible for lot ${ownLotId}`).toHaveLength(1);
      return matchingBalances[0]!;
    };
    const inventoryAfterOpening = await getInventoryReport(page);
    const ownInventoryBefore = ownInventoryBalance(inventoryAfterOpening);
    expect(ownInventoryBefore).toMatchObject({ lotId: ownLotId, lotLabel: ownLotLabel, skuId, locationId: sharedSeedBalance.locationId, custodianId: owner.userId, unit: "g" });
    expectGrams(ownInventoryBefore.balanceQuantity, "5");
    expectGrams(ownInventoryBefore.reservedQuantity, "0");
    expectGrams(ownInventoryBefore.availableQuantity, "5");
    await assertSeedSkuUnchanged(inventoryAfterOpening);

    const orderId = randomUUID();
    const lineId = randomUUID();

    const created = await postCommand("OrderCreated", orderId, 0, {
      memberId: "ops-member",
      channel: "local",
      currency: "ARS",
    });
    expect(created.result.order).toMatchObject({ id: orderId, commercialState: "draft" });
    const quoted = await postCommand("OrderQuoted", orderId, created.version, {
      currency: "ARS",
      paymentMethod: "cash",
      items: [{ id: lineId, skuId, quantity: "5", manualUnitPrice: "5500", manualReason: "Precio manual sintético para aislar la reserva." }],
    });
    const confirmed = await postCommand("OrderConfirmed", orderId, quoted.version, {
      quoteVersion: 1,
      acceptance: { note: "Aceptación sintética para validar preparación." },
    });
    expect(confirmed.result.commercialState).toBe("confirmed");

    const reservedDetail = await getOperation<OrderDetail>(page, `orders/${orderId}`);
    expect(reservedDetail.order).toMatchObject({ id: orderId, commercialState: "confirmed", fulfillmentState: "unprepared" });
    expect(reservedDetail.order.lines).toHaveLength(1);
    expectGrams(reservedDetail.order.lines[0]!.requested, "5");
    expectGrams(reservedDetail.order.lines[0]!.prepared, "0");
    expectGrams(reservedDetail.order.lines[0]!.delivered, "0");
    expect(reservedDetail.reservations).toHaveLength(1);
    const reservation = reservedDetail.reservations[0]!;
    expect(reservation).toMatchObject({
      lineId,
      balanceId: ownStock.id,
      balance: {
        id: ownStock.id,
        lotId: ownLotId,
        skuId,
        skuName: sku!.name,
        unit: "g",
        lotLabel: ownLotLabel,
      },
    });
    expectGrams(reservation.quantity, "5");
    expectGrams(reservation.consumed, "0");
    const inventoryReserved = await getInventoryReport(page);
    await assertSeedSkuUnchanged(inventoryReserved);
    const ownInventoryReserved = ownInventoryBalance(inventoryReserved);
    expectGrams(ownInventoryReserved.balanceQuantity, "5");
    expectGrams(ownInventoryReserved.reservedQuantity, "5");
    expectGrams(ownInventoryReserved.availableQuantity, "0");

    skuDeactivationAttempted = true;
    const deactivated = await postCommand("CatalogSkuUpdated", skuId, skuVersion, {
      code: sku!.code,
      name: sku!.name,
      variety: sku!.variety,
      category: sku!.category,
      unit: sku!.unit,
      minQuantity: sku!.minQuantity,
      minVarieties: sku!.minVarieties,
      active: false,
      evidence: { reference: `e2e-inactive-sku-reservation-${randomUUID()}`, scope: "synthetic rehearsal fixture" },
    });
    expect(deactivated.result.sku).toMatchObject({ id: skuId, active: false });
    expect(deactivated.version).toBe(skuVersion + 1);

    const inactiveCatalog = await getOperation<{ items: Array<{ id: string; active: boolean }> }>(page, "catalog");
    expect(inactiveCatalog.items.some(item => item.id === skuId)).toBe(false);
    const inactiveDetail = await getOperation<OrderDetail>(page, `orders/${orderId}`);
    expect(inactiveDetail.order.lines).toHaveLength(1);
    expect(inactiveDetail.order.lines[0]).toMatchObject({ id: lineId, skuId, skuName: sku!.name, unit: "g" });
    expectGrams(inactiveDetail.order.lines[0]!.requested, "5");
    expectGrams(inactiveDetail.order.lines[0]!.prepared, "0");
    expectGrams(inactiveDetail.order.lines[0]!.delivered, "0");
    expect(inactiveDetail.reservations[0]?.balance).toMatchObject({
      id: ownStock.id,
      lotId: ownLotId,
      skuId,
      skuName: sku!.name,
      unit: "g",
      lotLabel: ownLotLabel,
    });

    await page.goto("/app/operations?section=orders");
    const orderRow = page.getByRole("row").filter({ hasText: `Pedido #${orderId.slice(0, 8).toUpperCase()}` });
    await expect(orderRow).toBeVisible();
    await expect(orderRow.getByRole("button", { name: "Preparar por lote", exact: true })).toBeVisible();
    const commandPosts = watchCommandPosts(page);
    const detailPath = `/api/operations/orders/${orderId}`;
    await page.route(`**${detailPath}`, async route => {
      const response = await route.fetch();
      const body = await response.json();
      expect(body.reservations?.[0]?.balance).toMatchObject({ id: ownStock.id, skuId });
      body.reservations[0].balance = null;
      await route.fulfill({ response, json: body });
    });

    await orderRow.getByRole("button", { name: "Preparar por lote", exact: true }).click();
    await expect(page.getByText("La preparación queda pausada", { exact: false })).toBeVisible();
    expect(commandPosts.envelopes.filter(envelope => envelope.command === "OrderPrepared")).toHaveLength(0);
    const inventoryAfterBlockedPrepare = await getInventoryReport(page);
    await assertSeedSkuUnchanged(inventoryAfterBlockedPrepare);
    expect(ownInventoryBalance(inventoryAfterBlockedPrepare)).toEqual(ownInventoryReserved);
    const unchangedAfterBlock = await getOperation<OrderDetail>(page, `orders/${orderId}`);
    expect(unchangedAfterBlock.order.fulfillmentState).toBe("unprepared");
    expect(unchangedAfterBlock.allocations).toHaveLength(0);
    await page.unroute(`**${detailPath}`);

    await orderRow.getByRole("button", { name: "Preparar por lote", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(`Cantidad reservada · ${sku!.name} · ${ownLotLabel}`)).toHaveValue("5");
    await expect(dialog.getByLabel(`Peso real · ${sku!.name}`, { exact: true })).toHaveValue("5");
    await dialog.getByLabel("Evidencia de preparación").fill("Preparación sintética sobre la reserva confirmada.");
    const prepared = await submitCommand(page, "OrderPrepared", "Revisar y registrar");
    expect(prepared.envelope.targetId).toBe(orderId);
    expect(prepared.envelope.data.allocations).toEqual([{
      lineId,
      lotId: ownLotId,
      balanceId: ownStock.id,
      requestedQuantity: "5",
      actualQuantity: "5",
    }]);
    commandPosts.stop();
    expect(commandPosts.envelopes.filter(envelope => envelope.command === "OrderPrepared")).toHaveLength(1);

    const preparedDetail = await getOperation<OrderDetail>(page, `orders/${orderId}`);
    expect(preparedDetail.order).toMatchObject({ fulfillmentState: "prepared" });
    expect(preparedDetail.order.lines).toHaveLength(1);
    expect(preparedDetail.order.lines[0]?.skuName).toBe(sku!.name);
    const preparedLine = preparedDetail.order.lines.find(line => line.id === lineId);
    expect(preparedLine).toBeDefined();
    expectGrams(preparedLine!.requested, "5");
    expectGrams(preparedLine!.prepared, "5");
    expectGrams(preparedLine!.delivered, "0");
    expect(preparedDetail.allocations).toHaveLength(1);
    const preparedAllocation = preparedDetail.allocations[0]!;
    expect(preparedAllocation).toMatchObject({
      lineId,
      lotId: ownLotId,
      balanceId: ownStock.id,
      state: "prepared",
    });
    expectGrams(preparedAllocation.requestedQuantity, "5");
    expectGrams(preparedAllocation.actualQuantity, "5");
    expectGrams(preparedAllocation.deliveredQuantity, "0");
    expect(preparedDetail.reservations).toHaveLength(0);
    expect(preparedDetail.version).toBe(prepared.envelope.expectedVersion + 1);
    const inventoryPrepared = await getInventoryReport(page);
    await assertSeedSkuUnchanged(inventoryPrepared);
    const ownInventoryPrepared = ownInventoryBalance(inventoryPrepared);
    expectGrams(ownInventoryPrepared.balanceQuantity, "0");
    expectGrams(ownInventoryPrepared.reservedQuantity, "0");
    expectGrams(ownInventoryPrepared.availableQuantity, "0");
    expect(gramsInMilliunits(ownInventoryPrepared.balanceQuantity)).toBe(
      gramsInMilliunits(ownInventoryBefore.balanceQuantity) - 5000n,
    );

    const ordersBeforePickupResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/operations/orders" && response.request().method() === "GET" && response.status() === 200,
    );
    await page.reload();
    await ordersBeforePickupResponse;
    const ordersBeforePickup = await getOperation<{
      items: Array<{
        id: string;
        channel: string;
        commercialState: string;
        fulfillmentState: string;
        lines: Array<{ id: string; skuId: string; skuName: string | null; unit: string; requested: string; prepared: string; delivered: string }>;
      }>;
      versions: Record<string, number>;
    }>(page, "orders");
    const orderBeforePickup = ordersBeforePickup.items.find(item => item.id === orderId);
    expect(orderBeforePickup).toMatchObject({ id: orderId, channel: "local", commercialState: "confirmed", fulfillmentState: "prepared" });
    expect(orderBeforePickup?.lines).toHaveLength(1);
    expect(orderBeforePickup?.lines[0]).toMatchObject({ id: lineId, skuId, skuName: sku!.name, unit: "g" });
    expectGrams(orderBeforePickup!.lines[0]!.requested, "5");
    expectGrams(orderBeforePickup!.lines[0]!.prepared, "5");
    expectGrams(orderBeforePickup!.lines[0]!.delivered, "0");
    const pickupVersionBefore = ordersBeforePickup.versions[orderId];
    expect(pickupVersionBefore).toBe(preparedDetail.version);

    const pickupRow = page.getByRole("row").filter({ hasText: `Pedido #${orderId.slice(0, 8).toUpperCase()}` });
    await expect(pickupRow.getByRole("button", { name: "Completar retiro", exact: true })).toBeVisible();
    const pickupCommandPosts = watchCommandPosts(page);
    await pickupRow.getByRole("button", { name: "Completar retiro", exact: true }).click();
    const pickupDialog = page.getByRole("dialog");
    await expect(pickupDialog.getByRole("heading", { name: "Registrar retiro y cantidades físicas" })).toBeVisible();
    await expect(pickupDialog.getByLabel(`Cantidad entregada · renglón 1: ${sku!.name}`)).toHaveValue("5");
    await pickupDialog.getByLabel(`Cantidad física · renglón 1: ${sku!.name}`).fill("5");
    await pickupDialog.getByLabel("Evidencia del retiro").fill("Retiro local sintético del pedido confirmado.");
    const pickup = await submitCommand(page, "LocalPickupCompleted", "Revisar y registrar");
    pickupCommandPosts.stop();
    expect(pickup.envelope).toMatchObject({
      command: "LocalPickupCompleted",
      targetId: orderId,
      expectedVersion: pickupVersionBefore,
      data: { lines: [{ lineId, quantity: "5", actualQuantity: "5" }] },
    });
    expect(pickupCommandPosts.envelopes.filter(envelope => envelope.command === "LocalPickupCompleted")).toHaveLength(1);
    const pickupResult = pickup.body.result.result as { orderId: string; fulfillmentState: string; lines: Array<{ lineId: string; deliveredQuantity: string }> };
    expect(pickupResult).toMatchObject({
      orderId,
      fulfillmentState: "delivered",
      lines: [expect.objectContaining({ lineId })],
    });
    expect(pickupResult.lines).toHaveLength(1);
    expectGrams(pickupResult.lines[0]!.deliveredQuantity, "5");
    expect(pickup.body.version).toBe(pickupVersionBefore + 1);

    const pickedUpDetail = await getOperation<OrderDetail>(page, `orders/${orderId}`);
    expect(pickedUpDetail.version).toBe(pickupVersionBefore + 1);
    expect(pickedUpDetail.order).toMatchObject({ id: orderId, fulfillmentState: "delivered" });
    expect(pickedUpDetail.order.lines).toHaveLength(1);
    expect(pickedUpDetail.order.lines[0]).toMatchObject({ id: lineId, skuId, skuName: sku!.name, unit: "g" });
    expectGrams(pickedUpDetail.order.lines[0]!.requested, "5");
    expectGrams(pickedUpDetail.order.lines[0]!.prepared, "5");
    expectGrams(pickedUpDetail.order.lines[0]!.delivered, "5");
    expect(pickedUpDetail.allocations).toHaveLength(1);
    const pickedUpAllocation = pickedUpDetail.allocations[0]!;
    expect(pickedUpAllocation).toMatchObject({
      lineId,
      lotId: ownLotId,
      balanceId: ownStock.id,
      state: "delivered",
    });
    expectGrams(pickedUpAllocation.requestedQuantity, "5");
    expectGrams(pickedUpAllocation.actualQuantity, "5");
    expectGrams(pickedUpAllocation.deliveredQuantity, "5");
    const inventoryAfterPickup = await getInventoryReport(page);
    await assertSeedSkuUnchanged(inventoryAfterPickup);
    expect(ownInventoryBalance(inventoryAfterPickup)).toEqual(ownInventoryPrepared);
  } finally {
    try {
      if (skuDeactivationAttempted && sku) {
        await restoreActiveSku(page, sku, `e2e-restore-own-sku-${skuId}`);
      }
    } finally {
      await assertSeedSkuUnchanged(await getInventoryReport(page));
    }
  }
});
