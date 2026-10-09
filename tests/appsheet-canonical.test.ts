import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import test from "node:test";
import {
  appSheetCellEffectiveValue,
  prepareAppSheetCaptureManifest,
} from "../shared/operations/appsheet-canonical.js";
import { canonicalJson } from "../shared/operations/exact.js";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
  AppSheetCanonicalError,
  appSheetAppliedDefinitionHash,
  prepareAppSheetDefinitionInventory,
  prepareAppSheetMasterProjection,
  stageAppSheetCanonicalMasters,
} from "../server/operations/appsheet-canonical.js";
import { appSheetDefinitionInventorySchema } from "../shared/operations/appsheet-definition.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION } from "../shared/operations/appsheet-canonical.js";
import { parseArgs } from "../scripts/appsheet-canonical.js";
import { requireAppSheetTechnicalReview } from "../shared/operations/appsheet-review.js";

const sourceSystem = "appsheet-live-verified";
const spreadsheetId = "synthetic-spreadsheet";
const fixtureDate = "2026-10-09T10:00:00.000Z";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const scalarCell = (columnIndex: number, value: string | number | boolean) => ({
  columnIndex,
  userEnteredValue: typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { numberValue: value } : { boolValue: value },
  effectiveValue: typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { numberValue: value } : { boolValue: value },
});

type FixtureRow = { sourceRow: number; cells: ReturnType<typeof scalarCell>[]; unresolvedFormulaCells: (string | number)[] };

