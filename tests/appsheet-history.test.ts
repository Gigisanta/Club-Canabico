import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  analyzeAppSheetHistoryMovementMatches,
  appSheetHistoryProjectionReport,
  appSheetHistoryCoverageFingerprint,
  AppSheetHistoryStageError,
  buildAppSheetPendingSourceRecord,
  formatCellData,
  prepareAppSheetHistoryProjection,
  stageAppSheetHistoryProjection,
  type AppSheetHistoryDefinition,
  type LoadedAppSheetHistoryCapture,
  type PreparedAppSheetHistoryProjection,
} from "../server/operations/appsheet-history.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID } from "../server/operations/appsheet-canonical.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS,
  APPSHEET_HISTORY_SOURCE_SYSTEM } from "../shared/operations/appsheet-history.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { pendingMappingFingerprintPayload, reconcileAppSheetPendingRows } from "../shared/operations/appsheet-pending.js";
import { parseAppSheetHistoryCliArgs, privateAppSheetChildPath, runAppSheetHistoryCli } from "../scripts/appsheet-history.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const HISTORY_TEST_DESTINATION_ID = appSheetDatabaseDestinationIdentity("isolated-test",
  new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=history&sslmode=require"));
const OTHER_HISTORY_TEST_DESTINATION_ID = appSheetDatabaseDestinationIdentity("isolated-test",
  new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=other&sslmode=require"));
const PRODUCTION_TEST_DESTINATION_ID = appSheetDatabaseDestinationIdentity("production",
  new URL("postgresql://fixture:fixture@db.example.invalid:5432/bombo?schema=public&sslmode=require"));
const pendingCapture = {
  captureId: "appsreal-0123456789abcdef",
  manifestHash: "a".repeat(64),
  mode: "preliminary-delta" as const,
  mappingHash: sha256(pendingMappingFingerprintPayload()),
};

type Formatted = ReturnType<typeof formatCellData>;

function pendingRow(input: {
  sourceTable: string;
  sourceRow: number;
  sourceKey: string;
  headers: string[];
  values?: Record<string, string | null>;
  unresolvedFormulaFields?: string[];
}) {
  const headerColumns = input.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false }));
  const formatted = new Map<string, Formatted[]>();
  for (const [header, value] of Object.entries(input.values ?? {})) {
    if (value === null) continue;
    const columnIndex = input.headers.indexOf(header) + 1;
    const cell = formatCellData({ columnIndex, effectiveValue: { stringValue: value } }, input.sourceRow, header);
    formatted.set(header, [cell]);
  }
  const cells = [...formatted.values()].flat();
  return buildAppSheetPendingSourceRecord({
    sourceTable: input.sourceTable,
    sourceRow: input.sourceRow,
    sourceKey: input.sourceKey,
    original: { columns: cells.map((cell) => ({ coordinate: cell.coordinate, header: cell.normalized.header, value: cell.original })) },
    normalizedColumns: cells.map((cell) => cell.normalized),
    formatted,
    headerColumns,
    unresolvedFormulaFields: input.unresolvedFormulaFields,
  });
}

test("pending input retains empty schema fields as null instead of making them unresolved", () => {
  const input = pendingRow({
    sourceTable: "C_Facturacion", sourceRow: 12, sourceKey: "invoice-12",
    headers: ["Id_Factura", "N_factura", "Total_Facturado", "Tipo_Moneda"],
    values: { Id_Factura: "invoice-12", N_factura: "F-12", Total_Facturado: "100.00" },
  });
  assert.deepEqual(input.values, {
    Id_Factura: "invoice-12", N_factura: "F-12", Total_Facturado: "100.00", Tipo_Moneda: null,
  });
  assert.deepEqual(input.duplicateFields, []);
  assert.deepEqual(input.unresolvedFields, []);
});

test("duplicate headers and unresolved formula fields stay explicit even when cells have no effective value", () => {
  const headers = ["ID_Movimiento_Unique", "Tipo_Moneda", "Tipo_Moneda"];
  const headerColumns = headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false }));
  const formula = formatCellData({ columnIndex: 1, userEnteredValue: { formulaValue: "=1+1" } }, 8, headers[0]!);
  const row = buildAppSheetPendingSourceRecord({
    sourceTable: "Movimiento_Nueva", sourceRow: 8, sourceKey: "synthetic:Movimiento_Nueva:8",
    original: { columns: [{ coordinate: formula.coordinate, header: headers[0]!, value: formula.original }] },
    normalizedColumns: [formula.normalized],
    formatted: new Map([[headers[0]!, [formula]]]),
    headerColumns,
    unresolvedFormulaFields: [headers[0]!],
  });
  assert.equal(row.values.ID_Movimiento_Unique, null);
  assert.equal(row.values.Tipo_Moneda, null);
  assert.deepEqual(row.duplicateFields, ["Tipo_Moneda"]);
  assert.deepEqual(row.unresolvedFields, ["ID_Movimiento_Unique"]);
});

