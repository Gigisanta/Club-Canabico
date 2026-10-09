import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  analyzeAppSheetHistoryMovementMatches,
  appSheetHistoryCoverageFingerprint,
  AppSheetHistoryStageError,
  buildAppSheetPendingSourceRecord,
  formatCellData,
  stageAppSheetHistoryProjection,
  type PreparedAppSheetHistoryProjection,
} from "../server/operations/appsheet-history.js";
import { APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS } from "../shared/operations/appsheet-history.js";
import { pendingMappingFingerprintPayload, reconcileAppSheetPendingRows } from "../shared/operations/appsheet-pending.js";
import { parseAppSheetHistoryCliArgs, privateAppSheetChildPath, runAppSheetHistoryCli } from "../scripts/appsheet-history.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
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

function stageReview() {
  return {
    schemaVersion: 1 as const,
    reviewKind: "independent-technical" as const,
    captureId: pendingCapture.captureId,
    manifestHash: pendingCapture.manifestHash,
    definitionHash: "c".repeat(64),
    projectionKind: "history" as const,
    projectionHash: "d".repeat(64),
    commitSha: "e".repeat(40),
    importer: "bombo-appsheet-history/1.0.0",
    reviewer: "independent-reviewer",
    approved: true as const,
    reviewedAt: "2026-10-09T12:00:00.000Z",
    findings: [],
  };
}

test("invalid review is rejected before opening a write transaction", async () => {
  let transactionCount = 0;
  const client = { $transaction: async () => { transactionCount++; throw new Error("must_not_start"); } } as unknown as PrismaClient;
  await assert.rejects(stageAppSheetHistoryProjection(stageFixture(), {
    actorId: "authorized-user", technicalReview: { ...stageReview(), projectionHash: "f".repeat(64) },
    commitSha: "e".repeat(40), allowStagedDelta: true, target: "isolated-test",
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
    legacySourceRecord: { createMany: async () => { rows.push("source-records"); } },
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
  await assert.rejects(stageAppSheetHistoryProjection(stageFixture(), {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test",
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  }, client), /injected_audit_failure/);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
  assert.deepEqual(rows, []);
});

test("replaying a staged history snapshot compares boolean and count metadata without exact-money coercion", async () => {
  let snapshot: Record<string, unknown> | null = null;
  let operationObject: Record<string, unknown> | null = null;
  let audit: Record<string, unknown> | null = null;
  let writes = 0;
  const tx = {
    user: { findUnique: async () => ({ id: "authorized-user", role: "admin", active: true }) },
    operationAccess: { findUnique: async () => ({ enabled: true, capabilities: ["imports.write"] }) },
    legacyImportSnapshot: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        "id" in where ? snapshot : snapshot,
      create: async ({ data }: { data: Record<string, unknown> }) => { snapshot = data; writes++; },
    },
    legacySourceRecord: { createMany: async () => { writes++; } },
    legacyHistoricalFact: { createMany: async () => { writes++; } },
    legacyException: { createMany: async () => { writes++; } },
    operationObject: {
      create: async ({ data }: { data: Record<string, unknown> }) => { operationObject = data; writes++; },
      findUnique: async () => operationObject,
    },
    operationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { audit = data; writes++; },
      findFirst: async () => audit,
    },
    legacySourceRecordFind: async () => [],
  };
  Object.assign(tx, {
    legacySourceRecord: { createMany: async () => { writes++; }, findMany: async () => [] },
    legacyHistoricalFact: { createMany: async () => { writes++; }, findMany: async () => [] },
    legacyException: { createMany: async () => { writes++; }, findMany: async () => [] },
  });
  const client = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  const options = {
    actorId: "authorized-user", technicalReview: stageReview(), commitSha: "e".repeat(40),
    allowStagedDelta: true, target: "isolated-test" as const,
    backupEvidence: { manifestHash: "9".repeat(64), snapshotAt: "2026-10-09T12:00:00.000Z" },
  };

  const first = await stageAppSheetHistoryProjection(stageFixture(), options, client);
  assert.equal(first.replay, false);
  const writesAfterStage = writes;
  assert.ok(writesAfterStage > 0);
  assert.equal((snapshot?.status), "staged");
  assert.equal((snapshot?.reviewedBy), null);

  const replay = await stageAppSheetHistoryProjection(stageFixture(), options, client);
  assert.equal(replay.replay, true);
  assert.equal(writes, writesAfterStage);
});

test("CLI apply refuses a dirty checkout before reading the source or opening a database", async () => {
  const result = await runAppSheetHistoryCli([
    "--apply", "--allow-staged-delta", "--actor-id", "authorized-user",
    "--review", "review.json", "--backup-reference", "/unused/backup",
  ], process.cwd());
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.output), { status: "error", code: "apply_requires_clean_committed_worktree" });
});