function definitionInventory() {
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
} = {}) {
  const memberHeaders = ["Id_Cliente", "Nombre_Cliente", "Apellido_Cliente", "Telefono", "Telefono_Normalizado", "Domicilio", "Zona", "Email"];
  const memberRows = [
    { values: ["member-1", options.changedMemberName ?? "Synthetic", "Member", "111", "+54111", "Calle 1", "Centro", options.unresolvedEmail ? undefined : "synthetic@example.com"],
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

function project(options: Parameters<typeof fixture>[0] = {}, allowStagedDelta = false) {
  const capture = fixture(options);
  const mode = options.stagedDelta ? "preliminary-delta" : "stable";
  return prepareAppSheetMasterProjection({ ...capture, mode }, { allowStagedDelta });
}

function technicalReview(projection: ReturnType<typeof project>, commitSha = "1".repeat(40)) {
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

type FakeState = {
  manifests: Map<string, Record<string, unknown>>;
  snapshots: Map<string, Record<string, unknown>>;
  sourceRecords: Map<string, Record<string, unknown>>;
  exceptions: Map<string, Record<string, unknown>>;
  members: Map<string, Record<string, unknown>>;
  skus: Map<string, Record<string, unknown>>;
  identities: Map<string, Record<string, unknown>>;
  objects: Map<string, Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
};

function emptyFakeState(): FakeState {
  return {
    manifests: new Map(), snapshots: new Map(), sourceRecords: new Map(), exceptions: new Map(), members: new Map(),
    skus: new Map(), identities: new Map(), objects: new Map(), audits: [],
  };
}

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function sameWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function fakeDatabase(initial = emptyFakeState(), failOn: string | null = null) {
  let state = deepCopy(initial);
  let writeAttempts = 0;
  let transactions = 0;
  const write = (operation: string) => {
    writeAttempts++;
    if (failOn === operation) return false;
    return true;
  };
  const db = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      const work = deepCopy(state);
      const tx = {
        user: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "admin-fixture" ? { id: where.id, role: "owner", active: true } : null },
        operationAccess: { findUnique: async () => ({ enabled: true, capabilities: ["imports.write"] }) },
        appSheetCaptureManifest: {
          findUnique: async ({ where }: { where: { captureId: string } }) => work.manifests.get(where.captureId) ?? null,
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("appSheetCaptureManifest.createMany")) throw new Error("injected failure");
            for (const row of data) work.manifests.set(String(row.captureId), deepCopy({
              ...row,
              definitionCoverage: row.definitionCoverage === Prisma.DbNull ? null : row.definitionCoverage,
            }));
            return { count: data.length };
          },
        },
        legacyImportSnapshot: {
          findUnique: async ({ where }: { where: { id: string } }) => work.snapshots.get(where.id) ?? null,
          findMany: async () => [...work.snapshots.values()].sort((a, b) =>
            (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() || String(b.id).localeCompare(String(a.id))),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (!write("legacyImportSnapshot.create")) throw new Error("injected failure");
            const snapshot: Record<string, unknown> = { ...deepCopy(data), createdAt: new Date(Date.now() + work.snapshots.size * 1000) };
            work.snapshots.set(String(snapshot.id), snapshot);
            return snapshot;
          },
        },
        legacySourceRecord: {
          findMany: async ({ where }: { where: { snapshotId: string } }) => [...work.sourceRecords.values()]
            .filter((row) => row.snapshotId === where.snapshotId)
            .sort((a, b) => String(a.sourceTable).localeCompare(String(b.sourceTable)) || Number(a.sourceRow) - Number(b.sourceRow)),
          findFirst: async ({ where }: { where: { snapshotId: string; sourceTable: string; sourceKey: string } }) =>
            [...work.sourceRecords.values()].find((row) => row.snapshotId === where.snapshotId && row.sourceTable === where.sourceTable && row.sourceKey === where.sourceKey) ?? null,
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("legacySourceRecord.createMany")) throw new Error("injected failure");
            for (const row of data) work.sourceRecords.set(String(row.id), deepCopy(row));
            return { count: data.length };
          },
        },
        legacyException: {
          findMany: async ({ where }: { where: { snapshotId: string } }) => [...work.exceptions.values()]
            .filter((row) => row.snapshotId === where.snapshotId)
            .sort((a, b) => {
              const left = a.sourceRecordId === null ? "\uffff" : String(a.sourceRecordId);
              const right = b.sourceRecordId === null ? "\uffff" : String(b.sourceRecordId);
              return left.localeCompare(right) || String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id));
            }),
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("legacyException.createMany")) throw new Error("injected failure");
            for (const row of data) work.exceptions.set(String(row.id), deepCopy({ ...row, status: row.status ?? "open", resolution: null }));
            return { count: data.length };
          },
        },
        operationMember: {
          findUnique: async ({ where }: { where: Record<string, unknown> }) => {
            const nested = where.sourceSystem_sourceId as { sourceSystem: string; sourceId: string } | undefined;
            if (typeof where.id === "string") return work.members.get(where.id) ?? null;
            if (typeof where.legacyCustomerId === "string") return [...work.members.values()].find((row) => row.legacyCustomerId === where.legacyCustomerId) ?? null;
            if (nested) return [...work.members.values()].find((row) => row.sourceSystem === nested.sourceSystem && row.sourceId === nested.sourceId) ?? null;
            return null;
          },
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("operationMember.createMany")) throw new Error("injected failure");
            for (const row of data) work.members.set(String(row.id), deepCopy(row));
            return { count: data.length };
          },
          updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (!write("operationMember.updateMany")) return { count: 0 };
            const row = work.members.get(String(where.id));
            if (!row || !sameWhere(row, where)) return { count: 0 };
            work.members.set(String(where.id), { ...row, ...deepCopy(data) });
            return { count: 1 };
          },
        },
        catalogSku: {
          findUnique: async ({ where }: { where: Record<string, unknown> }) => {
            const nested = where.sourceSystem_sourceId as { sourceSystem: string; sourceId: string } | undefined;
            if (typeof where.id === "string") return work.skus.get(where.id) ?? null;
            if (typeof where.code === "string") return [...work.skus.values()].find((row) => row.code === where.code) ?? null;
            if (nested) return [...work.skus.values()].find((row) => row.sourceSystem === nested.sourceSystem && row.sourceId === nested.sourceId) ?? null;
            return null;
          },
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("catalogSku.createMany")) throw new Error("injected failure");
            for (const row of data) work.skus.set(String(row.id), deepCopy(row));
            return { count: data.length };
          },
          updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (!write("catalogSku.updateMany")) return { count: 0 };
            const row = work.skus.get(String(where.id));
            if (!row || !sameWhere(row, where)) return { count: 0 };
            work.skus.set(String(where.id), { ...row, ...deepCopy(data) });
            return { count: 1 };
          },
        },
        legacyIdentity: {
          findUnique: async ({ where }: { where: Record<string, unknown> }) => {
            const key = where.sourceSystem_sourceTable_sourceKey_destinationType as Record<string, string>;
            return work.identities.get([key.sourceSystem, key.sourceTable, key.sourceKey, key.destinationType].join("\0")) ?? null;
          },
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("legacyIdentity.createMany")) throw new Error("injected failure");
            for (const row of data) work.identities.set([row.sourceSystem, row.sourceTable, row.sourceKey, row.destinationType].join("\0"), deepCopy(row));
            return { count: data.length };
          },
        },
        operationObject: {
          findUnique: async ({ where }: { where: { id: string } }) => work.objects.get(where.id) ?? null,
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("operationObject.createMany")) throw new Error("injected failure");
            for (const row of data) work.objects.set(String(row.id), deepCopy(row));
            return { count: data.length };
          },
          updateMany: async ({ where, data }: { where: { id: string; kind: string; version: number }; data: { version: { increment: number } } }) => {
            if (!write("operationObject.updateMany")) return { count: 0 };
            const row = work.objects.get(where.id);
            if (!row || row.kind !== where.kind || row.version !== where.version) return { count: 0 };
            work.objects.set(where.id, { ...row, version: Number(row.version) + data.version.increment });
            return { count: 1 };
          },
        },
        operationAudit: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (!write("operationAudit.create")) throw new Error("injected failure");
            work.audits.push(deepCopy(data));
            return data;
          },
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            if (!write("operationAudit.createMany")) throw new Error("injected failure");
            work.audits.push(...deepCopy(data));
            return { count: data.length };
          },
        },
      };
      const result = await callback(tx);
      state = work;
      return result;
    },
  };
  return {
    client: db as never,
    state: () => state,
    writeAttempts: () => writeAttempts,
    transactions: () => transactions,
  };
}