test("blank movement rows no longer poison settlement ID namespaces", () => {
  const invoice = pendingRow({
    sourceTable: "C_Facturacion", sourceRow: 2, sourceKey: "invoice-2",
    headers: ["Id_Factura", "N_factura", "Total_Facturado", "Tipo_Moneda"],
    values: { Id_Factura: "invoice-2", N_factura: "F-2", Total_Facturado: "100.00", Tipo_Moneda: "USD" },
  });
  const detail = pendingRow({
    sourceTable: "C_Detalle_Fact", sourceRow: 3, sourceKey: "line-3",
    headers: ["Id_Detalle", "Id_Factura"], values: { Id_Detalle: "line-3", Id_Factura: "invoice-2" },
  });
  const cashHeaders = ["ID_Movimiento_Unique", "ID_Movimiento", ...APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS,
    "Tabla_Origen", "Origen_ID", "ID_Origen_2"];
  const payment = pendingRow({
    sourceTable: "Movimiento_Nueva", sourceRow: 4, sourceKey: "payment-4", headers: cashHeaders,
    values: {
      ID_Movimiento_Unique: "payment-4", ID_Movimiento: "legacy-payment-4", Fecha: "2026-10-01",
      Tipo_Movimiento: "Ingreso", Concepto: "Venta", Caja: "Caja 1", Monto: "40.00", Tipo_Moneda: "USD",
      Afecta_Resultado: "true", Tabla_Origen: "venta", Origen_ID: "invoice-2", ID_Origen_2: "F-2",
    },
  });
  const unrelatedBlankPayment = pendingRow({
    sourceTable: "Movimiento_Nueva", sourceRow: 5, sourceKey: "synthetic:Movimiento_Nueva:5", headers: cashHeaders,
  });
  const result = reconcileAppSheetPendingRows([invoice, detail, payment, unrelatedBlankPayment], pendingCapture, sha256)
    .find((item) => item.sourceTable === "C_Facturacion" && item.sourceRow === 2);
  assert.ok(result);
  assert.equal(result.reconciliation.dimensions.receivable.status, "confirmed_pending");
  assert.equal(result.reconciliation.dimensions.receivable.settlement?.dueMinorUnits, "10000");
  assert.equal(result.reconciliation.dimensions.receivable.settlement?.paidMinorUnits, "4000");
  assert.equal(result.reconciliation.dimensions.receivable.settlement?.remainingMinorUnits, "6000");
});

test("movement overlap excludes exact-linked candidates from the unmatched count and flags duplicate legacy rows", () => {
  const values = ["2026-10-01", "Ingreso", "Venta", "Caja 1", "40.00", "USD", "true"];
  const unrelated = [...values]; unrelated[4] = "41.00";
  const exact = analyzeAppSheetHistoryMovementMatches([
    { id: "new-1", sourceTable: "Movimiento_Nueva", sourceRow: 10, legacyId: "legacy-1", compositeValues: values },
    { id: "new-unmatched", sourceTable: "Movimiento_Nueva", sourceRow: 11, legacyId: "legacy-unmatched", compositeValues: unrelated },
    { id: "old-1", sourceTable: "Movimiento", sourceRow: 20, legacyId: "legacy-1", compositeValues: values },
  ]);
  assert.equal(exact.decisions[0]?.status, "exact_legacy_fields");
  assert.equal(exact.decisions[0]?.exactIdMatch, true);
  assert.deepEqual(exact.decisions[0]?.targetSourceRecordIds, ["new-1"]);
  assert.equal(exact.unmatchedCandidateRecords, 1);

  const ambiguous = analyzeAppSheetHistoryMovementMatches([
    { id: "new-2", sourceTable: "Movimiento_Nueva", sourceRow: 11, legacyId: null, compositeValues: values },
    { id: "old-2a", sourceTable: "Movimiento", sourceRow: 21, legacyId: "legacy-2a", compositeValues: values },
    { id: "old-2b", sourceTable: "Movimiento", sourceRow: 22, legacyId: "legacy-2b", compositeValues: values },
  ]);
  assert.equal(ambiguous.ambiguousLegacyCompositeGroups, 1);
  assert.deepEqual(ambiguous.decisions.map((item) => item.status), ["ambiguous_reference", "ambiguous_reference"]);
  assert.deepEqual(ambiguous.decisions.map((item) => item.targetSourceRecordIds), [["new-2"], ["new-2"]]);
});

test("movement overlap distinguishes same ID with changed composite and incomplete evidence", () => {
  const values = ["2026-10-01", "Ingreso", "Venta", "Caja 1", "40.00", "USD", "true"];
  const changed = [...values]; changed[4] = "41.00";
  const analysis = analyzeAppSheetHistoryMovementMatches([
    { id: "new-3", sourceTable: "Movimiento_Nueva", sourceRow: 12, legacyId: "legacy-3", compositeValues: changed },
    { id: "old-3", sourceTable: "Movimiento", sourceRow: 23, legacyId: "legacy-3", compositeValues: values },
    { id: "old-4", sourceTable: "Movimiento", sourceRow: 24, legacyId: null, compositeValues: [null, ...values.slice(1)] },
  ]);
  assert.equal(analysis.decisions.find((item) => item.sourceRecordId === "old-3")?.status, "different_legacy_fields");
  assert.equal(analysis.decisions.find((item) => item.sourceRecordId === "old-4")?.status, "comparison_incomplete");
});

