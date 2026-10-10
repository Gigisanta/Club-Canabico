import { createHash } from "node:crypto";
import { APPSHEET_CANONICAL_IMPORTER_VERSION } from "../../shared/operations/appsheet-canonical.js";
import { prepareAppSheetMasterProjection } from "../../server/operations/appsheet-canonical.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { appSheetDefinitionInventorySchema } from "../../shared/operations/appsheet-definition.js";

export const sourceSystem = "appsheet-live-verified";
export const spreadsheetId = "synthetic-spreadsheet";
export const fixtureDate = "2026-10-09T10:00:00.000Z";
export const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const scalarCell = (columnIndex: number, value: string | number | boolean) => ({
  columnIndex,
  userEnteredValue: typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { numberValue: value } : { boolValue: value },
  effectiveValue: typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { numberValue: value } : { boolValue: value },
});

type FixtureRow = { sourceRow: number; cells: ReturnType<typeof scalarCell>[]; unresolvedFormulaCells: (string | number)[] };

export function definitionInventory() {
  const base = {
    schemaVersion: 1 as const,
    parserVersion: "fixture-parser/1",
    source: { sha256: "e".repeat(64), byteLength: 10, encoding: "utf-8" as const },
    app: { id: null, name: null, version: null, deploymentState: null, generatedAt: null },
    declaredCounts: {},
    observedCounts: {},
    descriptorSha256: "",
    coverage: [],
    sections: [],
    evidence: [],
    redactedFieldCount: 0,
    warnings: [],
  };
  return appSheetDefinitionInventorySchema.parse({ ...base, descriptorSha256: hash(base) });
}

function makePage(input: {
  title: string;
  sheetId: number;
  headers: string[];
  rows: Array<{ values: Array<string | number | boolean | undefined>; unresolved?: (string | number)[] }>;
  pageIndex?: number;
}) {
  const pageIndex = input.pageIndex ?? 0;
  const safeColumnIndexes = input.headers.map((_, index) => index + 1);
  const rows: FixtureRow[] = [
    { sourceRow: 1, cells: input.headers.map((value, index) => scalarCell(index + 1, value)), unresolvedFormulaCells: [] },
    ...input.rows.map((row, index) => ({
      sourceRow: index + 2,
      cells: row.values.flatMap((value, columnIndex) => value === undefined ? [] : [scalarCell(columnIndex + 1, value)]),
      unresolvedFormulaCells: row.unresolved ?? [],
    })),
  ];
  const pageRows = rows.map((row) => ({
    ...row,
    rowHash: hash({ sourceRow: row.sourceRow, cells: row.cells, unresolvedFormulaCells: row.unresolvedFormulaCells, safeColumnIndexes }),
  }));
  const body = {
    schemaVersion: "appsheet-sheet-page/v1" as const,
    spreadsheetId,
    sourceSystem,
    sheet: { sheetId: input.sheetId, title: input.title, mode: "table", hidden: false, headerRow: 1, gridRows: 10, gridColumns: input.headers.length },
    page: {
      index: pageIndex,
      startRow: 1,
      endRow: rows.length,
      a1Ranges: [`A1:${String.fromCharCode(64 + input.headers.length)}${rows.length}`],
      safeColumnIndexes,
      omittedColumnIndexes: [],
      cellFields: "userEnteredValue,effectiveValue,userEnteredFormat,dataValidation",
    },
    rows: pageRows,
    counts: {
      scannedRows: rows.length,
      rowsWithValues: rows.length,
      blankRows: 0,
      rowsSerialized: rows.length,
      formulaCellCount: 0,
      unresolvedFormulaCount: pageRows.reduce((sum, row) => sum + row.unresolvedFormulaCells.length, 0),
    },
  };
  const page = { ...body, pageHash: hash(body) };
  const ref = {
    path: `pages/${input.sheetId}-1-${rows.length}.json`,
    sheetId: input.sheetId,
    title: input.title,
    pageIndex,
    startRow: 1,
    endRow: rows.length,
    pageHash: page.pageHash,
    verifiedPageHash: page.pageHash,
    stable: true,
    counts: page.counts,
  };
  const header = {
    sheetId: input.sheetId,
    title: input.title,
    mode: "table",
    hidden: false,
    headerRow: 1,
    gridRows: 10,
    gridColumns: input.headers.length,
    columns: input.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false })),
    pageCount: 1,
    safeColumnIndexes,
    omittedColumnIndexes: [],
  };
  return { page, ref, header };
}

