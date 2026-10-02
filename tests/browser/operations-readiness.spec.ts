import { test, expect } from "./isolated";
import { createHash, randomUUID } from "node:crypto";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

const payloadHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function envelope(targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0) {
  return { schemaVersion: 1, requestId: randomUUID(), targetId, expectedVersion, occurredAt: new Date().toISOString(), command, data };
}

async function responseJson(response: import("@playwright/test").APIResponse, expectedStatus = 200) {
  const body = await response.text();
  expect(response.status(), body).toBe(expectedStatus);
  return body ? JSON.parse(body) as Record<string, any> : {};
}

async function switchDemoActor(page: import("@playwright/test").Page, id: string) {
  const origin = new URL(page.url()).origin;
  await responseJson(await page.request.post("/api/auth/demo", { data: { id }, headers: { Origin: origin } }));
  await page.goto("/app/operations");
  await expect(page.locator(".ops-home-page")).toBeVisible();
}

async function stageHistoryBatch(page: import("@playwright/test").Page) {
  const suffix = randomUUID();
  const sourceSystem = `readiness-history-${suffix}`;
  const batchId = `readiness-history-${suffix}`;
  const importerVersion = "browser-readiness/1";
  const fileHash = payloadHash({ sourceSystem, version: importerVersion });
  const invoiceColumns = [
    { coordinate: "A2", header: "Id_Factura", value: `invoice-${suffix}` },
    { coordinate: "B2", header: "Fecha", value: "2026-09-30" },
    { coordinate: "C2", header: "Total_Facturado", value: "1265.00", moneyMinorUnits: "126500" },
    { coordinate: "D2", header: "Moneda", value: "ARS" },
    { coordinate: "E2", header: "Cliente", value: "Fixture de ensayo" },
  ];
  const auxiliaryColumns = [{ coordinate: "A2", header: "Nota", value: "Dato auxiliar conservado" }];
  const records = [
    { sourceTable: "C_Facturacion", sourceKey: `invoice-${suffix}`, sourceRow: 2, fileHash, importerVersion, original: { columns: invoiceColumns }, normalized: { columns: invoiceColumns }, treatment: "fact_candidate", exceptions: [] },
    { sourceTable: "C_Auxiliar", sourceKey: `auxiliary-${suffix}`, sourceRow: 2, fileHash, importerVersion, original: { columns: auxiliaryColumns }, normalized: { columns: auxiliaryColumns }, treatment: "archive_only", exceptions: [] },
  ].map(record => ({ ...record, contentHash: payloadHash(record) }));
  const chunk = { index: 0, contentHash: payloadHash(records), recordCount: records.length };
  const manifest = { chunks: [chunk], recordsByTable: { C_Facturacion: 1, C_Auxiliar: 1 } };
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin };
  const begin = await responseJson(await page.request.post("/api/legacy-imports/batches", {
    data: envelope(batchId, "LegacyUploadBegun", {
      sourceSystem, filename: `readiness-${suffix}.xlsx`, fileHash, importerVersion,
      manifest, manifestHash: payloadHash(manifest), controls: { syntheticReadiness: true },
      coverage: [
        { name: "C_Facturacion", coordinateOnly: false, recordCount: 1 },
        { name: "C_Auxiliar", coordinateOnly: false, recordCount: 1 },
      ],
    }), headers,
  }), 201);
  const stored = await responseJson(await page.request.post(`/api/legacy-imports/batches/${batchId}/chunks`, {
    data: envelope(batchId, "LegacyUploadChunkStored", { index: 0, contentHash: chunk.contentHash, records }, begin.version), headers,
  }));
  await responseJson(await page.request.post(`/api/legacy-imports/batches/${batchId}/finalize`, {
    data: envelope(batchId, "LegacyUploadFinalized", { manifestHash: payloadHash(manifest) }, stored.version), headers,
  }));
  return { batchId, fileHash, filename: `readiness-${suffix}.xlsx` };
}