test("history CLI defaults to read-only preview and rejects unsafe apply arguments", () => {
  const options = parseAppSheetHistoryCliArgs([], "/workspace/bombo");
  assert.notEqual(options, "help");
  if (options === "help") throw new Error("unexpected_help");
  assert.equal(options.apply, false);
  assert.equal(options.target, "isolated");
  assert.match(options.definitionPath, /appsheet-definition-inventory-1\.001739-v2\.json$/);
  assert.throws(() => parseAppSheetHistoryCliArgs(["--apply"], "/workspace/bombo"),
    (error) => error instanceof AppSheetHistoryStageError && error.code === "apply_review_actor_and_backup_required");
  assert.throws(() => privateAppSheetChildPath("../review.json", "/workspace/bombo/.local/appsheet-real-20261009", "/workspace/bombo"),
    (error) => error instanceof AppSheetHistoryStageError && error.code === "private_direct_child_required");
});

test("coverage fingerprint hashes exception counts without changing the public count contract", () => {
  const coverage = {
    schemaVersion: "appsheet-history-coverage/v1", exceptionTotal: 3, sheets: [],
    totals: { kindCounts: { cash: 2, invoice: 4 } },
  };
  const first = appSheetHistoryCoverageFingerprint(coverage);
  const second = appSheetHistoryCoverageFingerprint({ ...coverage, exceptionTotal: 4 });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(coverage.exceptionTotal, 3);
  assert.equal(coverage.totals.kindCounts.cash, 2);
  assert.throws(() => appSheetHistoryCoverageFingerprint({ exceptionTotal: 1.5 }),
    (error) => error instanceof AppSheetHistoryStageError && error.code === "coverage_exception_count_invalid");
  const withoutCash = { exceptionTotal: 0, sheets: [], totals: { kindCounts: { stock: 1 } } };
  const explicitZeroCash = { exceptionTotal: 0, sheets: [], totals: { kindCounts: { stock: 1, cash: 0 } } };
  assert.equal(appSheetHistoryCoverageFingerprint(withoutCash), appSheetHistoryCoverageFingerprint(explicitZeroCash));
  for (const cash of [null, -1, 1.5, "0"]) assert.throws(() => appSheetHistoryCoverageFingerprint({
    exceptionTotal: 0, sheets: [], totals: { kindCounts: { cash } },
  }), (error) => error instanceof AppSheetHistoryStageError && error.code === "coverage_cash_fact_count_invalid");
});