test("effective values preserve Sheets types and reject malformed multi-value cells", () => {
  assert.deepEqual(appSheetCellEffectiveValue({ effectiveValue: { boolValue: false } }), { kind: "boolean", value: false });
  assert.deepEqual(appSheetCellEffectiveValue({ effectiveValue: { numberValue: 12.5 } }), { kind: "number", value: 12.5 });
  assert.deepEqual(appSheetCellEffectiveValue({ effectiveValue: { stringValue: "12.5" } }), { kind: "string", value: "12.5" });
  assert.deepEqual(appSheetCellEffectiveValue({ effectiveValue: { stringValue: "bad", numberValue: 1 } }), {
    kind: "error", value: { type: "INVALID_EFFECTIVE_VALUE", message: "" },
  });
});

test("canonical projection is pinned to the verified live AppSheet app id", () => {
  assert.equal(APPSHEET_EXPECTED_LIVE_APP_ID, "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0");
});

test("capture manifest separates populated rows from header-free source record count", () => {
  const prepared = prepareAppSheetCaptureManifest({
    schemaVersion: "appsheet-capture-manifest/v1",
    captureId: `appsreal-${"1".repeat(16)}`,
    sourceSystem,
    sourceId: spreadsheetId,
    spreadsheetId,
    metadataHash: "2".repeat(64), headersHash: "3".repeat(64), manifestHash: "1".repeat(64), dataHash: "4".repeat(64),
    definitionHash: null,
    stability: { stable: true },
    firstReadAt: fixtureDate,
    verificationStartedAt: "2026-10-09T10:01:00.000Z",
    verificationCompletedAt: "2026-10-09T10:02:00.000Z",
    cutoffAt: "2026-10-09T10:03:00.000Z",
    timestamps: { firstReadAt: fixtureDate, verificationStartedAt: "2026-10-09T10:01:00.000Z", verificationCompletedAt: "2026-10-09T10:02:00.000Z", cutoffAt: "2026-10-09T10:03:00.000Z" },
    coverage: { rowsWithValues: 4, bodySheetsCaptured: 2, totalPages: 2, formulaCellCount: 0, unresolvedFormulaCount: 0 },
    pages: [
      { sheetId: 11, counts: { rowsWithValues: 2 } },
      { sheetId: 12, counts: { rowsWithValues: 2 } },
    ],
    dataSheetCount: 2, dataPageCount: 2, dataRecordCount: 2, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
    definitionCoverage: null, definitionTableCount: null, definitionColumnCount: null, definitionSliceCount: null,
    definitionViewCount: null, definitionActionCount: null, definitionBotCount: null, definitionWorkflowRuleCount: null, definitionFormatRuleCount: null,
  });
  assert.equal(prepared.dataRecordCount, 2);
  assert.equal(prepared.dataCoverage.rowsWithValues, 4);
  assert.throws(() => prepareAppSheetCaptureManifest({
    schemaVersion: "appsheet-capture-manifest/v1", captureId: `appsreal-${"1".repeat(16)}`, sourceSystem,
    sourceId: spreadsheetId, spreadsheetId, metadataHash: "2".repeat(64), headersHash: "3".repeat(64),
    manifestHash: "1".repeat(64), dataHash: "4".repeat(64), definitionHash: null, stability: { stable: true },
    firstReadAt: fixtureDate, verificationStartedAt: "2026-10-09T10:01:00.000Z", verificationCompletedAt: "2026-10-09T10:02:00.000Z", cutoffAt: "2026-10-09T10:03:00.000Z",
    timestamps: { firstReadAt: fixtureDate, verificationStartedAt: "2026-10-09T10:01:00.000Z", verificationCompletedAt: "2026-10-09T10:02:00.000Z", cutoffAt: "2026-10-09T10:03:00.000Z" },
    coverage: { rowsWithValues: 4, bodySheetsCaptured: 2, totalPages: 2, formulaCellCount: 0, unresolvedFormulaCount: 0 },
    pages: [{ sheetId: 11, counts: { rowsWithValues: 2 } }, { sheetId: 12, counts: { rowsWithValues: 2 } }],
    dataSheetCount: 2, dataPageCount: 2, dataRecordCount: 5, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
    definitionCoverage: null, definitionTableCount: null, definitionColumnCount: null, definitionSliceCount: null,
    definitionViewCount: null, definitionActionCount: null, definitionBotCount: null, definitionWorkflowRuleCount: null, definitionFormatRuleCount: null,
  }));
});

