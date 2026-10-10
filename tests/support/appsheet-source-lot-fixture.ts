import { createHash, randomUUID } from "node:crypto";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID } from "../../shared/operations/appsheet-history.js";
import { APPSHEET_SOURCE_STOCK_APP_ID, APPSHEET_SOURCE_STOCK_FORMULA } from "../../shared/operations/appsheet-source-stock.js";
import { APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../../shared/operations/appsheet-canonical.js";
import { appSheetAppliedDefinitionHash, appSheetDefinitionProductionReadiness, prepareAppSheetMasterProjection } from "../../server/operations/appsheet-canonical.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import type { AppSheetDefinitionInventory } from "../../shared/operations/appsheet-definition.js";
import { definitionInventory as canonicalDefinitionInventory } from "./appsheet-canonical-fixture.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hash = (value: unknown) => sha256(canonicalJson(value));

/**
 * The source rows deliberately model the physical AppSheet tables: C_Mercaderia
 * has no Stock_Actual column. Its value is reproducible only from Mov_Stock1.
 * Dates are preserved as the raw numeric Sheets cell and require the signed
 * DATE definition below. This is a contract fixture, not a source-system export.
 */
export function appSheetSourceStockDefinition(): { inventory: AppSheetDefinitionInventory; appliedDefinitionHash: string } {
  const field = (label: string, semanticKey: string | null, value: string, evidenceId: string) =>
    ({ label, semanticKey, value, state: "observed" as const, evidenceId });
  const stock = {
    category: "columns" as const,
    name: "Stock_Actual",
    evidenceId: "source-lot-stock-column",
    children: [],
    fields: [
      field("Type", "type", "Decimal", "source-lot-stock-type"),
      field("Virtual?", "virtual", "Yes", "source-lot-stock-virtual"),
      field("Read-Only", null, "Yes", "source-lot-stock-read-only"),
      field("App formula", "appFormula", APPSHEET_SOURCE_STOCK_FORMULA, "source-lot-stock-formula"),
    ],
  };
  const delivery = {
    category: "columns" as const,
    name: "Fecha_Entrega",
    evidenceId: "source-lot-delivery-column",
    children: [],
    fields: [
      field("Type", "type", "Date", "source-lot-delivery-type"),
      field("Virtual?", "virtual", "No", "source-lot-delivery-virtual"),
    ],
  };
  const inventory = canonicalDefinitionInventory();
  const sourceBytes = "synthetic-source-lot-appdoc";
  Object.assign(inventory, {
    parserVersion: "bombo-appsheet-definition/1.2.0",
    source: { sha256: sha256(sourceBytes), byteLength: Buffer.byteLength(sourceBytes), encoding: "utf-8" as const },
    app: { id: APPSHEET_SOURCE_STOCK_APP_ID, name: "Synthetic AppSheet", version: "1", deploymentState: "Deployed", generatedAt: "2026-10-09T12:00:00Z" },
    declaredCounts: { columns: 2 },
    observedCounts: { columns: 2 },
    coverage: (["tables", "columns", "slices", "views", "formatRules", "actions", "bots", "workflowRules", "security", "settings", "other"] as const)
      .map((category) => ({ category, state: "matched_declared_count" as const, declaredCount: category === "columns" ? 2 : 0,
        observedCount: category === "columns" ? 2 : 0, missingCount: 0, redactedFieldCount: 0, ambiguousFieldCount: 0,
        evidenceCount: category === "columns" ? 2 : 0, note: "synthetic signed source-lot definition contract" })),
    sections: [{
      category: "columns" as const,
      title: "C_Mercaderia",
      sectionPath: [],
      evidenceId: "source-lot-table",
      records: [{
        category: "columns" as const,
        name: "Schema Name C_Mercaderia_Schema",
        evidenceId: "source-lot-schema",
        fields: [],
        children: [stock, delivery],
      }],
    }],
  });
  inventory.descriptorSha256 = hash({ ...inventory, descriptorSha256: "" });
  return { inventory, appliedDefinitionHash: appSheetAppliedDefinitionHash(inventory) };
}

export type SyntheticSourceLotBotInventory = {
  state: "verified";
  evidenceSha256: string;
  observedCount: 0;
  scope: "synthetic-consumer-precondition-only";
  evidenceReference: "fixture-only; no AppSheet editor evidence";
};

/** Build a clearly synthetic canonical-master precondition for source-lot consumer tests.
 * This artifact is not produced by, and does not certify, `stageAppSheetCanonicalMasters`.
 */
export function appSheetSourceLotCanonicalConsumerFixture(input: {
  projection: ReturnType<typeof prepareAppSheetMasterProjection>;
  botInventory: SyntheticSourceLotBotInventory;
  destinationIdentity: string;
  backupEvidence: { manifestHash: string; snapshotAt: string };
  technicalReview: {
    schemaVersion: number;
    reviewKind: string;
    captureId: string;
    manifestHash: string;
    definitionHash: string;
    projectionKind: string;
    projectionHash: string;
    commitSha: string;
    importer: string;
    reviewer: string;
    approved: boolean;
    reviewedAt: string;
    findings: unknown[];
    target: string;
    destinationIdentity: string;
  };
  destinationFingerprints: Array<{
    destinationType: "member" | "sku";
    sourceTable: string;
    sourceKey: string;
    destinationId: string;
    dataHash: string;
    operationVersion: number;
  }>;
}) {
  const { projection, botInventory, destinationIdentity, backupEvidence, technicalReview } = input;
  const definitionReadiness = appSheetDefinitionProductionReadiness(projection.definitionInventory, projection.expectedAppId);
  const review = {
    schemaVersion: technicalReview.schemaVersion,
    reviewKind: technicalReview.reviewKind,
    importer: technicalReview.importer,
    reviewer: technicalReview.reviewer,
    reviewedAt: technicalReview.reviewedAt,
    approved: technicalReview.approved,
    findingsCount: technicalReview.findings.length,
    projectionHash: technicalReview.projectionHash,
    captureId: technicalReview.captureId,
    manifestHash: technicalReview.manifestHash,
    definitionHash: technicalReview.definitionHash,
    commitSha: technicalReview.commitSha,
    bindingSource: "explicit-target-and-destination",
    target: technicalReview.target,
    destinationIdentity: technicalReview.destinationIdentity,
  };
  const appSheetCanonical = {
    schemaVersion: 1,
    projectionKind: "masters",
    mappingId: projection.mappingId,
    importerVersion: projection.importerVersion,
    captureId: projection.capture.captureId,
    manifestHash: projection.capture.manifestHash,
    dataHash: projection.capture.dataHash,
    captureDefinitionHash: projection.capture.definitionHash,
    appliedDefinitionHash: projection.appliedDefinitionHash,
    definitionReadiness,
    expectedAppId: projection.expectedAppId,
    definitionIdentityState: projection.definitionIdentityState,
    definitionInventory: projection.definitionInventory,
    projectionHash: projection.projectionHash,
    technicalReview: review,
    stabilityMode: projection.capture.stabilityMode,
    cutoffAt: projection.capture.cutoffAt,
    timestampGaps: projection.capture.timestampGaps,
    verifiedMasterPages: projection.verifiedMasterPages,
    destinationFingerprints: input.destinationFingerprints,
    globalDelta: {
      globallyStable: projection.capture.stabilityMode === "stable",
      unresolvedChangedPageCount: projection.summary.globalDeltaBlockingCount,
      changedPages: projection.capture.pageManifest.filter((page) => page.stable === false).map((page) => ({
        sheetId: page.sheetId,
        title: page.title,
        pageIndex: page.pageIndex,
        startRow: page.startRow,
        endRow: page.endRow,
        pass1Hash: page.pageHash,
        pass2Hash: page.verifiedPageHash,
        pass3Evidence: page.pass3Evidence ?? null,
      })),
    },
    botInventory,
    stageContext: { target: "production", destinationIdentity, backupEvidence },
    humanReview: { status: "pending" },
    operationalAuthority: { status: "unchanged" },
    effects: { stock: false, cash: false, orders: false, deliveries: false, messaging: false, priceApproval: false },
  };
  const capture = projection.capture;
  return {
    controls: { appSheetCanonical },
    coverage: {
      schemaVersion: 1,
      appSheetCanonical: {
        captureId: capture.captureId,
        sourceSystem: capture.sourceSystem,
        sourceId: capture.sourceId,
        manifestHash: capture.manifestHash,
        dataHash: capture.dataHash,
        captureDefinitionHash: capture.definitionHash,
        appliedDefinitionHash: projection.appliedDefinitionHash,
        definitionReadiness,
        expectedAppId: projection.expectedAppId,
        identityState: projection.definitionIdentityState,
        projectionHash: projection.projectionHash,
        stabilityMode: capture.stabilityMode,
        cutoffAt: capture.cutoffAt,
        timestampGaps: capture.timestampGaps,
        verifiedMasterPages: projection.verifiedMasterPages,
        delta: {
          globallyStable: capture.stabilityMode === "stable",
          unresolvedChangedPageCount: projection.summary.globalDeltaBlockingCount,
          changedPages: projection.capture.pageManifest.filter((page) => page.stable === false).map((page) => ({
            sheetId: page.sheetId,
            title: page.title,
            pageIndex: page.pageIndex,
            startRow: page.startRow,
            endRow: page.endRow,
            pass1Hash: page.pageHash,
            pass2Hash: page.verifiedPageHash,
            pass3Evidence: page.pass3Evidence ?? null,
          })),
        },
        tables: projection.tableCoverage,
        counts: projection.summary,
        definition: {
          sourceSha256: projection.definitionInventory.source.sha256,
          descriptorSha256: projection.definitionInventory.descriptorSha256,
          appliedDefinitionHash: projection.appliedDefinitionHash,
          appId: projection.definitionInventory.app.id,
          expectedAppId: projection.expectedAppId,
          identityState: projection.definitionIdentityState,
          parserVersion: projection.definitionInventory.parserVersion,
          declaredCounts: projection.definitionInventory.declaredCounts,
          observedCounts: projection.definitionInventory.observedCounts,
          coverage: projection.definitionInventory.coverage,
        },
        botInventory,
      },
    },
    stageAuditDetails: {
      captureId: capture.captureId,
      manifestHash: capture.manifestHash,
      projectionHash: projection.projectionHash,
      importerVersion: projection.importerVersion,
      reviewer: review.reviewer,
      reviewedAt: review.reviewedAt,
      commitSha: review.commitSha,
      target: "production",
      backupManifestHash: backupEvidence.manifestHash,
      backupSnapshotAt: backupEvidence.snapshotAt,
      destinationIdentity,
      recordCount: projection.summary.recordCount,
      destinationCount: projection.destinations.length,
      exceptionCount: projection.summary.exceptionCount,
    },
  };
}

function excelSerial(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round((Date.UTC(year!, month! - 1, day!) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function cell(columnIndex: number, value: string | number | boolean) {
  const source = typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { numberValue: value } : { boolValue: value };
  return { columnIndex, userEnteredValue: source, effectiveValue: source };
}

function capturePage(input: {
  spreadsheetId: string;
  sheetId: number;
  title: string;
  headers: string[];
  rows: Array<Array<string | number | boolean>>;
  dateColumns?: string[];
}) {
  const safeColumnIndexes = input.headers.map((_, index) => index + 1);
  const sourceRows = [input.headers, ...input.rows].map((values, index) => ({
    sourceRow: index + 1,
    cells: values.map((value, columnIndex) => ({
      ...cell(columnIndex + 1, value),
      ...(index > 0 && typeof value === "number" && input.dateColumns?.includes(input.headers[columnIndex]!)
        ? { userEnteredFormat: { numberFormat: { type: "DATE" } } }
        : {}),
    })),
    unresolvedFormulaCells: [] as (string | number)[],
  }));
  const rows = sourceRows.map((row) => ({
    ...row,
    rowHash: hash({ sourceRow: row.sourceRow, cells: row.cells, unresolvedFormulaCells: row.unresolvedFormulaCells, safeColumnIndexes }),
  }));
  const pageBody = {
    schemaVersion: "appsheet-sheet-page/v1" as const,
    spreadsheetId: input.spreadsheetId,
    sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
    sheet: { sheetId: input.sheetId, title: input.title, mode: "table", hidden: false, headerRow: 1, gridRows: 100, gridColumns: input.headers.length },
    page: { index: 0, startRow: 1, endRow: sourceRows.length, a1Ranges: [`A1:${String.fromCharCode(64 + input.headers.length)}${sourceRows.length}`],
      safeColumnIndexes, omittedColumnIndexes: [], cellFields: "userEnteredValue,effectiveValue,userEnteredFormat,dataValidation" },
    rows,
    counts: { scannedRows: sourceRows.length, rowsWithValues: sourceRows.length, blankRows: 0, rowsSerialized: sourceRows.length,
      formulaCellCount: 0, unresolvedFormulaCount: 0 },
  };
  const pageHash = hash(pageBody);
  return {
    page: { ...pageBody, pageHash },
    ref: { path: `pages/${input.sheetId}-1-${sourceRows.length}.json`, sheetId: input.sheetId, title: input.title,
      pageIndex: 0, startRow: 1, endRow: sourceRows.length, pageHash, verifiedPageHash: pageHash, stable: true, counts: pageBody.counts },
    header: { sheetId: input.sheetId, title: input.title, mode: "table", hidden: false, headerRow: 1, gridRows: 100,
      gridColumns: input.headers.length, columns: input.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false })),
      pageCount: 1, safeColumnIndexes, omittedColumnIndexes: [] },
  };
}

/**
 * Full same-capture fixture for the replacement consumer. The canonical master
 * pages and the stock source pages share one stable manifest and one signed
 * definition. T_Usuarios is represented as a required, redacted page.
 */
export function appSheetSourceLotCaptureFixture(revision: string) {
  const spreadsheetId = `synthetic-source-lot-${revision}`;
  const sourceRowsFor = (snapshotId: string, manifestHash: string) => appSheetSourceLotRows({ snapshotId, manifestHash, skuSourceId: "source-sku" });
  const sourceRows = sourceRowsFor(`history-${revision}`, "0".repeat(64));
  const member = capturePage({ spreadsheetId, sheetId: 11, title: "C_Cliente",
    headers: ["Id_Cliente", "Nombre_Cliente", "Apellido_Cliente", "Telefono", "Telefono_Normalizado", "Domicilio", "Zona", "Email"],
    rows: [["source-member", "Synthetic", "Member", "111", "+54111", "Calle 1", "Centro", "source-member@example.test"]] });
  const catalogue = capturePage({ spreadsheetId, sheetId: 12, title: "D_Catalogo_Mercaderia",
    headers: ["CatalogoID", "Codigo_Detalle", "Variedad_Cann", "Descripcion", "Estado", "Segmento_Descuento", "Precio_5_Gramos"],
    rows: [["source-sku", "source-sku", "Fixture", "Synthetic catalog product", true, "Estandar", 5]] });
  const lotRows = sourceRows.sourceLots.map((lot) => [lot.sourceLotId, "source-sku", lot.sourceLotId, lot.sourceDeliveryDate,
    excelSerial(lot.sourceDeliveryDate)] as Array<string | number | boolean>);
  const merchandise = capturePage({ spreadsheetId, sheetId: 13, title: "C_Mercaderia",
    headers: sourceRows.physicalHeaders.C_Mercaderia, rows: lotRows, dateColumns: ["Fecha_Entrega"] });
  const movementRows = sourceRows.movements.map((movement) => {
    const columns = (movement.normalized as { columns: Array<{ header: string; value: string }> }).columns;
    return ["ID_Mov_Stock_Total", "Codigo_Detalle", "Id_Lote", "Tipo_Registro_Mercaderia", "Cantidad_Gr"].map((header) =>
      columns.find((column) => column.header === header)!.value);
  });
  const movements = capturePage({ spreadsheetId, sheetId: 14, title: "Mov_Stock1",
    headers: sourceRows.physicalHeaders.Mov_Stock1, rows: movementRows });
  const openings = capturePage({ spreadsheetId, sheetId: 16, title: "D_Stock",
    headers: ["ID_Stock", "Codigo_Detalle", "Cantidad", "Unidad", "Id_Lote"],
    rows: sourceRows.sourceLots.map((lot) => [`opening-${lot.sourceLotId}`, "source-sku", Number(lot.sourceStockActual), "g", lot.sourceLotId]) });
  const refs = [member.ref, catalogue.ref, merchandise.ref, movements.ref, openings.ref];
  const pageManifest = refs;
  const pageRefs = pageManifest.map((ref) => ({ path: ref.path, sheetId: ref.sheetId, pageIndex: ref.pageIndex, startRow: ref.startRow,
    endRow: ref.endRow, pageHash: ref.pageHash, counts: ref.counts }));
  const dataHash = hash(pageRefs);
  const manifestHash = hash({ revision, pageRefs });
  const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
  const now = new Date("2026-10-09T10:00:00.000Z");
  const pages = [member.page, catalogue.page, merchandise.page, movements.page, openings.page];
  const headers = [member.header, catalogue.header, merchandise.header, movements.header, openings.header, {
    sheetId: 15, title: "T_Usuarios", mode: "table", hidden: true, headerRow: 1, gridRows: 10, gridColumns: 0, columns: [],
    pageCount: 0, safeColumnIndexes: [], omittedColumnIndexes: [], bodyExcluded: true,
    bodyExclusionReason: "authentication-table-body-redacted",
  }];
  const definition = appSheetSourceStockDefinition();
  // The consumer-only bot inventory is explicitly synthetic. Keep this
  // evidence in the fixture producer so no immutable snapshot needs patching.
  const botInventory: SyntheticSourceLotBotInventory = {
    state: "verified",
    evidenceSha256: hash({ scope: "synthetic-consumer-precondition-only", appId: definition.inventory.app.id, observedCount: 0 }),
    observedCount: 0,
    scope: "synthetic-consumer-precondition-only",
    evidenceReference: "fixture-only; no AppSheet editor evidence",
  };
  const dataCoverage = {
    metadataStable: true, headersStableAll: true, totalPages: pageManifest.length,
    rowsWithValues: pageManifest.reduce((sum, page) => sum + page.counts.rowsWithValues, 0),
    dataRecordCount: 12, failedPages: 0, changedPages: 0, unresolvedFormulaCount: 0,
    sheets: [...pageManifest.map((page) => ({ sheetId: page.sheetId, title: page.title, pageCount: 1, verifiedPageCount: 1,
      stablePageCount: 1, changedPageCount: 0, bodyRead: page.bodyExcluded !== true, bodyExcluded: page.bodyExcluded === true,
      formulaCellCount: 0, unresolvedFormulaCount: 0 })),
      { sheetId: 15, title: "T_Usuarios", pageCount: 0, verifiedPageCount: 0, stablePageCount: 0,
        changedPageCount: 0, bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted",
        formulaCellCount: 0, unresolvedFormulaCount: 0 }],
  };
  const manifest = {
    schemaVersion: "appsheet-capture-manifest/v1" as const, captureId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
    sourceId: spreadsheetId, spreadsheetId, metadataHash: hash({ revision, metadata: true }), headersHash: hash(headers),
    manifestHash, dataHash, definitionHash: null,
    stability: { stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true, scanComplete: true,
      firstPassPages: pageManifest.length, verifiedPages: pageManifest.length, matchedPages: pageManifest.length, changedPages: 0,
      failedPages: 0, missingPages: 0, unresolvedFormulaCount: 0, sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"] },
    firstReadAt: now.toISOString(), verificationStartedAt: new Date(now.getTime() + 1_000).toISOString(),
    verificationCompletedAt: new Date(now.getTime() + 2_000).toISOString(), cutoffAt: new Date(now.getTime() + 3_000).toISOString(),
    timestampGaps: [], coverage: dataCoverage, pages: pageManifest, dataSheetCount: 5, dataPageCount: pageManifest.length, dataRecordCount: 12,
    dataFormulaCount: 0, dataUnresolvedFormulaCount: 0, definitionCoverage: null, definitionTableCount: null, definitionColumnCount: 2,
    definitionSliceCount: 0, definitionViewCount: 0, definitionActionCount: 0, definitionBotCount: 0,
    definitionWorkflowRuleCount: 0, definitionFormatRuleCount: 0,
  };
  const projection = prepareAppSheetMasterProjection({ manifest, headers: { schemaVersion: "appsheet-sheet-headers/v1", spreadsheetId, sheets: headers },
    pages, definitionInventory: definition.inventory, mode: "stable" });
  return { projection, sourceRows, sourceRowsFor, definition, botInventory,
    sourceLotCapture: { manifest, headers: { schemaVersion: "appsheet-sheet-headers/v1", spreadsheetId, sheets: headers }, pages } };
}

function sourceRecord(input: {
  snapshotId: string;
  manifestHash: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  columns: Array<{ header: string; value: string; exactDecimal?: string }>;
  dateColumn?: { header: string; serial: number };
}) {
  const id = `source-${input.sourceTable.toLowerCase()}-${randomUUID()}`;
  const normalized = { columns: input.columns.map((column, index) => ({
    coordinate: `${String.fromCharCode(65 + index)}${input.sourceRow}`,
    header: column.header,
    value: column.value,
    ...(column.exactDecimal === undefined ? {} : { exactDecimal: column.exactDecimal }),
  })) };
  const original = input.dateColumn ? { columns: input.columns.map((column, index) => {
    const coordinate = `${String.fromCharCode(65 + index)}${input.sourceRow}`;
    if (column.header !== input.dateColumn!.header) return { coordinate, header: column.header, value: column.value };
    return {
      coordinate,
      header: column.header,
      value: {
        kind: "appsheet_cell",
        formula: null,
        userEnteredValue: { numberValue: input.dateColumn!.serial },
        effectiveValue: { numberValue: input.dateColumn!.serial },
        userEnteredFormat: { numberFormat: { type: "DATE" } },
        dataValidation: null,
      },
    };
  }) } : { columns: input.columns.map((column, index) => ({
    coordinate: `${String.fromCharCode(65 + index)}${input.sourceRow}`,
    header: column.header,
    value: column.value,
  })) };
  const contentHash = hash({ sourceTable: input.sourceTable, sourceKey: input.sourceKey, sourceRow: input.sourceRow, original, normalized });
  return {
    id,
    snapshotId: input.snapshotId,
    sourceTable: input.sourceTable,
    sourceKey: input.sourceKey,
    sourceRow: input.sourceRow,
    fileHash: input.manifestHash,
    contentHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    original,
    normalized,
    treatment: "fact_candidate" as const,
  };
}

/** Create two source lots whose delivery order differs from the selected lot. */
export function appSheetSourceLotRows(input: {
  snapshotId: string;
  manifestHash: string;
  skuSourceId: string;
  firstSourceLotId?: string;
  selectedSourceLotId?: string;
  firstDeliveryDate?: string;
  selectedDeliveryDate?: string;
}) {
  const firstSourceLotId = input.firstSourceLotId ?? "source-lot-fifo-first";
  const selectedSourceLotId = input.selectedSourceLotId ?? "source-lot-explicit-selection";
  const firstDeliveryDate = input.firstDeliveryDate ?? "2026-10-01";
  const selectedDeliveryDate = input.selectedDeliveryDate ?? "2026-10-07";
  const member = sourceRecord({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    sourceTable: "C_Cliente",
    sourceKey: "source-member",
    sourceRow: 2,
    columns: [{ header: "Id_Cliente", value: "source-member" }, { header: "Nombre_Cliente", value: "Synthetic" },
      { header: "Apellido_Cliente", value: "Member" }, { header: "Telefono", value: "111" },
      { header: "Telefono_Normalizado", value: "+54111" }, { header: "Domicilio", value: "Calle 1" },
      { header: "Zona", value: "Centro" }, { header: "Email", value: "source-member@example.test" }],
  });
  const sourceLots = [
    { sourceLotId: firstSourceLotId, delivered: firstDeliveryDate, entry: "100", sale: "12", waste: "2" },
    { sourceLotId: selectedSourceLotId, delivered: selectedDeliveryDate, entry: "50", sale: "10", waste: "1" },
  ];
  const lots = sourceLots.map((lot, index) => sourceRecord({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    sourceTable: "C_Mercaderia",
    sourceKey: lot.sourceLotId,
    sourceRow: index + 2,
    columns: [
      { header: "ID_Mercaderia", value: lot.sourceLotId },
      { header: "Codigo_Detalle", value: input.skuSourceId },
      { header: "Id_Compra_Lote", value: lot.sourceLotId },
      { header: "Fecha_Compra", value: lot.delivered },
      { header: "Fecha_Entrega", value: String(excelSerial(lot.delivered)), exactDecimal: String(excelSerial(lot.delivered)) },
    ],
    dateColumn: { header: "Fecha_Entrega", serial: excelSerial(lot.delivered) },
  }));
  const sku = sourceRecord({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    sourceTable: "D_Catalogo_Mercaderia",
    sourceKey: input.skuSourceId,
    sourceRow: 2,
    columns: [{ header: "CatalogoID", value: input.skuSourceId }, { header: "Codigo_Detalle", value: input.skuSourceId },
      { header: "Variedad_Cann", value: "Fixture" }, { header: "Descripcion", value: "Synthetic catalog product" },
      { header: "Estado", value: "TRUE" }, { header: "Segmento_Descuento", value: "Estandar" }, { header: "Precio_5_Gramos", value: "5.00", exactDecimal: "5" }],
  });
  const stockOpenings = sourceLots.map((lot, index) => sourceRecord({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    sourceTable: "D_Stock",
    sourceKey: `opening-${lot.sourceLotId}`,
    sourceRow: index + 2,
    columns: [{ header: "ID_Stock", value: `opening-${lot.sourceLotId}` }, { header: "Codigo_Detalle", value: input.skuSourceId },
      { header: "Cantidad", value: String(Number(lot.entry) - Number(lot.sale) - Number(lot.waste)), exactDecimal: String(Number(lot.entry) - Number(lot.sale) - Number(lot.waste)) },
      { header: "Unidad", value: "g" }, { header: "Id_Lote", value: lot.sourceLotId }],
  }));
  const movements = sourceLots.flatMap((lot, index) => [
    { type: "Entrada", quantity: lot.entry },
    { type: "Venta", quantity: lot.sale },
    { type: "Merma", quantity: lot.waste },
  ].map((movement, movementIndex) => sourceRecord({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    sourceTable: "Mov_Stock1",
    sourceKey: `movement-${lot.sourceLotId}-${movement.type.toLowerCase()}`,
    sourceRow: 2 + index * 3 + movementIndex,
    columns: [
      { header: "ID_Mov_Stock_Total", value: `movement-${lot.sourceLotId}-${movement.type.toLowerCase()}` },
      { header: "Codigo_Detalle", value: input.skuSourceId },
      { header: "Id_Lote", value: lot.sourceLotId },
      { header: "Tipo_Registro_Mercaderia", value: movement.type },
      { header: "Cantidad_Gr", value: movement.quantity, exactDecimal: movement.quantity },
    ],
  })));
  const records = [member, sku, ...lots, ...stockOpenings, ...movements];
  const facts = records.map((record) => {
    const columns = (record.normalized as { columns: Array<{ header: string; value: string }> }).columns;
    const value = (header: string) => columns.find((column) => column.header === header)?.value;
    const isLot = record.sourceTable === "C_Mercaderia";
    const isSku = record.sourceTable === "D_Catalogo_Mercaderia";
    const isOpening = record.sourceTable === "D_Stock";
    const classification = record.sourceTable === "Mov_Stock1" ? value("Tipo_Registro_Mercaderia") : undefined;
    const quantity = isLot ? "1" : isOpening ? value("Cantidad")! : classification ? value("Cantidad_Gr")! : null;
    return {
      id: `fact-${record.id}`,
      snapshotId: input.snapshotId,
      sourceRecordId: record.id,
      sourceTable: record.sourceTable,
      sourceKey: record.sourceKey,
      sourceRow: record.sourceRow,
      sourceHash: record.contentHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      kind: record.sourceTable === "C_Cliente" ? "member" : isSku ? "catalogue" : isLot ? "purchase" : "stock",
      occurredOn: isLot ? (value("Fecha_Compra") ?? null) : null,
      dateState: isLot ? "known" : "not-applicable",
      quantity,
      quantityState: quantity === null ? "absent" : "known",
      unit: classification || isOpening ? "g" : null,
      unitState: classification || isOpening ? "known" : "absent",
      attributes: {
        ...(isLot || classification || isOpening ? { relationships: [{ targetTable: "D_Catalogo_Mercaderia", status: "unique",
          targetSourceKey: input.skuSourceId, sourceField: "Codigo_Detalle", targetField: "Codigo_Detalle", targetSourceRecordId: sku.id }] } : {}),
        ...(classification ? { sourceClassification: { field: "Tipo_Registro_Mercaderia", state: "known", value: classification } } : {}),
      },
      correctionOf: null,
    };
  });
  return {
    physicalHeaders: {
      C_Mercaderia: ["ID_Mercaderia", "Codigo_Detalle", "Id_Compra_Lote", "Fecha_Compra", "Fecha_Entrega"],
      Mov_Stock1: ["ID_Mov_Stock_Total", "Codigo_Detalle", "Id_Lote", "Tipo_Registro_Mercaderia", "Cantidad_Gr"],
    },
    records,
    facts,
    sourceLots: sourceLots.map((lot, index) => ({
      sourceLotId: lot.sourceLotId,
      sourceRecord: lots[index]!,
      sourceStockActual: String(Number(lot.entry) - Number(lot.sale) - Number(lot.waste)),
      sourceDeliveryDate: lot.delivered,
    })),
    movements,
  };
}