test("stock movement projection preserves grams, optional source refs and catalog identity conflicts as history only", () => {
  const sheetInputs = [
    { sheetId: 1, title: "D_Catalogo_Mercaderia", headers: ["CatalogoID", "Codigo_Detalle"], rows: [
      ["catalog-1", "CODE-1"], ["catalog-2", "CODE-2"],
    ] },
    { sheetId: 2, title: "C_Mercaderia", headers: ["ID_Mercaderia", "Fecha_Compra", "Precio_Total_Abonado", "Cantidad_Cann_Ingresado", "Codigo_Detalle", "Variedad_Cann"], rows: [
      ["purchase-1", "2026-10-01", 100, 2.5, "CODE-1", "catalog-1"],
      ["purchase-conflict", "2026-10-02", 200, 3, "CODE-1", "catalog-2"],
      ["purchase-native-only", "2026-10-03", 50, 1, null, "catalog-2"],
    ] },
    { sheetId: 3, title: "C_Facturacion", headers: ["Id_Factura", "Fecha", "Total_Facturado", "Tipo_Moneda", "Cliente", "Estado"], rows: [
      ["invoice-1", "2026-10-01", 100, "ARS", "member-1", "Cobrado"],
    ] },
    { sheetId: 4, title: "C_Detalle_Fact", headers: ["Id_Detalle", "Id_Factura", "Fecha", "Valor_Total", "Cantidad_Gr", "Artículo"], rows: [
      ["detail-1", "invoice-1", "2026-10-01", 100, 1.5, "purchase-1"],
    ] },
    { sheetId: 5, title: "Mov_Stock1", headers: ["ID_Mov_Stock_Total", "Fecha_Movimiento_Stock", "Tipo_Registro_Mercaderia", "Cantidad_Gr", "Mercaderia_ID", "Id_Detalle_Ref"], rows: [
      ["stock-entry", "2026-10-01", "Entrada", 8.25, "purchase-1", null],
      ["stock-sale", "2026-10-02", "Venta", 1.5, null, "detail-1"],
      ["stock-waste", "2026-10-03", "Merma", 0.25, "purchase-1", null],
      ["stock-unmatched", "2026-10-04", "Salida", 0.4, "missing-merchandise", null],
    ] },
  ];
  const headers = sheetInputs.map((sheet) => ({ sheetId: sheet.sheetId, title: sheet.title, mode: "grid", hidden: false,
    headerRow: 1, gridRows: sheet.rows.length + 1, gridColumns: sheet.headers.length,
    columns: sheet.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false })),
    pageCount: 1, safeColumnIndexes: sheet.headers.map((_, index) => index + 1), omittedColumnIndexes: [] }));
  const pages = sheetInputs.map((sheet) => {
    const rows = sheet.rows.map((values, rowIndex) => ({ sourceRow: rowIndex + 2,
      cells: values.map((value, index) => value === null ? { columnIndex: index + 1 }
        : { columnIndex: index + 1, effectiveValue: typeof value === "number" ? { numberValue: value } : { stringValue: String(value) } }),
      unresolvedFormulaCells: [], rowHash: "c".repeat(64) }));
    return { schemaVersion: "appsheet-sheet-page/v1", spreadsheetId: "synthetic-spreadsheet", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sheet: { sheetId: sheet.sheetId, title: sheet.title, mode: "grid", hidden: false, headerRow: 1, gridRows: sheet.rows.length + 1, gridColumns: sheet.headers.length },
      page: { index: 0, startRow: 2, endRow: sheet.rows.length + 1, a1Ranges: [], safeColumnIndexes: sheet.headers.map((_, index) => index + 1), omittedColumnIndexes: [], cellFields: "effectiveValue" },
      rows, counts: { rowsSerialized: rows.length, formulaCellCount: 0, unresolvedFormulaCount: 0 }, pageHash: "d".repeat(64) };
  });
  const manifestPages = pages.map((page) => ({ path: `pages/${page.sheet.sheetId}-0-2.json`, sheetId: page.sheet.sheetId,
    title: page.sheet.title, pageIndex: 0, startRow: page.page.startRow, endRow: page.page.endRow,
    pageHash: page.pageHash, verifiedPageHash: page.pageHash, stable: true, counts: page.counts }));
  const dataRecordCount = sheetInputs.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  const capture = {
    directory: "/synthetic/private-capture", mode: "stable",
    manifest: { captureId: "appsreal-stock-fixture", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      manifestHash: "a".repeat(64), dataHash: "b".repeat(64), definitionHash: null,
      spreadsheetId: "synthetic-spreadsheet", metadataHash: "c".repeat(64), headersHash: "d".repeat(64),
      firstReadAt: "2026-10-09T10:00:00.000Z", verificationStartedAt: "2026-10-09T10:01:00.000Z",
      verificationCompletedAt: "2026-10-09T10:02:00.000Z", cutoffAt: "2026-10-09T10:03:00.000Z", timestampGaps: [],
      stability: { stable: true }, dataSheetCount: sheetInputs.length, dataPageCount: pages.length, dataRecordCount,
      dataFormulaCount: 0, dataUnresolvedFormulaCount: 0, pages: manifestPages,
      coverage: { sheets: sheetInputs.map((sheet) => ({ sheetId: sheet.sheetId, formulaCellCount: 0, unresolvedFormulaCount: 0 })) } },
    headers: { schemaVersion: "appsheet-sheet-headers/v1", spreadsheetId: "synthetic-spreadsheet", sheets: headers },
    pages, pagesBySheet: new Map(), deltaEvidence: [],
  } as unknown as LoadedAppSheetHistoryCapture;
  const sourceSha256 = "1".repeat(64), descriptorSha256 = "2".repeat(64);
  const definition = { inventory: { source: { sha256: sourceSha256 }, descriptorSha256,
    app: { id: APPSHEET_EXPECTED_LIVE_APP_ID }, sections: [], observedCounts: {} },
    fileSha256: "3".repeat(64), sourceSha256, descriptorSha256,
    appliedDefinitionHash: sha256(canonicalJson({ sourceSha256, descriptorSha256 })), identityState: "verified" } as unknown as AppSheetHistoryDefinition;

  const prepared = prepareAppSheetHistoryProjection(capture, definition);
  const facts = prepared.persistedFacts;
  const stockFacts = facts.filter((fact) => fact.kind === "stock");
  assert.equal(stockFacts.length, 4);
  const sale = stockFacts.find((fact) => fact.sourceKey === "stock-sale");
  assert.ok(sale);
  assert.equal(sale.quantity?.toString(), "1.5");
  assert.equal(sale.unit, "g");
  assert.equal(sale.unitState, "known");
  const saleAttributes = sale.attributes as unknown as { financialEffect: string; sourceClassification: { field: string; value: string; state: string }; relationships: Array<{ sourceField: string; status: string; targetSourceKey: string | null }> };
  assert.equal(saleAttributes.financialEffect, "historical-fact-only");
  assert.deepEqual(saleAttributes.sourceClassification, { field: "Tipo_Registro_Mercaderia", value: "Venta", state: "known" });
  assert.deepEqual(saleAttributes.relationships.map(({ sourceField, status, targetSourceKey }) => ({ sourceField, status, targetSourceKey })), [
    { sourceField: "Mercaderia_ID", status: "not_provided", targetSourceKey: null },
    { sourceField: "Id_Detalle_Ref", status: "unique", targetSourceKey: "detail-1" },
  ]);
  const detail = prepared.persistedRecords.find((record) => record.sourceTable === "C_Detalle_Fact" && record.sourceKey === "detail-1");
  assert.ok(detail);
  const detailAttributes = facts.find((fact) => fact.sourceRecordId === detail.id)!.attributes as unknown as { relationships: Array<{ sourceField: string; status: string; targetSourceKey: string | null }> };
  assert.ok(detailAttributes.relationships.some((link) => link.sourceField === "Artículo" && link.status === "unique" && link.targetSourceKey === "purchase-1"));

  const purchase = prepared.persistedRecords.find((record) => record.sourceTable === "C_Mercaderia" && record.sourceKey === "purchase-1");
  assert.ok(purchase);
  const purchaseFact = facts.find((fact) => fact.sourceRecordId === purchase.id)!;
  assert.equal(purchaseFact.quantity?.toString(), "2.5");
  assert.equal(purchaseFact.unit, null, "purchase quantities without a declared source unit remain unknown");
  assert.equal(purchaseFact.unitState, "absent");
  const purchaseAttributes = purchaseFact.attributes as unknown as { relationships: Array<{ sourceField: string; status: string; targetSourceKey: string | null }> };
  assert.ok(purchaseAttributes.relationships.some((link) => link.sourceField === "Variedad_Cann" && link.status === "unique" && link.targetSourceKey === "catalog-1"));
  assert.ok(purchaseAttributes.relationships.some((link) => link.sourceField === "Codigo_Detalle" && link.status === "unique" && link.targetSourceKey === "catalog-1"));
  const nativeOnly = prepared.persistedRecords.find((record) => record.sourceTable === "C_Mercaderia" && record.sourceKey === "purchase-native-only");
  assert.ok(nativeOnly);
  const nativeOnlyFact = facts.find((fact) => fact.sourceRecordId === nativeOnly.id)!;
  const nativeOnlyLinks = (nativeOnlyFact.attributes as unknown as { relationships: Array<{ sourceField: string; status: string; targetSourceKey: string | null }> }).relationships;
  assert.ok(nativeOnlyLinks.some((link) => link.sourceField === "Variedad_Cann" && link.status === "unique" && link.targetSourceKey === "catalog-2"));
  assert.ok(nativeOnlyLinks.some((link) => link.sourceField === "Codigo_Detalle" && link.status === "missing"));
  assert.ok(prepared.exceptions.some((exception) => exception.sourceRecordId === nativeOnly.id && exception.kind === "foreign_relationship_missing" && exception.severity === "blocking"));

  const conflictingPurchase = prepared.persistedRecords.find((record) => record.sourceTable === "C_Mercaderia" && record.sourceKey === "purchase-conflict");
  assert.ok(conflictingPurchase);
  assert.ok(prepared.exceptions.some((exception) => exception.sourceRecordId === conflictingPurchase.id && exception.kind === "foreign_relationship_conflict" && exception.severity === "blocking"));
  const unmatched = stockFacts.find((fact) => fact.sourceKey === "stock-unmatched");
  assert.ok(unmatched);
  assert.ok(prepared.exceptions.some((exception) => exception.sourceRecordId === unmatched.sourceRecordId && exception.kind === "source_classification_unresolved" && exception.severity === "blocking"));
  assert.ok(prepared.exceptions.some((exception) => exception.sourceRecordId === unmatched.sourceRecordId && exception.kind === "foreign_relationship_missing" && exception.severity === "blocking"));
  assert.equal(appSheetHistoryProjectionReport(prepared).cutoverEligible, false);
  assert.equal(prepared.metrics.kindCounts.stock, 4);
});