function captureManifest(refs: Record<string, unknown>[], options: { stable?: boolean; masterMismatch?: boolean; captureRevision?: string } = {}) {
  const changed = refs.map((ref, index) => {
    const shouldChange = options.masterMismatch === true && index === 0;
    if (!shouldChange) return ref;
    return { ...ref, pageHash: "f".repeat(64), stable: false };
  });
  const stableCount = changed.filter((ref) => ref.stable === true).length;
  const changedCount = changed.length - stableCount;
  const stable = options.stable !== false;
  const manifestHash = options.captureRevision ? hash({ fixtureCapture: options.captureRevision }) : "a".repeat(64);
  return {
    schemaVersion: "appsheet-capture-manifest/v1",
    captureId: `appsreal-${manifestHash.slice(0, 16)}`,
    sourceSystem,
    sourceId: spreadsheetId,
    spreadsheetId,
    metadataHash: "b".repeat(64),
    headersHash: "c".repeat(64),
    manifestHash,
    dataHash: options.captureRevision ? hash({ fixtureData: options.captureRevision }) : "d".repeat(64),
    definitionHash: null,
    stability: {
      stable,
      metadataStable: true,
      headersStable: true,
      pageHashesStable: stable,
      scanComplete: true,
      firstPassPages: changed.length,
      verifiedPages: changed.length,
      matchedPages: stableCount,
      changedPages: changedCount,
      failedPages: 0,
    },
    timestamps: {
      firstReadAt: fixtureDate,
      verificationStartedAt: stable ? "2026-10-09T10:01:00.000Z" : null,
      verificationCompletedAt: stable ? "2026-10-09T10:02:00.000Z" : null,
      cutoffAt: stable ? "2026-10-09T10:03:00.000Z" : null,
    },
    timestampGaps: stable ? [] : ["verification window unavailable in preliminary capture"],
    coverage: {
      rowsWithValues: changed.length * 2,
      bodySheetsCaptured: changed.length,
      totalPages: changed.length,
      formulaCellCount: 0,
      unresolvedFormulaCount: 0,
      sheets: changed.map((ref) => ({ sheetId: ref.sheetId, title: ref.title, occupiedDataRows: 1 })),
    },
    pages: changed,
    dataSheetCount: changed.length,
    dataPageCount: changed.length,
    dataRecordCount: changed.length,
    dataFormulaCount: 0,
    dataUnresolvedFormulaCount: 0,
    definitionCoverage: null,
    definitionTableCount: null,
    definitionColumnCount: null,
    definitionSliceCount: null,
    definitionViewCount: null,
    definitionActionCount: null,
    definitionBotCount: null,
    definitionWorkflowRuleCount: null,
    definitionFormatRuleCount: null,
  };
}