test("legacy import progress is a read-only browser workflow without workbook or source-row access", async ({ page }) => {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();

  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Importar libro legado" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Consultar registros protegidos" })).toHaveCount(0);

  const batchId = `missing-${crypto.randomUUID()}`;
  const progressURL = `/api/legacy-imports/batches/${encodeURIComponent(batchId)}`;
  const requests: Array<{ method: string; path: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/legacy-imports/")) requests.push({ method: request.method(), path: url.pathname });
  });
  const progressRequest = page.waitForRequest(request => new URL(request.url()).pathname === progressURL);
  await page.getByLabel("Identificador del lote").fill(batchId);
  await page.getByRole("button", { name: "Consultar progreso", exact: true }).click();
  expect((await progressRequest).method()).toBe("GET");
  await expect(page.getByRole("alert")).toBeVisible();

  expect(requests).toContainEqual({ method: "GET", path: progressURL });
  expect(requests.some(request => request.method === "POST" && request.path.endsWith("/preview"))).toBe(false);
  expect(requests.some(request => request.path.endsWith("/staged-records"))).toBe(false);
});

test("reviewed history requires an explicit treatment per table, publishes through the UI, and exports real approved facts", async ({ page }) => {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();

  const importGrant = await responseJson(await page.request.post("/api/operations/commands", {
    data: envelope(randomUUID(), "AccessGranted", { userId: "r1", profile: "finance", additional: [], scope: {} }),
    headers: { Origin: new URL(page.url()).origin },
  }));
  expect(importGrant.result.userId).toBe("r1");
  const grantTarget = randomUUID();
  const grant = await responseJson(await page.request.post("/api/operations/commands", {
    data: envelope(grantTarget, "AccessGranted", { userId: "r2", profile: "commercial", additional: ["imports.review"], scope: {} }),
    headers: { Origin: new URL(page.url()).origin },
  }));
  expect(grant.result.userId).toBe("r2");

  await switchDemoActor(page, "r1");
  const source = await stageHistoryBatch(page);
  await switchDemoActor(page, "gio");
  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  const sourceRow = page.locator("tbody tr").filter({ hasText: source.filename });
  await expect(sourceRow).toBeVisible();
  const reviewed = page.waitForResponse(response => response.url().endsWith(`/api/legacy-imports/${source.batchId}/review`) && response.request().method() === "POST");
  page.once("dialog", dialog => dialog.accept("Revisión sintética independiente del lote de ensayo."));
  await sourceRow.getByRole("button", { name: "Revisar independientemente", exact: true }).click();
  await responseJson(await reviewed);

  await switchDemoActor(page, "r2");
  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  const workflow = page.getByRole("region", { name: "Publicación histórica" });
  await workflow.getByLabel("Fuente revisada").selectOption(source.batchId);
  await workflow.getByText("Proponer una nueva interpretación", { exact: true }).click();
  await workflow.getByLabel("Nombre de la interpretación").fill("Mapeo sintético con tratamiento explícito");
  await workflow.getByLabel("Evidencia de interpretación o publicación").fill("La factura usa importe menor exacto y la tabla auxiliar se conserva como archivo.");
  const table = workflow.getByLabel("Tabla a interpretar");
  const treatment = workflow.getByLabel("Tratamiento");
  const propose = workflow.getByRole("button", { name: "Proponer interpretación", exact: true });
  await expect(treatment).toHaveValue("");
  await expect(propose).toBeDisabled();

  await table.selectOption("C_Facturacion");
  await treatment.selectOption("invoice");
  await workflow.getByLabel("Fecha del hecho").selectOption("Fecha");
  await workflow.getByLabel("Base monetaria").selectOption("Total_Facturado");
  await workflow.getByLabel("Moneda fija aprobable (si no hay columna)").selectOption("ARS");
  await table.selectOption("C_Auxiliar");
  await expect(treatment).toHaveValue("");
  await expect(propose).toBeDisabled();
  await treatment.selectOption("archive");
  await expect(propose).toBeEnabled();

  const proposalResponse = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON().command === "ConfigurationProposed");
  await propose.click();
  const proposal = await responseJson(await proposalResponse);
  const mappingId = proposal.result.configuration.id as string;
  const proposedDefinition = proposal.result.configuration.definition.tables as Array<{ table: string; kind: string }>;
  expect(proposedDefinition.map(row => [row.table, row.kind])).toEqual([["C_Facturacion", "invoice"], ["C_Auxiliar", "archive"]]);

  await switchDemoActor(page, "owner");
  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  const ownerWorkflow = page.getByRole("region", { name: "Publicación histórica" });
  await ownerWorkflow.getByLabel("Fuente revisada").selectOption(source.batchId);
  await ownerWorkflow.getByLabel("Interpretación histórica").selectOption(mappingId);
  await ownerWorkflow.getByLabel("Evidencia de interpretación o publicación").fill("Revisión de propietario del mapeo sintético de ensayo.");
  const approvalResponse = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON().command === "ConfigurationApproved");
  await ownerWorkflow.getByRole("button", { name: "Aprobar interpretación como propietario", exact: true }).click();
  await responseJson(await approvalResponse);

  await switchDemoActor(page, "r2");
  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  const proposerWorkflow = page.getByRole("region", { name: "Publicación histórica" });
  await proposerWorkflow.getByLabel("Fuente revisada").selectOption(source.batchId);
  await proposerWorkflow.getByLabel("Interpretación histórica").selectOption(mappingId);
  const projectionResponse = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON().command === "LegacyHistoryProjected");
  await proposerWorkflow.getByRole("button", { name: "Tratar próximo bloque (hasta 500)", exact: true }).click();
  const projection = await responseJson(await projectionResponse);
  expect(projection.result.projected).toBe(2);

  await switchDemoActor(page, "owner");
  await page.getByRole("button", { name: "Importación legado", exact: true }).click();
  const publisherWorkflow = page.getByRole("region", { name: "Publicación histórica" });
  await publisherWorkflow.getByLabel("Fuente revisada").selectOption(source.batchId);
  await publisherWorkflow.getByLabel("Interpretación histórica").selectOption(mappingId);
  await publisherWorkflow.getByLabel("Evidencia de interpretación o publicación").fill("Publicación sintética de prueba con aprobación independiente.");
  const publishResponse = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON().command === "LegacyHistoryPublished");
  const publishButton = publisherWorkflow.getByRole("button", { name: "Publicar historia aprobada", exact: true });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  const publication = await responseJson(await publishResponse);
  expect(publication.result.rows).toBe(2);
  expect(publication.result.historyCreatesBalances).toBe(false);

  await page.getByRole("button", { name: "Informes", exact: true }).click();
  const exportPanel = page.getByRole("region", { name: "Exportación canónica" });
  await exportPanel.getByLabel("Hechos").selectOption("history");
  const exportResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/reports/operations/exports/history" && response.request().method() === "GET");
  const downloadEvent = page.waitForEvent("download");
  await exportPanel.getByRole("button", { name: "Descargar primera parte", exact: true }).click();
  const [download, exported] = await Promise.all([downloadEvent, exportResponse]);
  const exportBody = await responseJson(exported);
  expect(exportBody.rows).toBe(2);
  let csv = "";
  for await (const chunk of await download.createReadStream()) csv += Buffer.from(chunk).toString("utf8");
  expect(csv).toContain("C_Facturacion");
  expect(csv).toContain("126500");
  expect(csv).toContain("ARS");
  await expect(exportPanel).toContainText("Descarga completa");
});

test("order identity stays readable and account actions stay compact behind disclosure", async ({ page }, testInfo) => {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();

  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  const order = page.locator("tbody tr").filter({ hasText: "Pedido #ops-delivery-order" });
  await expect(order).toContainText("Socio de ensayo");
  await testInfo.attach("orders-visible-identities", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await order.getByText("1 líneas", { exact: true }).click();
  await expect(order).toContainText("Variedad A");

  await page.getByRole("button", { name: "Cuentas y saldos", exact: true }).click();
  const accounts = page.locator("section.ops-list-sheet-compact").filter({ has: page.getByRole("heading", { name: /Cuentas y saldos/ }) });
  const rows = accounts.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(6);
  for (let index = 0; index < await rows.count(); index++) {
    const box = await rows.nth(index).boundingBox();
    expect(box?.height).toBeLessThan(90);
  }
  const disclosure = rows.first().locator("details.ops-row-actions-disclosure");
  await expect(disclosure).toHaveJSProperty("open", false);
  await testInfo.attach("accounts-compact-rows", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveJSProperty("open", true);
  await expect(disclosure.getByRole("button", { name: "Ver movimientos", exact: true })).toBeVisible();
});