function stageFixture(): PreparedAppSheetHistoryProjection {
  return {
    snapshotId: "00000000-0000-5000-8000-000000000001",
    capture: {
      mode: "preliminary-delta",
      manifest: { captureId: pendingCapture.captureId, manifestHash: pendingCapture.manifestHash, dataHash: "b".repeat(64), definitionHash: null },
      deltaEvidence: [],
    },
    definition: {
      appliedDefinitionHash: "c".repeat(64), sourceSha256: "1".repeat(64), descriptorSha256: "2".repeat(64),
      fileSha256: "3".repeat(64), identityState: "verified", inventory: {},
    },
    projectionHash: "d".repeat(64),
    coverage: { effects: { cash: false } }, controls: {}, persistedRecords: [], persistedFacts: [], exceptions: [],
    metrics: { kindCounts: { cash: 2 } } as PreparedAppSheetHistoryProjection["metrics"],
  } as unknown as PreparedAppSheetHistoryProjection;
}

function baseStageReview() {
  return {
    reviewKind: "independent-technical" as const,
    captureId: pendingCapture.captureId,
    manifestHash: pendingCapture.manifestHash,
    definitionHash: "c".repeat(64),
    projectionKind: "history" as const,
    projectionHash: "d".repeat(64),
    commitSha: "e".repeat(40),
    importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    target: "isolated-test" as const,
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    reviewer: "independent-reviewer",
    approved: true as const,
    reviewedAt: "2026-10-09T12:00:00.000Z",
    findings: [],
  };
}

function stageReview() {
  return {
    ...baseStageReview(),
    schemaVersion: 2 as const,
    target: "isolated-test" as const,
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
  };
}

function legacyStageReview() {
  return { ...baseStageReview(), schemaVersion: 1 as const };
}