function fixture(options: {
  unresolvedEmail?: boolean;
  duplicateMemberKey?: boolean;
  duplicateCatalogueCode?: boolean;
  stagedDelta?: boolean;
  captureRevision?: string;
  changedMemberName?: string;
  memberKey?: string;
} = {}) {
  const memberHeaders = ["Id_Cliente", "Nombre_Cliente", "Apellido_Cliente", "Telefono", "Telefono_Normalizado", "Domicilio", "Zona", "Email"];
  const memberRows = [
    { values: [options.memberKey ?? "member-1", options.changedMemberName ?? "Synthetic", "Member", "111", "+54111", "Calle 1", "Centro", options.unresolvedEmail ? undefined : "synthetic@example.com"],
      unresolved: options.unresolvedEmail ? ["H2"] : [] },
    ...(options.duplicateMemberKey ? [{ values: ["member-1", "Second", "Member", "222", "+54222", "Calle 2", "Norte", "second@example.com"] }] : []),
  ];
  const catalogueHeaders = ["CatalogoID", "Codigo_Detalle", "Variedad_Cann", "Descripcion", "Estado", "Segmento_Descuento", "Precio_5_Gramos"];
  const catalogueRows = [
    { values: ["sku-1", "BUS-1", "Rosa", "Flor", true, "Estandar", 5.25] },
    ...(options.duplicateCatalogueCode ? [{ values: ["sku-2", "BUS-1", "Verde", "Flor 2", false, "Premium", 6.5] }] : []),
  ];
  const members = makePage({ title: "C_Cliente", sheetId: 11, headers: memberHeaders, rows: memberRows });
  const catalogue = makePage({ title: "D_Catalogo_Mercaderia", sheetId: 12, headers: catalogueHeaders, rows: catalogueRows });
  const pages = [members.page, catalogue.page];
  const refs = [members.ref, catalogue.ref];
  const headers = [members.header, catalogue.header];
  if (options.stagedDelta) {
    refs.push({ path: "pages/13-1-2.json", sheetId: 13, title: "C_Facturacion", pageIndex: 0,
      startRow: 1, endRow: 2, pageHash: "e".repeat(64), verifiedPageHash: "f".repeat(64), stable: false,
      counts: { scannedRows: 2, rowsWithValues: 2, blankRows: 0, rowsSerialized: 2, formulaCellCount: 0, unresolvedFormulaCount: 0 } });
  }
  const manifest = captureManifest(refs, { stable: !options.stagedDelta, captureRevision: options.captureRevision });
  // The row count excludes populated headers; the page aggregate includes them.
  manifest.dataRecordCount = memberRows.length + catalogueRows.length + (options.stagedDelta ? 1 : 0);
  manifest.coverage.rowsWithValues = refs.reduce((sum, ref) => sum + Number((ref.counts as Record<string, unknown>).rowsWithValues), 0);
  manifest.coverage.sheets = [
    { sheetId: 11, title: "C_Cliente", occupiedDataRows: memberRows.length },
    { sheetId: 12, title: "D_Catalogo_Mercaderia", occupiedDataRows: catalogueRows.length },
    ...(options.stagedDelta ? [{ sheetId: 13, title: "C_Facturacion", occupiedDataRows: 1 }] : []),
  ];
  manifest.coverage.bodySheetsCaptured = refs.length;
  manifest.coverage.totalPages = refs.length;
  manifest.stability.firstPassPages = refs.length;
  manifest.stability.verifiedPages = refs.length;
  manifest.stability.matchedPages = options.stagedDelta ? 2 : refs.length;
  manifest.stability.changedPages = options.stagedDelta ? 1 : 0;
  manifest.stability.pageHashesStable = !options.stagedDelta;
  manifest.stability.stable = !options.stagedDelta;
  if (options.stagedDelta) {
    manifest.timestamps.verificationStartedAt = null;
    manifest.timestamps.verificationCompletedAt = null;
    manifest.timestamps.cutoffAt = null;
  }
  return {
    manifest,
    headers: { schemaVersion: "appsheet-sheet-headers/v1" as const, spreadsheetId, sheets: headers },
    pages,
    definitionInventory: definitionInventory(),
  };
}

// Expose the existing producer so CLI tests can exercise the same capture shape
// without duplicating its page and row hash construction.
export const canonicalCaptureFixture = fixture;

export function project(options: Parameters<typeof fixture>[0] = {}, allowStagedDelta = false) {
  const capture = fixture(options);
  const mode = options.stagedDelta ? "preliminary-delta" : "stable";
  return prepareAppSheetMasterProjection({ ...capture, mode }, { allowStagedDelta });
}

export function technicalReview(projection: ReturnType<typeof project>, commitSha = "1".repeat(40)) {
  return {
    schemaVersion: 1,
    reviewKind: "independent-technical",
    captureId: projection.capture.captureId,
    manifestHash: projection.capture.manifestHash,
    definitionHash: projection.appliedDefinitionHash,
    projectionKind: "masters",
    projectionHash: projection.projectionHash,
    commitSha,
    importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
    reviewer: "synthetic-independent-reviewer",
    approved: true,
    reviewedAt: fixtureDate,
    findings: [],
  };
}