test("canonical master preview retains provenance, prices, and inactive source availability", () => {
  const projection = project();
  assert.equal(projection.summary.recordCount, 2);
  assert.equal(projection.summary.memberTargetCount, 1);
  assert.equal(projection.summary.catalogueTargetCount, 1);
  assert.equal(projection.capture.stabilityMode, "stable");
  assert.equal(projection.definitionIdentityState, "missing-in-source-inventory");
  assert.equal(projection.capture.definitionHash, null);
  assert.equal(projection.appliedDefinitionHash, appSheetAppliedDefinitionHash(prepareAppSheetDefinitionInventory(definitionInventory(), projection.expectedAppId)));
  const sku = projection.destinations.find((destination) => destination.type === "sku");
  assert.ok(sku && sku.type === "sku");
  assert.equal(sku.data.active, false);
  assert.equal(sku.data.sourceId, "sku-1");
  assert.equal(sku.data.appSheet.availability, "Sí");
  const sourcePriceSchedule = sku.data.appSheet.sourcePriceSchedule as Array<Record<string, unknown>>;
  assert.deepEqual(sourcePriceSchedule.find((entry) => entry.field === "Precio_5_Gramos"), {
    field: "Precio_5_Gramos",
    coordinate: "G2",
    formula: null,
    userEnteredValue: { numberValue: 5.25 },
    effectiveValue: { numberValue: 5.25 },
    numberFormat: null,
  });
  assert.equal(sourcePriceSchedule.length, 12, "all present and missing source price/promotion fields remain traceable");
  assert.equal(projection.summary.globalDeltaBlockingCount, 0);
});

test("an omitted unresolved formula marker blocks its selected master field", () => {
  const projection = project({ unresolvedEmail: true });
  assert.equal(projection.summary.memberTargetCount, 0);
  assert.ok(projection.records.find((record) => record.sourceTable === "C_Cliente")?.exceptions.some((entry) =>
    entry.kind === "unresolved_formula_value" && entry.severity === "blocking"));
});