function populatedStageFixture(): PreparedAppSheetHistoryProjection {
  const fixture = stageFixture();
  const records = [
    {
      id: "00000000-0000-5000-8000-000000000011", snapshotId: fixture.snapshotId,
      sourceTable: "A_Table", sourceKey: "key-a", sourceRow: 2, fileHash: "a".repeat(64), contentHash: "b".repeat(64),
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      original: { columns: [{ coordinate: "A2", header: "metadata", value: { effectiveValue: { stringValue: "A" } } }] },
      normalized: { columns: [{ coordinate: "A2", header: "metadata", value: "A" }] }, treatment: "archive_only",
    },
    {
      id: "00000000-0000-5000-8000-000000000012", snapshotId: fixture.snapshotId,
      sourceTable: "B_Table", sourceKey: "key-b", sourceRow: 3, fileHash: "a".repeat(64), contentHash: "c".repeat(64),
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      original: { columns: [{ coordinate: "A3", header: "metadata", value: { effectiveValue: { stringValue: "B" } } }] },
      normalized: { columns: [{ coordinate: "A3", header: "metadata", value: "B" }] }, treatment: "archive_only",
    },
  ];
  const facts = records.map((record, index) => ({
    id: `00000000-0000-5000-8000-00000000002${index + 1}`, snapshotId: fixture.snapshotId,
    sourceRecordId: record.id, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
    sourceHash: record.contentHash, mappingId: APPSHEET_HISTORY_MAPPING_ID, kind: "archive", occurredOn: null,
    dateState: "not-applicable", currency: null, currencyState: "not-applicable", unit: null, unitState: "not-applicable",
    amountMinor: BigInt(12_345 + index), amountState: "known", quantity: new Prisma.Decimal(index === 0 ? "1.230000000001" : "2.500000000000"),
    quantityState: "known", attributes: { ordered: ["first", "second"], nested: { exact: "1.230000000001" } },
    createdBy: "codex:appsheet-history-stage",
  }));
  const exceptions = [
    {
      id: "00000000-0000-5000-8000-000000000033", sourceRecordId: null, kind: "global_review", severity: "review",
      description: "synthetic global exception", resolution: { evidence: ["captured", "stable"] },
    },
    {
      id: "00000000-0000-5000-8000-000000000031", sourceRecordId: records[0]!.id, kind: "source_review", severity: "review",
      description: "synthetic unresolved exception", resolution: null,
    },
    {
      id: "00000000-0000-5000-8000-000000000032", sourceRecordId: records[1]!.id, kind: "source_review", severity: "review",
      description: "synthetic resolved-evidence exception", resolution: { reference: "fixture" },
    },
  ];
  return { ...fixture, persistedRecords: records, persistedFacts: facts, exceptions } as unknown as PreparedAppSheetHistoryProjection;
}

type MemoryHistoryRows = {
  sourceRecords: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
};

function copyJsonValue(value: unknown): unknown {
  if (value === Prisma.DbNull) return null;
  return value === null || value === undefined ? value : structuredClone(value);
}

function copyStoredSourceRecord(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, original: copyJsonValue(row.original), normalized: copyJsonValue(row.normalized) };
}

function copyStoredFact(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    quantity: row.quantity === null || row.quantity === undefined ? row.quantity : new Prisma.Decimal(String(row.quantity)),
    attributes: copyJsonValue(row.attributes),
  };
}

function copyStoredException(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, resolution: copyJsonValue(row.resolution) };
}

function memoryHistoryClient() {
  const rows: MemoryHistoryRows = { sourceRecords: [], facts: [], exceptions: [] };
  let snapshot: Record<string, unknown> | null = null;
  let operationObject: Record<string, unknown> | null = null;
  let audit: Record<string, unknown> | null = null;
  let writes = 0;
  const sourceBatchBytes: number[] = [];
  const tx = {
    user: { findUnique: async () => ({ id: "authorized-user", role: "admin", active: true }) },
    operationAccess: { findUnique: async () => ({ enabled: true, capabilities: ["imports.write"] }) },
    legacyImportSnapshot: {
      findUnique: async () => snapshot,
      create: async ({ data }: { data: Record<string, unknown> }) => { snapshot = data; writes++; },
    },
    $executeRaw: async (query: { values: unknown[] }) => {
      const serialized = String(query.values[0]);
      sourceBatchBytes.push(Buffer.byteLength(serialized, "utf8"));
      const batch = JSON.parse(serialized) as Array<Record<string, unknown>>;
      rows.sourceRecords.push(...batch.map(copyStoredSourceRecord));
      writes += batch.length;
      return batch.length;
    },
    $queryRaw: async () => rows.sourceRecords.slice().reverse().map(({ original, normalized, ...record }) => ({
      ...record, originalText: JSON.stringify(original), normalizedText: JSON.stringify(normalized),
    })),
    legacySourceRecord: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.sourceRecords.push(...data.map(copyStoredSourceRecord));
        writes += data.length;
        return { count: data.length };
      },
      findMany: async () => rows.sourceRecords.slice().reverse().map(copyStoredSourceRecord),
    },
    legacyHistoricalFact: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.facts.push(...data.map(copyStoredFact)); writes += data.length; return { count: data.length };
      },
      findMany: async () => rows.facts.slice().reverse().map(copyStoredFact),
    },
    legacyException: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.exceptions.push(...data.map((exception) => copyStoredException({ ...exception,
          status: "open", resolvedBy: null, resolvedAt: null }))); writes += data.length; return { count: data.length };
      },
      findMany: async () => rows.exceptions.slice().reverse().map(copyStoredException),
    },
    operationObject: {
      create: async ({ data }: { data: Record<string, unknown> }) => { operationObject = data; writes++; },
      findUnique: async () => operationObject,
    },
    operationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { audit = data; writes++; },
      findFirst: async () => audit,
    },
  };
  const client = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  return {
    client, rows, sourceBatchBytes, get snapshot() { return snapshot; }, get writes() { return writes; },
  };
}

test("invalid review is rejected before opening a write transaction", async () => {
  let transactionCount = 0;
  const client = { $transaction: async () => { transactionCount++; throw new Error("must_not_start"); } } as unknown as PrismaClient;
  await assert.rejects(stageAppSheetHistoryProjection(stageFixture(), {
    actorId: "authorized-user", technicalReview: { ...stageReview(), projectionHash: "f".repeat(64) },
    commitSha: "e".repeat(40), allowStagedDelta: true, target: "isolated-test",
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  }, client), (error) => error instanceof AppSheetHistoryStageError && error.code === "technical_review_invalid");
  assert.equal(transactionCount, 0);
});

