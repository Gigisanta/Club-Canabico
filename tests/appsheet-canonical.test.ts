import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import test from "node:test";
import {
  appSheetCellEffectiveValue,
  prepareAppSheetCaptureManifest,
} from "../shared/operations/appsheet-canonical.js";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
  AppSheetCanonicalError,
  appSheetAppliedDefinitionHash,
  appSheetCanonicalProjectionReport,
  appSheetCanonicalCurrentDestinationHash,
  appSheetDefinitionParserSupportsProduction,
  prepareAppSheetDefinitionInventory,
  prepareAppSheetMasterProjection,
  stageAppSheetCanonicalMasters,
} from "../server/operations/appsheet-canonical.js";
import { eligibleAppSheetCanonicalMemberIds } from "../server/operations/access.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION } from "../shared/operations/appsheet-canonical.js";
import { parseArgs } from "../scripts/appsheet-canonical.js";
import { requireAppSheetTechnicalReview } from "../shared/operations/appsheet-review.js";
import { definitionInventory, fixtureDate, hash, project, sourceSystem, spreadsheetId, technicalReview } from "./support/appsheet-canonical-fixture.js";

const ISOLATED_TEST_DESTINATION_ID = appSheetDatabaseDestinationIdentity("isolated-test",
  new URL("postgresql://127.0.0.1:5432/bombo_ui_canonical?schema=public"));
const PRODUCTION_DESTINATION_ID = appSheetDatabaseDestinationIdentity("production",
  new URL("postgresql://db.example.invalid:5432/bombo?schema=public"));

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
        operationAuthority: { findUnique: async () => null },
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