test("duplicate source keys and unique catalogue codes block every conflicting destination", () => {
  const duplicateKeys = project({ duplicateMemberKey: true });
  assert.equal(duplicateKeys.destinations.some((destination) => destination.type === "member"), false);
  assert.equal(duplicateKeys.records.filter((record) => record.sourceTable === "C_Cliente" &&
    record.exceptions.some((entry) => entry.kind === "duplicate_source_key" && entry.severity === "blocking")).length, 2);

  const duplicateCodes = project({ duplicateCatalogueCode: true });
  assert.equal(duplicateCodes.destinations.some((destination) => destination.type === "sku"), false);
  assert.equal(duplicateCodes.records.filter((record) => record.sourceTable === "D_Catalogo_Mercaderia" &&
    record.exceptions.some((entry) => entry.kind === "duplicate_catalogue_business_code" && entry.severity === "blocking")).length, 2);
});

test("staged delta requires an explicit option, keeps verified masters, and emits global blockers", async () => {
  assert.throws(() => project({ stagedDelta: true }), (error: unknown) =>
    error instanceof AppSheetCanonicalError && error.code === "staged_delta_requires_explicit_flag");
  const projection = project({ stagedDelta: true }, true);
  assert.equal(projection.capture.stabilityMode, "staged-delta");
  assert.equal(projection.capture.cutoffAt, null);
  assert.equal(projection.summary.memberTargetCount, 1);
  assert.equal(projection.summary.catalogueTargetCount, 1);
  assert.equal(projection.summary.globalDeltaBlockingCount, 1);
  assert.equal(projection.exceptions[0]?.sourceRecordId, null);

  let transactions = 0;
  await assert.rejects(stageAppSheetCanonicalMasters(projection, {
    actorId: "admin-fixture", technicalReview: {}, commitSha: "1".repeat(40), target: "isolated-test",
  }, { $transaction: async () => { transactions++; throw new Error("should not run"); } } as never),
  (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "staged_delta_requires_explicit_flag");
  assert.equal(transactions, 0, "default rejection must occur before any database transaction");
});

test("master staging reuses identical captures and refreshes only an unchanged pending baseline", async () => {
  const database = fakeDatabase();
  const preliminary = project({ stagedDelta: true, captureRevision: "preliminary-1" }, true);
  const preliminaryReview = technicalReview(preliminary);
  const first = await stageAppSheetCanonicalMasters(preliminary, {
    actorId: "admin-fixture", technicalReview: preliminaryReview, allowStagedDelta: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client);
  assert.equal(first.replay, false);
  assert.equal(database.state().members.size, 1);
  assert.equal(database.state().skus.size, 1);

  const repeatedPreliminary = await stageAppSheetCanonicalMasters(preliminary, {
    actorId: "admin-fixture", technicalReview: preliminaryReview, allowStagedDelta: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client);
  assert.equal(repeatedPreliminary.replay, true);
  assert.equal(database.state().snapshots.size, 1);

  const stableSame = project({ captureRevision: "stable-same" });
  const stableReview = technicalReview(stableSame);
  const promoted = await stageAppSheetCanonicalMasters(stableSame, {
    actorId: "admin-fixture", technicalReview: stableReview,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client);
  assert.equal(promoted.replay, false);
  assert.equal(database.state().snapshots.size, 2, "the preliminary and stable source snapshots remain separately traceable");
  assert.equal(database.state().members.size, 1, "an identical stable capture reuses the existing member");
  assert.equal(database.state().skus.size, 1, "an identical stable capture reuses the existing SKU");
  const reusedMemberId = [...database.state().members.keys()][0]!;
  assert.equal(database.state().objects.get(reusedMemberId)?.version, 0);

  const repeatedStable = await stageAppSheetCanonicalMasters(stableSame, {
    actorId: "admin-fixture", technicalReview: stableReview,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client);
  assert.equal(repeatedStable.replay, true);
  assert.equal(database.state().snapshots.size, 2);

  const changed = project({ captureRevision: "stable-changed", changedMemberName: "Updated from source" });
  const changedReview = technicalReview(changed);
  const beforeRejectedAttempt = database.state();
  const writesBeforeRejectedAttempt = database.writeAttempts();
  await assert.rejects(stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: changedReview,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "preliminary_master_refresh_requires_explicit_flag");
  assert.equal(database.writeAttempts(), writesBeforeRejectedAttempt, "changed source data is rejected before invoking any write");
  assert.equal(database.state().snapshots.size, beforeRejectedAttempt.snapshots.size);
  assert.equal([...database.state().members.values()][0]?.name, "Synthetic Member");

  const refreshed = await stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: changedReview, refreshPreliminary: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client);
  assert.equal(refreshed.replay, false);
  assert.equal(database.state().snapshots.size, 3, "a refresh adds a new immutable source snapshot");
  assert.equal([...database.state().members.values()][0]?.name, "Updated from source Member");
  const memberId = [...database.state().members.keys()][0]!;
  assert.equal(database.state().objects.get(memberId)?.version, 1, "refresh uses an optimistic operation-object version increment");
  const memberIdentity = [...database.state().identities.values()].find((identity) => identity.destinationType === "member");
  assert.equal(memberIdentity?.approvedBy, null, "source refresh never approves the legacy identity");
  const refreshAudit = database.state().audits.find((entry) => entry.action === "appsheet.canonical_master_refreshed");
  assert.ok(refreshAudit);
  const details = refreshAudit.details as Record<string, unknown>;
  assert.equal(details.previousSnapshotId, promoted.snapshotId);
  assert.notEqual(details.beforeHash, details.afterHash);
  assert.equal(details.expectedOperationVersion, 0);
  assert.equal(details.resultingOperationVersion, 1);
  assert.equal(database.state().objects.has("orders"), false, "master refresh does not create or mutate order state");
});

test("manual changes reject preliminary refresh without writes, and transaction failure rolls back staged writes", async () => {
  const seeded = fakeDatabase();
  const preliminary = project({ stagedDelta: true, captureRevision: "manual-preliminary" }, true);
  await stageAppSheetCanonicalMasters(preliminary, {
    actorId: "admin-fixture", technicalReview: technicalReview(preliminary), allowStagedDelta: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, seeded.client);

  const stable = project({ captureRevision: "manual-stable" });
  await stageAppSheetCanonicalMasters(stable, {
    actorId: "admin-fixture", technicalReview: technicalReview(stable),
    commitSha: "1".repeat(40), target: "isolated-test",
  }, seeded.client);

  const changed = project({ captureRevision: "manual-changed", changedMemberName: "Source update" });
  const assertRefreshRejectedWithoutWrites = async (state: FakeState, expectedCode: string) => {
    const database = fakeDatabase(state);
    const before = database.state();
    const writesBefore = database.writeAttempts();
    await assert.rejects(stageAppSheetCanonicalMasters(changed, {
      actorId: "admin-fixture", technicalReview: technicalReview(changed), refreshPreliminary: true,
      commitSha: "1".repeat(40), target: "isolated-test",
    }, database.client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === expectedCode);
    assert.equal(database.writeAttempts(), writesBefore);
    assert.equal(database.state().snapshots.size, before.snapshots.size);
    assert.equal([...database.state().members.values()][0]?.name, [...before.members.values()][0]?.name);
  };

  const reviewedState = deepCopy(seeded.state());
  const latestSnapshot = [...reviewedState.snapshots.values()].sort((a, b) =>
    (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())[0]!;
  reviewedState.snapshots.set(String(latestSnapshot.id), {
    ...latestSnapshot,
    status: "reviewed",
    reviewedBy: "human-reviewer",
    reviewedAt: new Date(fixtureDate),
  });
  await assertRefreshRejectedWithoutWrites(reviewedState, "preliminary_master_refresh_snapshot_not_pending");

  const approvedIdentityState = deepCopy(seeded.state());
  const [identityKey, identity] = [...approvedIdentityState.identities.entries()][0]!;
  approvedIdentityState.identities.set(identityKey, { ...identity, approvedBy: "human-reviewer" });
  await assertRefreshRejectedWithoutWrites(approvedIdentityState, "preliminary_master_refresh_identity_approved");

  const manualState = deepCopy(seeded.state());
  const member = [...manualState.members.values()][0]!;
  manualState.members.set(String(member.id), { ...member, name: "Edited in Bombo" });
  const operationObject = manualState.objects.get(String(member.id))!;
  manualState.objects.set(String(member.id), { ...operationObject, version: Number(operationObject.version) + 1 });
  const manualDb = fakeDatabase(manualState);
  const writesBefore = manualDb.writeAttempts();
  await assert.rejects(stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: technicalReview(changed), refreshPreliminary: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, manualDb.client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "preliminary_master_refresh_manual_change_detected");
  assert.equal(manualDb.writeAttempts(), writesBefore, "manual target content is rejected before invoking writes");
  assert.equal(manualDb.state().members.get(String(member.id))?.name, "Edited in Bombo");
  assert.equal(manualDb.state().snapshots.size, manualState.snapshots.size);

  const rollbackDb = fakeDatabase(seeded.state(), "operationAudit.createMany");
  const beforeRollback = rollbackDb.state();
  await assert.rejects(stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: technicalReview(changed), refreshPreliminary: true,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, rollbackDb.client), /injected failure/);
  assert.equal(rollbackDb.state().members.get(String(member.id))?.name, beforeRollback.members.get(String(member.id))?.name);
  assert.equal(rollbackDb.state().objects.get(String(member.id))?.version, beforeRollback.objects.get(String(member.id))?.version);
  assert.equal(rollbackDb.state().snapshots.size, beforeRollback.snapshots.size);
  assert.equal(rollbackDb.state().manifests.size, beforeRollback.manifests.size);
  assert.equal(rollbackDb.state().audits.length, beforeRollback.audits.length);
});

test("the staging entry rejects a review bound to another commit before any database write", async () => {
  const projection = project({ captureRevision: "wrong-review-commit" });
  const review = { ...technicalReview(projection), commitSha: "2".repeat(40) };
  const database = fakeDatabase();
  await assert.rejects(stageAppSheetCanonicalMasters(projection, {
    actorId: "admin-fixture", technicalReview: review,
    commitSha: "1".repeat(40), target: "isolated-test",
  }, database.client));
  assert.equal(database.transactions(), 1, "the public staging entry was exercised");
  assert.equal(database.writeAttempts(), 0, "review mismatch is rejected before persisted state changes");
  assert.equal(database.state().snapshots.size, 0);
  assert.equal(database.state().members.size, 0);
  assert.equal(database.state().skus.size, 0);
});

test("CLI target parsing keeps preview isolated and requires backup for explicit production apply", () => {
  const root = "/tmp/bombo-canonical-fixture";
  const preview = parseArgs([], root);
  assert.notEqual(preview, "help");
  if (preview === "help") return;
  assert.equal(preview.target, "isolated-test");
  assert.equal(preview.apply, false);
  assert.throws(() => parseArgs(["--target", "production"], root), (error: unknown) =>
    error instanceof AppSheetCanonicalError && error.code === "production_apply_and_backup_required");
  assert.throws(() => parseArgs(["--target", "production", "--apply", "--actor-id", "admin", "--review", "review.json"], root), (error: unknown) =>
    error instanceof AppSheetCanonicalError && error.code === "production_apply_and_backup_required");
  assert.throws(() => parseArgs(["--target", "unknown"], root), (error: unknown) =>
    error instanceof AppSheetCanonicalError && error.code === "target_invalid");
  assert.throws(() => parseArgs(["--refresh-preliminary"], root), (error: unknown) =>
    error instanceof AppSheetCanonicalError && error.code === "refresh_preliminary_requires_apply");
  const refresh = parseArgs(["--apply", "--actor-id", "admin", "--review", "review.json", "--refresh-preliminary"], root);
  assert.notEqual(refresh, "help");
  if (refresh !== "help") assert.equal(refresh.refreshPreliminary, true);
  const production = parseArgs(["--target", "production", "--apply", "--actor-id", "admin", "--review", "review.json", "--backup-reference", "/backup"], root);
  assert.notEqual(production, "help");
  if (production !== "help") assert.equal(production.target, "production");
});

test("technical review is bound to the exact source commit", () => {
  const projection = project();
  const expected = {
    captureId: projection.capture.captureId,
    manifestHash: projection.capture.manifestHash,
    definitionHash: projection.appliedDefinitionHash,
    projectionKind: "masters" as const,
    projectionHash: projection.projectionHash,
    commitSha: "9".repeat(40),
    importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
  };
  const review = {
    schemaVersion: 1,
    reviewKind: "independent-technical",
    ...expected,
    reviewer: "synthetic-independent-reviewer",
    approved: true,
    reviewedAt: fixtureDate,
    findings: [],
  };
  assert.equal(requireAppSheetTechnicalReview(review, expected).commitSha, expected.commitSha);
  assert.throws(() => requireAppSheetTechnicalReview(review, { ...expected, commitSha: "8".repeat(40) }));
});