test("failed staged write is rolled back by the serializable transaction boundary", async () => {
  const rows: string[] = [];
  let rolledBack = false;
  let committed = false;
  const tx = {
    user: { findUnique: async () => ({ id: "authorized-user", role: "admin", active: true }) },
    operationAccess: { findUnique: async () => ({ enabled: true, capabilities: ["imports.write"] }) },
    legacyImportSnapshot: {
      findUnique: async () => null,
      create: async () => { rows.push("snapshot"); },
    },
    $executeRaw: async (query: { values: unknown[] }) => {
      rows.push("source-records");
      return (JSON.parse(String(query.values[0])) as unknown[]).length;
    },
    legacySourceRecord: {
      createMany: async ({ data }: { data: unknown[] }) => {
        rows.push("source-records");
        return { count: data.length };
      },
    },
    legacyHistoricalFact: { createMany: async () => { rows.push("historical-facts"); } },
    legacyException: { createMany: async () => { rows.push("exceptions"); } },
    operationObject: { create: async () => { rows.push("operation-object"); } },
    operationAudit: { create: async () => { rows.push("audit"); throw new Error("injected_audit_failure"); } },
  };
  const client = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      try {
        const result = await callback(tx);
        committed = true;
        return result;
      } catch (error) {
        rows.length = 0;
        rolledBack = true;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  await assert.rejects(stageAppSheetHistoryProjection(populatedStageFixture(), {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test",
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  }, client), /injected_audit_failure/);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
  assert.deepEqual(rows, []);
});

test("replaying populated history compares persisted rows independent of query order", async () => {
  const prepared = populatedStageFixture();
  const memory = memoryHistoryClient();
  const options = {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test" as const,
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  };

  const first = await stageAppSheetHistoryProjection(prepared, options, memory.client);
  assert.equal(first.replay, false);
  const writesAfterStage = memory.writes;
  assert.ok(writesAfterStage > 0);
  assert.equal(memory.rows.sourceRecords.length, 2);
  assert.equal(memory.rows.facts.length, 2);
  assert.equal(memory.rows.exceptions.length, 3);
  assert.equal(memory.snapshot?.status, "staged");
  assert.equal(memory.snapshot?.reviewedBy, null);
  assert.equal(memory.rows.exceptions.find((exception) => exception.sourceRecordId === null)?.resolution !== null, true);
  assert.equal(memory.rows.exceptions.some((exception) => exception.sourceRecordId !== null && exception.resolution === null), true);

  const replay = await stageAppSheetHistoryProjection(prepared, options, memory.client);
  assert.equal(replay.replay, true);
  assert.equal(memory.writes, writesAfterStage);
  assert.equal(memory.snapshot?.status, "staged");
  assert.equal(memory.snapshot?.reviewedBy, null);

  let mismatchedTargetTransactions = 0;
  const mismatchClient = { $transaction: async () => { mismatchedTargetTransactions++; throw new Error("must_not_start"); } } as unknown as PrismaClient;
  await assert.rejects(stageAppSheetHistoryProjection(prepared, {
    ...options, destinationIdentity: OTHER_HISTORY_TEST_DESTINATION_ID,
  }, mismatchClient), (error) => error instanceof AppSheetHistoryStageError && error.code === "technical_review_invalid");
  assert.equal(mismatchedTargetTransactions, 0, "un destino distinto se rechaza antes de abrir la transacción");
  assert.equal(memory.writes, writesAfterStage, "el rechazo no modifica el staging ya replayable");
  assert.equal(HISTORY_TEST_DESTINATION_ID, appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://other-user:other-password@127.0.0.1:5432/bombo_ui_history?schema=history&sslmode=disable")),
  "las credenciales y TLS no forman parte de la identidad destino");
  assert.notEqual(HISTORY_TEST_DESTINATION_ID, OTHER_HISTORY_TEST_DESTINATION_ID,
    "el schema PostgreSQL distingue destinos dentro de la misma base");
  assert.equal(appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history")),
  appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=public")),
  "el schema omitido usa el default de Prisma `public`");
  assert.notEqual(appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=public")),
  appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=Public")),
  "los nombres de schema mantienen la distinción por mayúsculas");
  assert.throws(() => appSheetDatabaseDestinationIdentity("isolated-test",
    new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history?schema=history&host=replica.example")),
  /appsheet_database_target_ambiguous/);

});

test("unbound and isolated-bound reviews are rejected for production before opening a transaction", async () => {
  const stablePrepared = stageFixture();
  stablePrepared.capture = { ...stablePrepared.capture, mode: "stable" };
  let transactionCount = 0;
  const client = { $transaction: async () => { transactionCount++; throw new Error("must_not_start"); } } as unknown as PrismaClient;
  const productionOptions = {
    actorId: "authorized-user", commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "production", destinationIdentity: PRODUCTION_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  } as const;
  await assert.rejects(stageAppSheetHistoryProjection(stablePrepared, {
    ...productionOptions, technicalReview: legacyStageReview(),
  }, client), (error) => error instanceof AppSheetHistoryStageError && error.code === "technical_review_invalid");
  await assert.rejects(stageAppSheetHistoryProjection(stablePrepared, {
    ...productionOptions, technicalReview: stageReview(),
  }, client), (error) => error instanceof AppSheetHistoryStageError && error.code === "technical_review_invalid");
  assert.equal(transactionCount, 0);
});

test("history source batches respect the byte cap and replay the exact split without duplicates", async () => {
  const prepared = stageFixture();
  const payload = "x".repeat(2_200_000);
  prepared.persistedRecords = [11, 12].map((sourceRow) => ({
    id: `00000000-0000-5000-8000-${String(sourceRow).padStart(12, "0")}`,
    snapshotId: prepared.snapshotId,
    sourceTable: "Large_Table",
    sourceKey: `large-${sourceRow}`,
    sourceRow,
    fileHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    original: { payload },
    normalized: { payload },
    treatment: "archive_only",
  }));
  const memory = memoryHistoryClient();
  const options = {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test" as const,
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  };

  const staged = await stageAppSheetHistoryProjection(prepared, options, memory.client);
  assert.equal(staged.replay, false);
  assert.equal(memory.sourceBatchBytes.length, 2, "el límite de bytes separa estas dos filas aunque sean menos de 500");
  assert.ok(memory.sourceBatchBytes.every((bytes) => bytes <= 8 * 1024 * 1024));
  assert.ok(memory.sourceBatchBytes.reduce((sum, bytes) => sum + bytes, 0) > 8 * 1024 * 1024);
  assert.deepEqual(memory.rows.sourceRecords.map((row) => row.id), prepared.persistedRecords.map((row) => row.id));

  const writesAfterStage = memory.writes;
  const replay = await stageAppSheetHistoryProjection(prepared, options, memory.client);
  assert.equal(replay.replay, true);
  assert.equal(memory.writes, writesAfterStage, "el replay no duplica filas ni efectos del staging");
  assert.equal(memory.sourceBatchBytes.length, 2);
});

test("a single over-budget history source row is rejected before staged writes", async () => {
  const prepared = stageFixture();
  const payload = "x".repeat(4_300_000);
  prepared.persistedRecords = [{
    id: "00000000-0000-5000-8000-000000000011",
    snapshotId: prepared.snapshotId,
    sourceTable: "Large_Table",
    sourceKey: "oversized-row",
    sourceRow: 2,
    fileHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    original: { payload },
    normalized: { payload },
    treatment: "archive_only",
  }];
  const memory = memoryHistoryClient();
  await assert.rejects(stageAppSheetHistoryProjection(prepared, {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test", destinationIdentity: HISTORY_TEST_DESTINATION_ID,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  }, memory.client), (error) => error instanceof AppSheetHistoryStageError && error.code === "history_source_record_too_large");
  assert.equal(memory.writes, 0);
  assert.equal(memory.snapshot, null);
  assert.deepEqual(memory.rows.sourceRecords, []);
});

test("replaying same-ID history content tampering is rejected without writes", async () => {
  const tamperCases = [
    {
      name: "original JSON",
      apply(rows: MemoryHistoryRows) {
        const record = rows.sourceRecords[0]!;
        const original = record.original as { columns: Array<Record<string, unknown>> };
        original.columns[0]!.value = { effectiveValue: { stringValue: "tampered" } };
      },
    },
    {
      name: "exact fact amount",
      apply(rows: MemoryHistoryRows) { rows.facts[0]!.amountMinor = 99_999n; },
    },
    {
      name: "JSON array order",
      apply(rows: MemoryHistoryRows) {
        const attributes = rows.facts[0]!.attributes as { ordered: string[] };
        attributes.ordered.reverse();
      },
    },
    {
      name: "exception description",
      apply(rows: MemoryHistoryRows) { rows.exceptions[0]!.description = "tampered"; },
    },
  ];
  for (const tamper of tamperCases) {
    const prepared = populatedStageFixture();
    const memory = memoryHistoryClient();
    const options = {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test" as const,
    destinationIdentity: HISTORY_TEST_DESTINATION_ID,
      backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
    };
    const first = await stageAppSheetHistoryProjection(prepared, options, memory.client);
    assert.equal(first.replay, false, `${tamper.name}: primer stage`);
    tamper.apply(memory.rows);
    const writesBeforeReplay = memory.writes;
    await assert.rejects(stageAppSheetHistoryProjection(prepared, options, memory.client), (error) =>
      error instanceof AppSheetHistoryStageError && error.code === "existing_history_snapshot_incomplete_or_changed",
      `${tamper.name}: replay de contenido cambiado debe rechazarse`);
    assert.equal(memory.writes, writesBeforeReplay, `${tamper.name}: el rechazo no escribe estado`);
  }
});

test("CLI apply refuses a dirty checkout before reading the source or opening a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bombo-history-cli-"));
  const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env: gitEnvironment, stdio: "ignore" });
  const args = [
    "--apply", "--allow-staged-delta", "--actor-id", "authorized-user",
    "--review", "review.json", "--backup-reference", "/unused/backup",
  ];
  try {
    git("init", "--quiet");
    await writeFile(join(directory, "fixture.txt"), "committed fixture\n");
    git("add", "fixture.txt");
    git("-c", "user.name=Migration test", "-c", "user.email=migration-test@example.invalid", "commit", "--quiet", "-m", "fixture");
    const clean = await runAppSheetHistoryCli(args, directory);
    assert.equal(clean.code, 1);
    assert.deepEqual(JSON.parse(clean.output), { status: "error", code: "private_directory_permissions_invalid" });
    await writeFile(join(directory, "fixture.txt"), "uncommitted fixture\n");
    const dirty = await runAppSheetHistoryCli(args, directory);
    assert.equal(dirty.code, 1);
    assert.deepEqual(JSON.parse(dirty.output), { status: "error", code: "apply_requires_clean_committed_worktree" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