test("definition parser support is numeric and legacy or incomplete inventories stay archive-only", async () => {
  assert.equal(appSheetDefinitionParserSupportsProduction("bombo-appsheet-definition/1.1.0"), false);
  assert.equal(appSheetDefinitionParserSupportsProduction("bombo-appsheet-definition/1.2.0"), true);
  assert.equal(appSheetDefinitionParserSupportsProduction("bombo-appsheet-definition/1.10.0"), true);
  assert.equal(appSheetDefinitionParserSupportsProduction("bombo-appsheet-definition/2.0.0"), true);
  assert.equal(appSheetDefinitionParserSupportsProduction("fixture-parser/10"), false);

  const legacyProjection = project();
  assert.equal(appSheetCanonicalProjectionReport(legacyProjection).definitionReadinessState, "isolated-archive-only");
  let transactions = 0;
  const client = { $transaction: async () => { transactions++; throw new Error("must_not_start"); } } as never;
  await assert.rejects(stageAppSheetCanonicalMasters(legacyProjection, {
    actorId: "admin-fixture", technicalReview: technicalReview(legacyProjection), commitSha: "1".repeat(40),
    target: "production", destinationIdentity: PRODUCTION_DESTINATION_ID,
  }, client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "definition_parser_version_unsupported");
  assert.equal(transactions, 0, "a parser older than 1.2 is rejected before opening a transaction");

  const incompleteProjection = project();
  incompleteProjection.definitionInventory = {
    ...incompleteProjection.definitionInventory,
    parserVersion: "bombo-appsheet-definition/1.10.0",
    app: { id: APPSHEET_EXPECTED_LIVE_APP_ID, name: null, version: null, deploymentState: null, generatedAt: null },
  };
  await assert.rejects(stageAppSheetCanonicalMasters(incompleteProjection, {
    actorId: "admin-fixture", technicalReview: technicalReview(incompleteProjection), commitSha: "1".repeat(40),
    target: "production", destinationIdentity: PRODUCTION_DESTINATION_ID,
  }, client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "definition_app_metadata_incomplete");
  assert.equal(transactions, 0, "incomplete app metadata is rejected before opening a transaction");
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
    actorId: "admin-fixture", technicalReview: {}, commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
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
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, database.client);
  assert.equal(first.replay, false);
  assert.equal(database.state().members.size, 1);
  assert.equal(database.state().skus.size, 1);
  const firstControls = database.state().snapshots.get(first.snapshotId)?.controls as {
    appSheetCanonical: { definitionReadiness: { state: string }; technicalReview: Record<string, unknown> };
  };
  assert.equal(firstControls.appSheetCanonical.definitionReadiness.state, "isolated-archive-only");
  assert.equal(firstControls.appSheetCanonical.technicalReview.schemaVersion, 1);
  assert.equal(firstControls.appSheetCanonical.technicalReview.bindingSource, "legacy-isolated-only");
  assert.equal("target" in firstControls.appSheetCanonical.technicalReview, false);
  assert.equal("destinationIdentity" in firstControls.appSheetCanonical.technicalReview, false);

  const repeatedPreliminary = await stageAppSheetCanonicalMasters(preliminary, {
    actorId: "admin-fixture", technicalReview: preliminaryReview, allowStagedDelta: true,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, database.client);
  assert.equal(repeatedPreliminary.replay, true);
  assert.equal(database.state().snapshots.size, 1);

  const stableSame = project({ captureRevision: "stable-same" });
  const stableReview = technicalReview(stableSame);
  const promoted = await stageAppSheetCanonicalMasters(stableSame, {
    actorId: "admin-fixture", technicalReview: stableReview,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, database.client);
  assert.equal(promoted.replay, false);
  assert.equal(database.state().snapshots.size, 2, "the preliminary and stable source snapshots remain separately traceable");
  assert.equal(database.state().members.size, 1, "an identical stable capture reuses the existing member");
  assert.equal(database.state().skus.size, 1, "an identical stable capture reuses the existing SKU");
  const reusedMemberId = [...database.state().members.keys()][0]!;
  assert.equal(database.state().objects.get(reusedMemberId)?.version, 0);

  const repeatedStable = await stageAppSheetCanonicalMasters(stableSame, {
    actorId: "admin-fixture", technicalReview: stableReview,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, database.client);
  assert.equal(repeatedStable.replay, true);
  assert.equal(database.state().snapshots.size, 2);

  const changed = project({ captureRevision: "stable-changed", changedMemberName: "Updated from source" });
  const changedReview = technicalReview(changed);
  const beforeRejectedAttempt = database.state();
  const writesBeforeRejectedAttempt = database.writeAttempts();
  await assert.rejects(stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: changedReview,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, database.client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "preliminary_master_refresh_requires_explicit_flag");
  assert.equal(database.writeAttempts(), writesBeforeRejectedAttempt, "changed source data is rejected before invoking any write");
  assert.equal(database.state().snapshots.size, beforeRejectedAttempt.snapshots.size);
  assert.equal([...database.state().members.values()][0]?.name, "Synthetic Member");

  const refreshed = await stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: changedReview, refreshPreliminary: true,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
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
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, seeded.client);

  const stable = project({ captureRevision: "manual-stable" });
  await stageAppSheetCanonicalMasters(stable, {
    actorId: "admin-fixture", technicalReview: technicalReview(stable),
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, seeded.client);

  const changed = project({ captureRevision: "manual-changed", changedMemberName: "Source update" });
  const assertRefreshRejectedWithoutWrites = async (state: FakeState, expectedCode: string) => {
    const database = fakeDatabase(state);
    const before = database.state();
    const writesBefore = database.writeAttempts();
    await assert.rejects(stageAppSheetCanonicalMasters(changed, {
      actorId: "admin-fixture", technicalReview: technicalReview(changed), refreshPreliminary: true,
      commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
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
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  }, manualDb.client), (error: unknown) => error instanceof AppSheetCanonicalError && error.code === "preliminary_master_refresh_manual_change_detected");
  assert.equal(manualDb.writeAttempts(), writesBefore, "manual target content is rejected before invoking writes");
  assert.equal(manualDb.state().members.get(String(member.id))?.name, "Edited in Bombo");
  assert.equal(manualDb.state().snapshots.size, manualState.snapshots.size);

  const rollbackDb = fakeDatabase(seeded.state(), "operationAudit.createMany");
  const beforeRollback = rollbackDb.state();
  await assert.rejects(stageAppSheetCanonicalMasters(changed, {
    actorId: "admin-fixture", technicalReview: technicalReview(changed), refreshPreliminary: true,
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
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
    commitSha: "1".repeat(40), target: "isolated-test", destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
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
  assert.match(preview.definitionPath, /appsheet-definition-inventory-live-parity-final\.json$/);
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
    target: "isolated-test" as const,
    destinationIdentity: ISOLATED_TEST_DESTINATION_ID,
  };
  const review = {
    schemaVersion: 2,
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

test("capture-bound member review survives a later capture review and follows only its selected capture", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const credentialedDatabaseUrl = new URL("postgresql://127.0.0.1/bombo_ui_capture_review?schema=synthetic");
  credentialedDatabaseUrl.username = randomUUID();
  credentialedDatabaseUrl.password = randomBytes(32).toString("base64url");
  const databaseUrl = credentialedDatabaseUrl.toString();
  process.env.DATABASE_URL = databaseUrl;
  try {
    const first = project({ captureRevision: "identity-review-capture-a" });
    const second = project({ captureRevision: "identity-review-capture-b" });
    const firstCapture = first.capture;
    const secondCapture = second.capture;
    const destinationIdentity = appSheetDatabaseDestinationIdentity("production", new URL(databaseUrl));
    const projectedMember = first.destinations.find((destination) => destination.type === "member");
    assert.ok(projectedMember && projectedMember.type === "member");
    const member = { id: projectedMember.id, ...projectedMember.data };
    const destinationDataHash = appSheetCanonicalCurrentDestinationHash(member, "member");
    const firstRecord = first.records.find((record) => record.sourceTable === "C_Cliente");
    const secondRecord = second.records.find((record) => record.sourceTable === "C_Cliente");
    assert.ok(firstRecord && secondRecord);

    const asStoredCapture = (capture: typeof firstCapture) => {
      const pageManifest = capture.pageManifest;
      const pageRefs = pageManifest.map((page) => ({ path: page.path, sheetId: page.sheetId, pageIndex: page.pageIndex,
        startRow: page.startRow, endRow: page.endRow, pageHash: page.pageHash, counts: page.counts }));
      const sheets: Array<Record<string, unknown>> = pageManifest.map((page) => ({ sheetId: page.sheetId, title: page.title, pageCount: 1,
        verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false }));
      sheets.push({ sheetId: 99, title: "T_Usuarios", pageCount: 0, verifiedPageCount: 0, stablePageCount: 0,
        changedPageCount: 0, bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted" });
      return {
      captureId: capture.captureId,
      sourceSystem: capture.sourceSystem,
      sourceId: capture.sourceId,
      spreadsheetId: capture.spreadsheetId,
      metadataHash: capture.metadataHash,
      headersHash: capture.headersHash,
      manifestHash: capture.manifestHash,
      dataHash: hash(pageRefs),
      definitionHash: capture.definitionHash,
      stability: { ...capture.stability, cutoverEligible: true, missingPages: 0, unresolvedFormulaCount: 0,
        sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"] },
      firstReadAt: new Date(capture.firstReadAt!),
      verificationStartedAt: new Date(capture.verificationStartedAt!),
      verificationCompletedAt: new Date(capture.verificationCompletedAt!),
      cutoffAt: new Date(capture.cutoffAt!),
      dataCoverage: { ...capture.dataCoverage, metadataStable: true, headersStableAll: true, failedPages: 0,
        changedPages: 0, unresolvedFormulaCount: 0, sheets },
      pageManifest,
      definitionCoverage: capture.definitionCoverage,
      dataSheetCount: capture.dataSheetCount,
      dataPageCount: capture.dataPageCount,
      dataRecordCount: capture.dataRecordCount,
      dataFormulaCount: capture.dataFormulaCount,
      dataUnresolvedFormulaCount: capture.dataUnresolvedFormulaCount,
      definitionTableCount: capture.definitionTableCount,
      definitionColumnCount: capture.definitionColumnCount,
      definitionSliceCount: capture.definitionSliceCount,
      definitionViewCount: capture.definitionViewCount,
      definitionActionCount: capture.definitionActionCount,
      definitionBotCount: capture.definitionBotCount,
      definitionWorkflowRuleCount: capture.definitionWorkflowRuleCount,
      definitionFormatRuleCount: capture.definitionFormatRuleCount,
      };
    };
    const storedCaptures = new Map([
      [firstCapture.captureId, asStoredCapture(firstCapture)],
      [secondCapture.captureId, asStoredCapture(secondCapture)],
    ]);
    const fingerprint = {
      sourceTable: "C_Cliente", sourceKey: firstRecord.sourceKey, destinationType: "member", destinationId: member.id,
      dataHash: destinationDataHash, operationVersion: 0,
    };
    const snapshot = (id: string, capture: typeof firstCapture, projectionHash: string, reviewedBy: string, reviewedAt: Date) => ({
      id, status: "reviewed", createdBy: "importer", reviewedBy, reviewedAt, fileHash: capture.manifestHash,
      sourceSystem, importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION, captureManifestId: capture.captureId,
      controls: { appSheetCanonical: { projectionHash, stageContext: { target: "production", destinationIdentity }, destinationFingerprints: [fingerprint] } },
      coverage: {},
    });
    const firstReviewedAt = new Date(fixtureDate);
    const secondReviewedAt = new Date(new Date(fixtureDate).getTime() + 10_000);
    const firstSnapshot = snapshot("snapshot-capture-a", firstCapture, first.projectionHash, "checker-a", firstReviewedAt);
    const secondSnapshot = snapshot("snapshot-capture-b", secondCapture, second.projectionHash, "checker-b", secondReviewedAt);
    const identity: { id: string; sourceSystem: string; sourceTable: string; sourceKey: string; destinationType: string; destinationId: string; approvedBy: string | null } = {
      id: "identity-customer-1", sourceSystem, sourceTable: "C_Cliente", sourceKey: firstRecord.sourceKey,
      destinationType: "member", destinationId: member.id, approvedBy: "checker-b",
    };
    const firstRecordForReview = { ...firstRecord, snapshotId: firstSnapshot.id };
    const secondRecordForReview = { ...secondRecord, snapshotId: secondSnapshot.id };
    const reviewDetails = (snapshotId: string, capture: typeof firstCapture, projectionHash: string) => ({
      schemaVersion: 1, snapshotId, captureId: capture.captureId, manifestHash: capture.manifestHash, projectionHash,
      destinationIdentity, identityCount: 2, expectedIdentityCount: 2,
    });
    const identityDetails = (snapshotId: string, capture: typeof firstCapture, projectionHash: string, reviewer: string, recordId: string) => ({
      schemaVersion: 1, identityId: identity.id, snapshotId, captureId: capture.captureId, manifestHash: capture.manifestHash,
      projectionHash, destinationIdentity, sourceRecordId: recordId, sourceTable: "C_Cliente", sourceKey: identity.sourceKey,
      sourceContentHash: snapshotId === firstSnapshot.id ? firstRecord.contentHash : secondRecord.contentHash,
      destinationType: "member", destinationId: member.id, destinationDataHash, approvedBy: reviewer,
    });
    const snapshotAudit = (snapshotId: string, requestId: string, reviewer: string, details: unknown, createdAt: Date) => ({
      actorId: reviewer, action: "appsheet.canonical_identities_reviewed", objectId: snapshotId, requestId, details, createdAt,
    });
    const identityAudit = (snapshotId: string, requestId: string, reviewer: string, details: unknown, createdAt: Date) => ({
      actorId: reviewer, action: "appsheet.canonical_identity_reviewed", objectId: identity.id, requestId, details, createdAt,
    });
    const audits: Array<Record<string, unknown>> = [
      snapshotAudit(firstSnapshot.id, "request-a", "checker-a", reviewDetails(firstSnapshot.id, firstCapture, first.projectionHash), firstReviewedAt),
      identityAudit(firstSnapshot.id, "request-a", "checker-a", identityDetails(firstSnapshot.id, firstCapture, first.projectionHash, "checker-a", firstRecord.id), firstReviewedAt),
    ];
    let snapshots = [firstSnapshot];
    let currentObjectVersion = 0;
    const commandReceipts: Array<{
      requestId: string; actorId: string; targetId: string; command: string; response: Record<string, unknown>;
      resultingVersion: number; committedAt: Date;
    }> = [];
    const tx = {
      appSheetCaptureManifest: { findUnique: async ({ where }: { where: { captureId: string } }) => storedCaptures.get(where.captureId) ?? null },
      legacyImportSnapshot: { findMany: async ({ where }: { where: Record<string, unknown> }) => snapshots.filter((row) =>
        row.captureManifestId === where.captureManifestId && row.fileHash === where.fileHash && row.importerVersion === where.importerVersion) },
      user: { findUnique: async ({ where }: { where: { id: string } }) => ({ active: ["checker-a", "checker-b"].includes(where.id) }) },
      operationAudit: { findMany: async ({ where, take }: { where: Record<string, any>; take?: number }) => audits.filter((row) => {
        const ids = typeof where.objectId === "string" ? [where.objectId] : where.objectId?.in as string[] | undefined;
        const actionFilter = where.action;
        const actions = typeof actionFilter === "string" ? [actionFilter] : actionFilter?.in as string[] | undefined;
        const requestFilter = where.requestId;
        const requestIds = typeof requestFilter === "string" ? [requestFilter] : requestFilter?.in as string[] | undefined;
        return (!ids || ids.includes(String(row.objectId))) && (!actions || actions.includes(String(row.action))) &&
          (!requestIds || requestIds.includes(String(row.requestId)));
      }).slice(0, take === undefined ? undefined : take) },
      operationMember: { findMany: async () => [member] },
      legacySourceRecord: { findMany: async ({ where }: { where: Record<string, any> }) => [firstRecordForReview, secondRecordForReview].filter((record) =>
        record && record.snapshotId === where.snapshotId && record.sourceTable === where.sourceTable && where.sourceKey.in.includes(record.sourceKey)) },
      legacyIdentity: { findMany: async () => [identity] },
      operationObject: { findMany: async () => [{ id: member.id, kind: "member", version: currentObjectVersion }] },
      commandReceipt: { findMany: async () => commandReceipts },
    };

    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set([member.id]),
      "la aprobación exacta de A sigue válida aunque approvedBy apunte al checker de B");
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, secondCapture.captureId), new Set(),
      "B no habilita la identidad hasta que exista su auditoría ligada a la captura");

    snapshots = [...snapshots, secondSnapshot];
    audits.push(
      snapshotAudit(secondSnapshot.id, "request-b", "checker-b", reviewDetails(secondSnapshot.id, secondCapture, second.projectionHash), secondReviewedAt),
      identityAudit(secondSnapshot.id, "request-b", "checker-b", identityDetails(secondSnapshot.id, secondCapture, second.projectionHash, "checker-b", secondRecord.id), secondReviewedAt),
    );
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, secondCapture.captureId), new Set([member.id]),
      "B habilita la identidad sólo después de su propia revisión exacta");

    const transactionStartedAt = new Date(secondReviewedAt.getTime() + 100);
    const permissionReviewedAt = new Date(transactionStartedAt.getTime() + 25);
    const permissionResult = {
      memberId: member.id, status: "verified", reviewerId: "permission-reviewer", reviewedAt: permissionReviewedAt.toISOString(),
    };
    const permissionReceipt = {
      requestId: "permission-after-review", actorId: "permission-reviewer", targetId: member.id, command: "PermissionVerified",
      response: { requestId: "permission-after-review", targetId: member.id, version: 1, result: { permission: permissionResult } },
      resultingVersion: 1, committedAt: transactionStartedAt,
    };
    assert.ok(permissionReviewedAt > permissionReceipt.committedAt,
      "el timestamp semántico del permiso ocurre después del now() de inicio de transacción del receipt");
    commandReceipts.push(permissionReceipt);
    audits.push({ actorId: permissionReceipt.actorId, action: permissionReceipt.command, objectId: member.id,
      requestId: permissionReceipt.requestId, details: { version: permissionReceipt.resultingVersion }, createdAt: transactionStartedAt });
    currentObjectVersion = 1;
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set([member.id]),
      "un permiso legítimo conserva elegibilidad aunque reviewedAt sea posterior a committedAt de inicio de transacción");
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, secondCapture.captureId), new Set([member.id]));

    permissionResult.reviewedAt = new Date(secondReviewedAt.getTime() - 1).toISOString();
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set([member.id]),
      "el mismo resultado posterior al baseline de A sigue siendo causal para A");
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, secondCapture.captureId), new Set([member.id]),
      "el receipt, la auditoría y la versión prueban causalidad aunque reviewedAt sea anterior al baseline de B");
    permissionResult.reviewedAt = "not-a-timestamp";
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set(),
      "una marca temporal malformada no habilita A aunque exista una cadena causal");
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, secondCapture.captureId), new Set(),
      "una marca temporal malformada no habilita B aunque exista una cadena causal");
    permissionResult.reviewedAt = permissionReviewedAt.toISOString();
    currentObjectVersion = 2;
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set(),
      "un salto de versión sin receipt causal no conserva elegibilidad");
    currentObjectVersion = 1;

    identity.approvedBy = null;
    assert.deepEqual(await eligibleAppSheetCanonicalMemberIds(tx as never, firstCapture.captureId), new Set(),
      "la revocación explícita de approvedBy invalida una aprobación previa");
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
