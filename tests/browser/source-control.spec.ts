import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { legacySourceFollowUpObjectId } from "../../shared/operations/source-control";
import { expect, test } from "./isolated";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("sources UI searches archived rows, pages exceptions, and preserves a conflicted follow-up draft", async ({ page }) => {
  expect(process.env.BOMBO_E2E_ISOLATED).toBe("1");
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]", "::1"]).toContain(databaseUrl.hostname);
  expect(databaseUrl.searchParams.get("schema")).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(process.env.E2E_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const suffix = randomUUID();
  const snapshotId = `source-control-ui-${suffix}`;
  const filename = `synthetic-source-control-${suffix}.xlsx`;
  const fileHash = hash(`${snapshotId}\0file`);
  const importerVersion = "synthetic-source-control-ui/1";
  const rowCount = 51;
  const selectedRow = rowCount;
  const recordId = hash(`${snapshotId}\0C_Cliente\0${selectedRow}`);
  const followUpObjectId = legacySourceFollowUpObjectId(recordId);
  const searchCanary = `SOURCE_CONTROL_UI_SEARCH_${suffix}`;

  try {
    await db.legacyImportSnapshot.create({ data: {
      id: snapshotId,
      sourceSystem: "appsheet-business-archive",
      filename,
      fileHash,
      importerVersion,
      status: "staged",
      createdBy: "gio",
      controls: { sourceClass: "technical-observation", sourceOnly: true } as Prisma.InputJsonValue,
      coverage: { sheets: [
        { name: "C_Cliente", role: "archive_only", recordCount: rowCount },
        { name: "C_Mercaderia", role: "archive_only", recordCount: 1 },
      ] } as Prisma.InputJsonValue,
    } });
    await db.operationObject.create({ data: { id: snapshotId, kind: "legacyImport", version: 1, createdBy: "gio" } });

    const records = Array.from({ length: rowCount }, (_, index) => {
      const rowNumber = index + 1;
      const id = hash(`${snapshotId}\0C_Cliente\0${rowNumber}`);
      const columns = [
        { coordinate: `A${rowNumber}`, header: "Id_Cliente", value: `synthetic-client-${rowNumber}` },
        { coordinate: `B${rowNumber}`, header: "Nombre", value: rowNumber === selectedRow ? searchCanary : `Cliente sintético ${rowNumber}` },
      ];
      return {
        id,
        snapshotId,
        sourceTable: "C_Cliente",
        sourceKey: `synthetic-client-${rowNumber}`,
        sourceRow: rowNumber,
        fileHash,
        contentHash: hash(`${id}\0content`),
        importerVersion,
        original: { columns } as Prisma.InputJsonValue,
        normalized: { columns: structuredClone(columns) } as Prisma.InputJsonValue,
        treatment: "archive_only",
      };
    });
    const merchandiseId = hash(`${snapshotId}\0C_Mercaderia\0${2}`);
    records.push({
      id: merchandiseId,
      snapshotId,
      sourceTable: "C_Mercaderia",
      sourceKey: "synthetic-merchandise-1",
      sourceRow: 2,
      fileHash,
      contentHash: hash(`${merchandiseId}\0content`),
      importerVersion,
      original: { columns: [{ coordinate: "A2", header: "ID_Mercaderia", value: "synthetic-merchandise-1" }] } as Prisma.InputJsonValue,
      normalized: { columns: [{ coordinate: "A2", header: "ID_Mercaderia", value: "synthetic-merchandise-1" }] } as Prisma.InputJsonValue,
      treatment: "archive_only",
    });
    await db.legacySourceRecord.createMany({ data: records });
    await db.legacyException.createMany({ data: [
      ...Array.from({ length: 51 }, (_, index) => ({
        id: hash(`${snapshotId}\0exception\0${selectedRow}\0${index}`),
        snapshotId,
        sourceRecordId: recordId,
        kind: "synthetic_review",
        severity: "review",
        description: `Synthetic exception ${index + 1}`,
      })),
      {
        id: hash(`${snapshotId}\0exception\0unattached`),
        snapshotId,
        sourceRecordId: null,
        kind: "SOURCE_CONTROL_UI_UNATTACHED_CANARY",
        severity: "SOURCE_CONTROL_UI_UNATTACHED_CANARY",
        status: "SOURCE_CONTROL_UI_UNATTACHED_CANARY",
        description: "SOURCE_CONTROL_UI_UNATTACHED_CANARY",
      },
    ] });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/operations");
    await page.getByRole("button", { name: "Explorar club de demostración" }).click();
    await expect(page.locator(".ops-home-page")).toBeVisible();
    await page.request.post("/api/auth/demo", {
      data: { id: "gio" },
      headers: { Origin: new URL(page.url()).origin },
    }).then(async response => expect(response.status(), await response.text()).toBe(200));

    await page.goto("/app/operations?section=sources");
    await expect(page.getByRole("heading", { name: "Fuentes importadas" })).toBeVisible();
    const sourceSearchResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/legacy-imports/source-control"
        && url.searchParams.get("q") === filename;
    });
    await page.getByLabel("Buscar fuentes").fill(filename);
    expect((await sourceSearchResponse).status()).toBe(200);
    const sourceUnattachedExceptions = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().includes(`/api/legacy-imports/source-control/${snapshotId}/exceptions`));
    await page.getByRole("button", { name: `Ver fuente ${filename}` }).click();
    expect((await sourceUnattachedExceptions).status()).toBe(200);
    await expect(page.getByText("Fuente técnica en observación", { exact: true })).toBeVisible();
    const unattachedExceptionTable = page.getByRole("table", { name: "Excepciones de la fuente sin fila" });
    await expect(page.getByRole("heading", { name: "Excepciones de la fuente sin fila" })).toBeVisible();
    await expect(unattachedExceptionTable).toContainText("other_technical_exception");
    await expect(unattachedExceptionTable).not.toContainText("SOURCE_CONTROL_UI_UNATTACHED_CANARY");
    await expect(page.locator(".source-links").getByRole("link", { name: "Importación y conciliación", exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("sourceId")).toBe(snapshotId);

    await page.getByLabel("Tabla de origen").selectOption("C_Mercaderia");
    await expect(page.getByRole("button", { name: "Ver fila C_Mercaderia 2", exact: true })).toBeVisible();
    await page.getByLabel("Tabla de origen").selectOption("");
    await expect(page.getByRole("button", { name: "Ver fila C_Cliente 1", exact: true })).toBeVisible();

    const nextPage = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/legacy-imports/source-control/${snapshotId}/records`
        && Boolean(url.searchParams.get("cursor"));
    });
    await page.getByRole("button", { name: "Filas siguientes", exact: true }).click();
    const nextPageResponse = await nextPage;
    expect(nextPageResponse.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Ver fila C_Cliente 51", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Filas anteriores", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ver fila C_Cliente 1", exact: true })).toBeVisible();

    const crossPageSearch = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/legacy-imports/source-control/${snapshotId}/records`
        && url.searchParams.get("q") === searchCanary;
    });
    await page.getByLabel("Buscar en filas").fill(searchCanary);
    const crossPageResponse = await crossPageSearch;
    expect(crossPageResponse.status()).toBe(200);
    const searchResult = await crossPageResponse.json() as { items: Array<{ recordId: string; rowNumber: number }> };
    expect(searchResult.items.map(row => [row.recordId, row.rowNumber])).toEqual([[recordId, selectedRow]]);
    await expect(page.getByRole("button", { name: "Ver fila C_Cliente 51", exact: true })).toBeVisible();

    const exceptionFilter = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/legacy-imports/source-control/${snapshotId}/records`
        && url.searchParams.get("exceptionOnly") === "true";
    });
    const exceptionOnlyFilter = page.getByLabel("Sólo filas con excepciones");
    await exceptionOnlyFilter.click();
    await expect(exceptionOnlyFilter).toBeChecked();
    const exceptionFilterResponse = await exceptionFilter;
    expect(exceptionFilterResponse.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Ver fila C_Cliente 51", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Ver fila C_Cliente 51", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Detalle de fila" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Valores originales" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Datos interpretados" })).toBeVisible();
    await expect(page.locator(".source-record-detail")).toContainText(searchCanary);
    await expect(page.getByText("51 excepciones", { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("recordId")).toBe(recordId);

    const firstExceptions = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/legacy-imports/source-control/${snapshotId}/records/${recordId}/exceptions`;
    });
    await page.getByLabel("Paginación de excepciones", { exact: true })
      .getByRole("button", { name: "Excepciones siguientes", exact: true }).click();
    expect((await firstExceptions).status()).toBe(200);
    await expect(page.getByText("1 de 51 excepciones", { exact: true })).toBeVisible();

    const noteDraft = "Nota sintética conservada durante el conflicto";
    const evidenceDraft = "Referencia sintética posterior al conflicto";
    await page.getByLabel("Estado del seguimiento").selectOption("reviewing");
    await page.getByLabel("Nota de seguimiento").fill(noteDraft);
    await page.getByLabel("Evidencia del seguimiento (opcional)").fill(evidenceDraft);

    const origin = new URL(page.url()).origin;
    const winnerRequestId = randomUUID();
    const winner = await page.request.post("/api/operations/commands", {
      headers: { Origin: origin },
      data: {
        schemaVersion: 1,
        requestId: winnerRequestId,
        targetId: followUpObjectId,
        expectedVersion: 0,
        occurredAt: new Date().toISOString(),
        command: "LegacySourceFollowUpRecorded",
        data: { snapshotId, recordId, status: "explained", note: "Ganador sintético concurrente", evidence: "Evidencia del ganador" },
      },
    });
    expect(winner.status(), await winner.text()).toBe(200);

    const staleWrite = page.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith("/api/operations/commands")
      && response.request().postDataJSON()?.command === "LegacySourceFollowUpRecorded");
    await page.getByRole("button", { name: "Guardar seguimiento", exact: true }).click();
    expect((await staleWrite).status()).toBe(409);
    await expect(page.locator(".source-record-detail").getByRole("alert")).toContainText("cambió en otra sesión");
    await expect(page.getByLabel("Estado del seguimiento")).toHaveValue("reviewing");
    await expect(page.getByLabel("Nota de seguimiento")).toHaveValue(noteDraft);
    await expect(page.getByLabel("Evidencia del seguimiento (opcional)")).toHaveValue(evidenceDraft);

    const refreshedRows = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().includes(`/api/legacy-imports/source-control/${snapshotId}/records`));
    await page.getByRole("button", { name: "Actualizar fila del servidor", exact: true }).click();
    expect((await refreshedRows).status()).toBe(200);
    await expect(page.locator(".source-follow-up-meta")).toContainText("versión 1");
    await expect(page.getByLabel("Nota de seguimiento")).toHaveValue(noteDraft);
    await expect(page.getByLabel("Evidencia del seguimiento (opcional)")).toHaveValue(evidenceDraft);

    const savedWrite = page.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith("/api/operations/commands")
      && response.request().postDataJSON()?.command === "LegacySourceFollowUpRecorded");
    await page.getByRole("button", { name: "Guardar cambios del seguimiento", exact: true }).click();
    const savedResponse = await savedWrite;
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    await expect(page.locator(".source-follow-up-meta")).toContainText("versión 2");
    await expect(page.getByText("Seguimiento guardado y verificado en la fuente.", { exact: true })).toBeVisible();
    await expect(page.locator(".source-records-sheet tbody")).toContainText("En revisión");
    await expect(page.getByLabel("Nota de seguimiento")).toHaveValue(noteDraft);
    await expect(page.getByLabel("Evidencia del seguimiento (opcional)")).toHaveValue(evidenceDraft);

    const persistedResponse = await page.request.get(`/api/legacy-imports/source-control/${snapshotId}/records?q=${encodeURIComponent(searchCanary)}&exceptionOnly=true&limit=50`);
    expect(persistedResponse.status(), await persistedResponse.text()).toBe(200);
    const persistedRows = await persistedResponse.json() as { items: Array<{ recordId: string; followUp: { status: string; note: string; evidence: string; version: number } | null }> };
    expect(persistedRows.items).toMatchObject([{ recordId, followUp: { status: "reviewing", note: noteDraft, evidence: evidenceDraft, version: 2 } }]);

    const desktop = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(desktop.viewport).toBe(1280);
    expect(desktop.document).toBeLessThanOrEqual(desktop.viewport);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(mobile.viewport).toBe(390);
    expect(mobile.document).toBeLessThanOrEqual(mobile.viewport);

    await page.setViewportSize({ width: 1280, height: 900 });
    const statementsReport = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/reports/operations/financial-statements";
    });
    const projectionReport = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/reports/operations/summary"
        && url.searchParams.get("area") === "obligations-13-weeks";
    });
    await page.getByRole("link", { name: "Estados financieros", exact: true }).click();
    expect((await statementsReport).status()).toBe(200);
    const projectionResponse = await projectionReport;
    expect(projectionResponse.status()).toBe(200);
    const projection = await projectionResponse.json() as { summary: { metrics: {
      currenciesCombined: boolean;
      weekly: unknown[] | null;
      clubAccounts: Array<{ accountId: string; currency: "ARS" | "USD"; verified: boolean; openingApproved: boolean; countedBalanceMinor: string | null }>;
    } } };
    expect(projection.summary.metrics.currenciesCombined).toBe(false);
    expect(projection.summary.metrics.weekly).toHaveLength(13);
    const clubAccounts = projection.summary.metrics.clubAccounts;
    expect(clubAccounts).toHaveLength(6);
    const pendingAccounts = clubAccounts.filter(account => !account.verified || !account.openingApproved);
    expect(pendingAccounts).toHaveLength(0);
    expect(clubAccounts.every(account => account.verified && account.openingApproved)).toBe(true);
    expect(clubAccounts.every(account => account.countedBalanceMinor === null)).toBe(true);
    await expect(page.getByRole("heading", { name: "Resultado del período" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Obligaciones verificadas y pendientes" })).toBeVisible();
    await expect(page.getByText("La respuesta del informe no coincide con el formato esperado.", { exact: true })).toHaveCount(0);
    await expect(page.locator(".finance-projection-account")).toHaveCount(clubAccounts.length);
    await expect(page.getByText("Verificada y apertura aprobada", { exact: true })).toHaveCount(clubAccounts.length);
    await expect(page.getByText("Verificación o apertura pendiente", { exact: true })).toHaveCount(pendingAccounts.length);
    const priorBalanceRows = page.locator(".finance-projection-account dl > div").filter({ hasText: "Saldo conciliado previo" });
    await expect(priorBalanceRows).toHaveCount(clubAccounts.length);
    await expect(priorBalanceRows.getByText("Pendiente", { exact: true }),
      "verified/opening-approved accounts still have no reconciled prior balance in the fixture").toHaveCount(6);
    await expect(page.getByRole("table", { name: "Obligaciones semanales por moneda" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "ARS abiertas", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "USD abiertas", exact: true })).toBeVisible();
  } finally {
    try {
      const receipts = await db.commandReceipt.findMany({ where: { targetId: followUpObjectId }, select: { requestId: true } });
      const requestIds = receipts.map(receipt => receipt.requestId);
      if (requestIds.length) await db.operationOutbox.deleteMany({ where: { requestId: { in: requestIds } } });
      await db.operationAudit.deleteMany({ where: { objectId: followUpObjectId } });
      await db.commandReceipt.deleteMany({ where: { targetId: followUpObjectId } });
      await db.operationObject.deleteMany({ where: { id: followUpObjectId } });
    } finally {
      await db.$disconnect();
    }
  }
});
