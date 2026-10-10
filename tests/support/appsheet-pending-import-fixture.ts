import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../../shared/operations/appsheet-history.js";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
} from "../../server/operations/appsheet-canonical.js";
import type {
  AppSheetHistoryDefinition,
  LoadedAppSheetHistoryCapture,
} from "../../server/operations/appsheet-history.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** A stable, synthetic four-row source used only by the PostgreSQL contract test. */
export function syntheticPendingHistorySource(): {
  capture: LoadedAppSheetHistoryCapture;
  definition: AppSheetHistoryDefinition;
  invoiceNumber: string;
  invoiceSourceKey: string;
  deliverySourceKey: string;
  historicalAddress: string;
} {
  const now = Date.now();
  const firstReadAt = new Date(now - 180_000).toISOString();
  const verificationStartedAt = new Date(now - 120_000).toISOString();
  const verificationCompletedAt = new Date(now - 60_000).toISOString();
  const cutoffAt = new Date(now - 30_000).toISOString();
  const spreadsheetId = "synthetic-appsheet-pending-contract";
  const invoiceSourceKey = `legacy-invoice-${sha256(`${now}:invoice`).slice(0, 12)}`;
  const invoiceNumber = `AR-2026-${sha256(`${now}:number`).slice(0, 8).toUpperCase()}`;
  const deliverySourceKey = `legacy-moto-${sha256(`${now}:moto`).slice(0, 12)}`;
  const paymentSourceKey = `legacy-payment-${sha256(`${now}:payment`).slice(0, 12)}`;
  const detailSourceKey = `legacy-line-${sha256(`${now}:detail`).slice(0, 12)}`;
  const historicalAddress = "Dirección histórica sintética 123, Salta";
  const sourceSheets = [
    {
      sheetId: 11,
      title: "C_Facturacion",
      headers: ["Id_Factura", "N_factura", "Fecha", "Total_Facturado", "Cantidad_Gr", "Tipo_Moneda", "Domicilio"],
      values: [invoiceSourceKey, invoiceNumber, "2026-10-08", 100, 1, "ARS", historicalAddress],
    },
    {
      sheetId: 12,
      title: "C_Detalle_Fact",
      headers: ["Id_Detalle", "Id_Factura", "Fecha", "Valor_Total", "Cantidad_Gr"],
      values: [detailSourceKey, invoiceSourceKey, "2026-10-08", 100, 1],
    },
    {
      sheetId: 13,
      title: "Movimiento_Nueva",
      headers: ["ID_Movimiento_Unique", "ID_Movimiento", "Fecha", "Tipo_Movimiento", "Concepto", "Caja", "Monto", "Tipo_Moneda", "Afecta_Resultado", "Tabla_Origen", "Origen_ID", "ID_Origen_2"],
      values: [paymentSourceKey, "legacy-payment-number", "2026-10-08", "Ingreso", "Pago parcial histórico", "Caja sintética", 40, "ARS", true, "venta", invoiceSourceKey, invoiceNumber],
    },
    {
      sheetId: 14,
      title: "C_Moto",
      headers: ["Id_Moto", "N_Factura", "Fecha", "Entrega_completada", "Moto_Ruta_ID"],
      values: [deliverySourceKey, invoiceNumber, "2026-10-08", false, ""],
    },
  ] as const;

  const dataPages = sourceSheets.map((source) => {
    const columns = source.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false }));
    const cells = source.values.map((value, index) => ({
      columnIndex: index + 1,
      effectiveValue: typeof value === "boolean" ? { boolValue: value }
        : typeof value === "number" ? { numberValue: value } : { stringValue: value },
    }));
    const safeColumnIndexes = columns.map((column) => column.columnIndex);
    const rowBody = { sourceRow: 2, cells, unresolvedFormulaCells: [], safeColumnIndexes };
    const row = { ...rowBody, rowHash: sha256(canonicalJson(rowBody)) };
    const counts = { rowsWithValues: 1, rowsSerialized: 1, formulaCellCount: 0, unresolvedFormulaCount: 0 };
    const path = `pages/${source.sheetId}-0-2.json`;
    const pageBody = {
      schemaVersion: "appsheet-sheet-page/v1", spreadsheetId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sheet: { sheetId: source.sheetId, title: source.title, mode: "grid", hidden: false, headerRow: 1,
        gridRows: 2, gridColumns: source.headers.length },
      page: { index: 0, startRow: 2, endRow: 2, a1Ranges: [], safeColumnIndexes,
        omittedColumnIndexes: [], cellFields: "effectiveValue" },
      rows: [row], counts,
    };
    const pageHash = sha256(canonicalJson(pageBody));
    return {
      header: {
        sheetId: source.sheetId, title: source.title, mode: "grid", hidden: false, headerRow: 1,
        gridRows: 2, gridColumns: source.headers.length, columns,
        pageCount: 1, safeColumnIndexes: columns.map((column) => column.columnIndex), omittedColumnIndexes: [],
      },
      page: {
        schemaVersion: "appsheet-sheet-page/v1", spreadsheetId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
        sheet: { sheetId: source.sheetId, title: source.title, mode: "grid", hidden: false, headerRow: 1, gridRows: 2, gridColumns: source.headers.length },
        page: pageBody.page,
        rows: [row], counts, pageHash,
      },
      ref: { path, sheetId: source.sheetId, title: source.title, pageIndex: 0, startRow: 2, endRow: 2,
        pageHash, verifiedPageHash: pageHash, stable: true, counts },
    };
  });
  const pageRefs = dataPages.map(({ ref }) => ({
    path: ref.path, sheetId: ref.sheetId, title: ref.title, pageIndex: ref.pageIndex, startRow: ref.startRow, endRow: ref.endRow,
    pageHash: ref.pageHash, verifiedPageHash: ref.verifiedPageHash, stable: ref.stable, counts: ref.counts,
  }));
  const dataHash = sha256(canonicalJson(pageRefs.map(({ path, sheetId, pageIndex, startRow, endRow, pageHash, counts }) =>
    ({ path, sheetId, pageIndex, startRow, endRow, pageHash, counts }))));
  const dataCoverage = {
    metadataStable: true, headersStableAll: true, totalPages: dataPages.length, rowsWithValues: dataPages.length,
    bodySheetsCaptured: dataPages.length, dataRecordCount: dataPages.length, formulaCellCount: 0,
    failedPages: 0, changedPages: 0, unresolvedFormulaCount: 0,
    sheets: dataPages.map(({ ref }) => ({ sheetId: ref.sheetId, title: ref.title, mode: "grid", hidden: false,
      pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true,
      bodyExcluded: false, formulaCellCount: 0, unresolvedFormulaCount: 0 })),
  };
  const stability = {
    stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true, scanComplete: true,
    firstPassPages: dataPages.length, verifiedPages: dataPages.length, matchedPages: dataPages.length, changedPages: 0,
    failedPages: 0, missingPages: 0, unresolvedFormulaCount: 0, sourceWriteDetected: false, bodyExcludedSheets: [],
  };
  const headers = {
    schemaVersion: "appsheet-sheet-headers/v1", spreadsheetId,
    sheets: dataPages.map(({ header }) => header),
  };
  const metadataSpreadsheet = { spreadsheetId };
  const metadataHash = sha256(canonicalJson(metadataSpreadsheet));
  const headersHash = sha256(canonicalJson(headers));
  const coverage = { ...dataCoverage, sheets: dataCoverage.sheets.map((sheet) => ({ ...sheet, formulaCellCount: 0, unresolvedFormulaCount: 0 })) };
  const evidence = { verificationPass2: { path: "verification/pass2.json", sha256: sha256("synthetic pass-two verification") } };
  const hashContract = { algorithm: "sha256", canonicalization: "canonical-json-v1" };
  const manifestHash = sha256(canonicalJson({
    schemaVersion: "appsheet-capture-manifest/v1", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    sourceId: spreadsheetId, spreadsheetId, metadataHash, headersHash, dataHash, definitionHash: null,
    stability, coverage, pages: pageRefs, evidence, hashContract,
  }));
  const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
  const capture = {
    directory: "/synthetic/private-capture",
    mode: "stable",
    manifest: {
      schemaVersion: "appsheet-capture-manifest/v1", captureId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sourceId: spreadsheetId, spreadsheetId, manifestHash, dataHash,
      metadataHash, headersHash, definitionHash: null,
      firstReadAt, verificationStartedAt, verificationCompletedAt, cutoffAt, timestampGaps: [], stability,
      dataSheetCount: dataPages.length, dataPageCount: dataPages.length, dataRecordCount: dataPages.length,
      dataFormulaCount: 0, dataUnresolvedFormulaCount: 0, pages: pageRefs,
      definitionCoverage: null, definitionTableCount: null, definitionColumnCount: null, definitionSliceCount: null,
      definitionViewCount: null, definitionActionCount: null, definitionBotCount: null,
      definitionWorkflowRuleCount: null, definitionFormatRuleCount: null,
      coverage, evidence, hashContract,
    },
    metadata: { schemaVersion: "appsheet-source-metadata/v1", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, spreadsheet: metadataSpreadsheet },
    headers,
    pages: dataPages.map(({ page }) => page),
    pagesBySheet: new Map(),
    deltaEvidence: [],
  } as unknown as LoadedAppSheetHistoryCapture;

  const sourceSha256 = sha256("synthetic AppSheet definition source");
  const descriptorSha256 = sha256("synthetic AppSheet definition descriptor");
  const inventoryWithoutDescriptor = {
    schemaVersion: 1,
    parserVersion: "bombo-appsheet-definition/1.2.0",
    source: { sha256: sourceSha256, byteLength: 128, encoding: "utf-8" },
    app: { id: APPSHEET_EXPECTED_LIVE_APP_ID, name: "Synthetic AppSheet contract", version: "fixture-1",
      deploymentState: "synthetic", generatedAt: "2026-10-10T00:00:00.000Z" },
    declaredCounts: {},
    observedCounts: {},
    descriptorSha256: "",
    coverage: [],
    sections: [{ category: "tables", title: "Tables", sectionPath: ["Tables"], evidenceId: "synthetic-table-inventory",
      records: sourceSheets.map((sheet) => ({ category: "tables", name: sheet.title, fields: [], evidenceId: `synthetic-${sheet.title}`, children: [] })) }],
    evidence: [],
    redactedFieldCount: 0,
    warnings: [],
  };
  const appliedDescriptorSha256 = sha256(canonicalJson(inventoryWithoutDescriptor));
  const inventory = { ...inventoryWithoutDescriptor, descriptorSha256: appliedDescriptorSha256 };
  const definition = {
    inventory,
    fileSha256: sha256("synthetic AppSheet definition file"), sourceSha256, descriptorSha256: appliedDescriptorSha256,
    appliedDefinitionHash: sha256(canonicalJson({ sourceSha256, descriptorSha256: appliedDescriptorSha256 })), identityState: "verified",
  } as unknown as AppSheetHistoryDefinition;

  return { capture, definition, invoiceNumber, invoiceSourceKey, deliverySourceKey, historicalAddress };
}
