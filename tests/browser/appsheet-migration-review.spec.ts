import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Page, Route } from "@playwright/test";
import type { CommandEnvelope } from "../../shared/operations/contracts.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../../shared/operations/appsheet-history.js";
import { appSheetDeliveryInvoiceReferenceMatches } from "../../shared/operations/appsheet-pending-import.js";
import { appSheetDatabaseDestinationIdentity } from "../../server/operations/appsheet-database-target.js";
import { prepareAppSheetHistoryProjection, stageAppSheetHistoryProjection } from "../../server/operations/appsheet-history.js";
import { prepareAppSheetPendingImportPlan, appSheetPendingOrderCommercialBasisHash } from "../../server/operations/appsheet-pending-import.js";
import { db } from "../../server/db.js";
import "../../server/operations/appsheet-history-review.js";
import "../../server/operations/finance.js";
import { syntheticPendingHistorySource } from "../support/appsheet-pending-import-fixture.js";
import { expect, getIsolatedE2EPassword, test } from "./isolated";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sha256Canonical = (value: unknown) => sha256(canonicalJson(value));

interface ScenarioCleanupState {
  actorIds?: Record<string, string>;
  userEmails: Map<string, string>;
  userIds: Set<string>;
  operationAccess: Map<string, string[]>;
  requestIds: Set<string>;
  objectExpectations: Map<string, { kind: string; createdBy: string; minimumVersion: number; maximumVersion: number }>;
  captureCandidate?: { id: string; sourceId: string; manifestHash: string; dataHash: string };
  snapshotCandidate?: {
    id: string;
    captureId: string;
    fileHash: string;
    importerVersion: string;
    createdBy: string;
    records: Array<{ id: string; sourceTable: string; sourceKey: string; fileHash: string; contentHash: string; importerVersion: string }>;
    factIds: string[];
    exceptionIds: string[];
  };
  batchCandidate?: { id: string; snapshotId: string; captureId: string; createdBy: string };
  memberCandidate?: { id: string; name: string };
  orderCandidate?: { id: string; memberId: string; createdBy: string; lineId: string };
  identityCandidate?: { id: string; sourceKey: string; destinationId: string; approvedBy: string };
  deliveryIds: Set<string>;
}

function newScenarioCleanupState(): ScenarioCleanupState {
  return {
    userEmails: new Map(), userIds: new Set(), operationAccess: new Map(), requestIds: new Set(),
    objectExpectations: new Map(), deliveryIds: new Set(),
  };
}

function requireCleanupOwnership(condition: unknown): asserts condition {
  if (!condition) throw new Error("Limpieza E2E cancelada: no se pudo demostrar que todos los registros afectados pertenecen a este escenario.");
}

function assertIsolatedCleanupDatabase(): void {
  if (process.env.BOMBO_E2E_ISOLATED !== "1")
    throw new Error("Limpieza E2E cancelada fuera de la base descartable aislada.");
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    const schema = url.searchParams.get("schema") ?? "";
    requireCleanupOwnership(["postgres:", "postgresql:"].includes(url.protocol));
    requireCleanupOwnership(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    requireCleanupOwnership(/^bombo_e2e_[a-z0-9_]+$/i.test(schema));
  } catch {
    throw new Error("Limpieza E2E cancelada: el destino no coincide con el esquema loopback descartable.");
  }
}

async function cleanupDestinationReviewScenario(state: ScenarioCleanupState): Promise<void> {
  if (!state.userIds.size && !state.captureCandidate && !state.memberCandidate && !state.orderCandidate &&
      !state.identityCandidate && !state.deliveryIds.size && !state.requestIds.size && !state.objectExpectations.size) return;
  assertIsolatedCleanupDatabase();

  await db.$transaction(async tx => {
    const actorIds = [...state.userIds];
    const objectIds = [...state.objectExpectations.keys()];
    const snapshotId = state.snapshotCandidate?.id;
    const captureId = state.captureCandidate?.id;
    const batchId = state.batchCandidate?.id;
    const orderId = state.orderCandidate?.id;
    const memberId = state.memberCandidate?.id;
    const [capture, snapshot, batch, member, order] = await Promise.all([
      captureId ? tx.appSheetCaptureManifest.findUnique({ where: { captureId } }) : null,
      snapshotId ? tx.legacyImportSnapshot.findUnique({ where: { id: snapshotId } }) : null,
      batchId ? tx.appSheetPendingImportBatch.findUnique({ where: { id: batchId } }) : null,
      memberId ? tx.operationMember.findUnique({ where: { id: memberId } }) : null,
      orderId ? tx.operationOrder.findUnique({ where: { id: orderId } }) : null,
    ]);

    if (capture) requireCleanupOwnership(capture.manifestHash === state.captureCandidate?.manifestHash &&
      capture.dataHash === state.captureCandidate?.dataHash && capture.sourceId === state.captureCandidate?.sourceId &&
      capture.sourceSystem === APPSHEET_HISTORY_SOURCE_SYSTEM);
    if (snapshot) requireCleanupOwnership(snapshot.sourceSystem === APPSHEET_HISTORY_SOURCE_SYSTEM &&
      snapshot.filename === "appsheet-live-capture" && snapshot.fileHash === state.snapshotCandidate?.fileHash &&
      snapshot.importerVersion === state.snapshotCandidate?.importerVersion && snapshot.createdBy === state.snapshotCandidate?.createdBy &&
      snapshot.captureManifestId === captureId && ["staged", "reviewed"].includes(snapshot.status) &&
      (snapshot.reviewedBy === null || snapshot.reviewedBy === state.actorIds?.sourceReviewer ||
        snapshot.reviewedBy === state.actorIds?.destinationReviewer));
    requireCleanupOwnership(Boolean(capture) === Boolean(snapshot));
    if (batch) requireCleanupOwnership(batch.snapshotId === snapshotId && batch.captureId === captureId &&
      batch.createdBy === state.batchCandidate?.createdBy && ["staged", "reviewed"].includes(batch.status) &&
      (batch.reviewedBy === null || batch.reviewedBy === state.actorIds?.destinationReviewer));
    if (member) requireCleanupOwnership(member.name === "Synthetic AppSheet pending-import member" &&
      member.sourceSystem === null && member.sourceId === null);
    if (order) requireCleanupOwnership(order.memberId === memberId && order.createdBy === state.orderCandidate?.createdBy &&
      order.sourceSystem === null && order.sourceId === null);
    if (memberId) {
      const [memberOrders, clinical, permissions, documents, credits] = await Promise.all([
        tx.operationOrder.findMany({ where: { memberId }, select: { id: true } }),
        tx.memberClinicalRecord.findUnique({ where: { memberId }, select: { memberId: true } }),
        tx.memberPermission.count({ where: { memberId } }),
        tx.operationDocument.count({ where: { memberId } }),
        tx.memberCredit.count({ where: { memberId } }),
      ]);
      requireCleanupOwnership(memberOrders.every(row => row.id === orderId) && memberOrders.length <= 1 &&
        clinical === null && permissions === 0 && documents === 0 && credits === 0);
    }

    const records = snapshot ? await tx.legacySourceRecord.findMany({ where: { snapshotId },
      select: { id: true, sourceTable: true, sourceKey: true, fileHash: true, contentHash: true, importerVersion: true } }) : [];
    if (batch) requireCleanupOwnership(Boolean(snapshot) && records.length === state.snapshotCandidate?.records.length);
    if (snapshot) {
      const expectedRecords = new Map((state.snapshotCandidate?.records ?? []).map(row => [row.id, row]));
      requireCleanupOwnership(records.length <= expectedRecords.size && records.every(row => {
        const expected = expectedRecords.get(row.id);
        return expected && expected.sourceTable === row.sourceTable && expected.sourceKey === row.sourceKey &&
          expected.fileHash === row.fileHash && expected.contentHash === row.contentHash &&
          expected.importerVersion === row.importerVersion && row.fileHash === snapshot.fileHash &&
          row.importerVersion === snapshot.importerVersion;
      }));
      const recordIds = records.map(row => row.id);
      const [uploads, sequences, publications, snapshotBatches, stockFacts, ledgerEvents, facts, exceptions] = await Promise.all([
        tx.legacyImportUpload.count({ where: { snapshotId } }),
        tx.appSheetInvoiceSequence.count({ where: { snapshotId } }),
        tx.legacyHistoryPublication.count({ where: { snapshotId } }),
        tx.appSheetPendingImportBatch.findMany({ where: { snapshotId }, select: { id: true } }),
        tx.stockFact.count({ where: { sourceRecordId: { in: recordIds } } }),
        tx.ledgerEvent.count({ where: { sourceRecordId: { in: recordIds } } }),
        tx.legacyHistoricalFact.findMany({ where: { snapshotId }, select: { id: true, sourceRecordId: true } }),
        tx.legacyException.findMany({ where: { snapshotId }, select: { id: true, sourceRecordId: true } }),
      ]);
      requireCleanupOwnership(uploads === 0 && sequences === 0 && publications === 0 && stockFacts === 0 && ledgerEvents === 0 &&
        snapshotBatches.every(row => row.id === batchId) && snapshotBatches.length <= 1);
      const expectedFactIds = new Set(state.snapshotCandidate?.factIds ?? []);
      const expectedExceptionIds = new Set(state.snapshotCandidate?.exceptionIds ?? []);
      const recordIdSet = new Set(recordIds);
      requireCleanupOwnership(facts.every(row => expectedFactIds.has(row.id) && recordIdSet.has(row.sourceRecordId)) &&
        exceptions.every(row => expectedExceptionIds.has(row.id) && (row.sourceRecordId === null || recordIdSet.has(row.sourceRecordId))));
      if (state.identityCandidate) {
        const invoice = records.find(row => row.sourceTable === "C_Facturacion");
        requireCleanupOwnership(invoice && state.identityCandidate.sourceKey === invoice.sourceKey);
      }
    }
    if (state.identityCandidate) {
      const identity = await tx.legacyIdentity.findUnique({ where: { id: state.identityCandidate.id } });
      if (identity) requireCleanupOwnership(identity.sourceSystem === APPSHEET_HISTORY_SOURCE_SYSTEM &&
        identity.sourceTable === "C_Facturacion" && identity.sourceKey === state.identityCandidate.sourceKey &&
        identity.destinationType === "order" && identity.destinationId === state.identityCandidate.destinationId &&
        identity.approvedBy === state.identityCandidate.approvedBy);
    }
    if (capture) {
      const [snapshots, batches, sequences, authorities, gates] = await Promise.all([
        tx.legacyImportSnapshot.findMany({ where: { captureManifestId: capture.captureId }, select: { id: true } }),
        tx.appSheetPendingImportBatch.findMany({ where: { captureId: capture.captureId }, select: { id: true } }),
        tx.appSheetInvoiceSequence.count({ where: { captureId: capture.captureId } }),
        tx.operationAuthority.count({ where: { captureManifestId: capture.captureId } }),
        tx.cutoverGate.count({ where: { captureManifestId: capture.captureId } }),
      ]);
      requireCleanupOwnership(snapshots.length === (snapshot ? 1 : 0) && (!snapshot || snapshots[0]?.id === snapshotId) &&
        batches.every(row => row.id === batchId) &&
        batches.length <= 1 && sequences === 0 && authorities === 0 && gates === 0);
    }
    if (batch) {
      const dispositions = await tx.appSheetPendingImportDisposition.findMany({ where: { batchId }, select: { sourceRecordId: true } });
      const settlements = await tx.appSheetLegacySettlement.findMany({ where: { batchId },
        select: { operationOrderId: true, sourceRecordId: true, createdBy: true, reviewedBy: true } });
      const recordIds = new Set(records.map(row => row.id));
      requireCleanupOwnership(dispositions.length === 16 && dispositions.every(row => recordIds.has(row.sourceRecordId)) &&
        settlements.length === 1 && settlements.every(row => row.operationOrderId === orderId && recordIds.has(row.sourceRecordId) &&
          row.createdBy === state.actorIds?.importer &&
          (row.reviewedBy === null || row.reviewedBy === state.actorIds?.destinationReviewer)));
    } else if (batchId) {
      const [dispositions, settlements] = await Promise.all([
        tx.appSheetPendingImportDisposition.count({ where: { batchId } }),
        tx.appSheetLegacySettlement.count({ where: { batchId } }),
      ]);
      requireCleanupOwnership(dispositions === 0 && settlements === 0);
    }
    if (orderId) {
      const [lines, reservations, allocations, stockReservations, collections, assignments, settlements] = await Promise.all([
        tx.operationOrderLine.findMany({ where: { orderId }, select: { id: true } }),
        tx.appSheetInvoiceNumberReservation.count({ where: { orderId } }),
        tx.preparationAllocation.count({ where: { orderId } }),
        tx.stockReservation.count({ where: { orderId } }),
        tx.collectionReport.count({ where: { orderId } }),
        tx.deliveryAssignment.findMany({ where: { orderId }, select: { id: true, status: true, routeId: true, driverId: true } }),
        tx.appSheetLegacySettlement.findMany({ where: { operationOrderId: orderId }, select: { batchId: true } }),
      ]);
      const orderStateIsOwned = order
        ? lines.length === 1 && lines[0]?.id === state.orderCandidate?.lineId
        : lines.length === 0 && assignments.length === 0 && settlements.length === 0;
      requireCleanupOwnership(orderStateIsOwned && reservations === 0 &&
        allocations === 0 && stockReservations === 0 && collections === 0 &&
        assignments.length <= state.deliveryIds.size && assignments.every(row => state.deliveryIds.has(row.id) &&
          row.status === "pending" && row.routeId === null && row.driverId === null) &&
        settlements.every(row => row.batchId === batchId) && settlements.length <= 1);
    }

    const objectRows = objectIds.length ? await tx.operationObject.findMany({ where: { id: { in: objectIds } },
      select: { id: true, kind: true, createdBy: true, version: true } }) : [];
    requireCleanupOwnership(objectRows.every(row => {
      const expected = state.objectExpectations.get(row.id);
      return expected && expected.kind === row.kind && expected.createdBy === row.createdBy &&
        row.version >= expected.minimumVersion && row.version <= expected.maximumVersion;
    }));
    const validActions = new Set(["legacy.appsheet_history_staged", "legacy.appsheet_history_source_reviewed",
      "AppSheetHistorySourceReviewed", "AppSheetPendingOrderIdentityReviewed", "AppSheetPendingDeliveryResolved",
      "appsheet.pending_order_identity_reviewed", "appsheet.pending_delivery_source_resolved", "AppSheetPendingImportPlanReviewed",
      "AppSheetPendingImportStaged", "appsheet.pending_import_staged", "AppSheetPendingImportDestinationReviewed",
      "appsheet.pending_import_destination_reviewed"]);
    const audits = objectIds.length ? await tx.operationAudit.findMany({ where: { objectId: { in: objectIds } },
      select: { actorId: true, action: true, requestId: true } }) : [];
    requireCleanupOwnership(audits.every(row => state.userIds.has(row.actorId) && validActions.has(row.action) &&
      (row.requestId === null || state.requestIds.has(row.requestId))));
    const receipts = state.requestIds.size ? await tx.commandReceipt.findMany({ where: { requestId: { in: [...state.requestIds] } },
      select: { requestId: true, actorId: true, targetId: true, command: true } }) : [];
    const validCommands = new Set(["AppSheetHistorySourceReviewed", "AppSheetPendingOrderIdentityReviewed", "AppSheetPendingDeliveryResolved",
      "AppSheetPendingImportPlanReviewed", "AppSheetPendingImportStaged", "AppSheetPendingImportDestinationReviewed"]);
    requireCleanupOwnership(receipts.every(row => state.userIds.has(row.actorId) && objectIds.includes(row.targetId) && validCommands.has(row.command)));
    const outbox = state.requestIds.size ? await tx.operationOutbox.findMany({
      where: { requestId: { in: [...state.requestIds] } }, select: { requestId: true },
    }) : [];
    requireCleanupOwnership(outbox.every(row => receipts.some(receipt => receipt.requestId === row.requestId)));
    const users = actorIds.length ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true, role: true, active: true } }) : [];
    requireCleanupOwnership(users.every(user => user.name === "Synthetic AppSheet review actor" &&
      user.email === state.userEmails.get(user.id) && user.role === "admin" && user.active));
    const access = actorIds.length ? await tx.operationAccess.findMany({ where: { userId: { in: actorIds } },
      select: { userId: true, profile: true, capabilities: true, scope: true, enabled: true } }) : [];
    requireCleanupOwnership(access.every(row => {
      const expectedCapabilities = state.operationAccess.get(row.userId);
      return state.userIds.has(row.userId) && expectedCapabilities !== undefined && row.profile === "admin" && row.enabled &&
        canonicalJson(row.capabilities) === canonicalJson(expectedCapabilities) && canonicalJson(row.scope) === canonicalJson({});
    }));
    const [devices, backups, quarantines, recoveries] = actorIds.length ? await Promise.all([
      tx.operationDevice.count({ where: { userId: { in: actorIds } } }),
      tx.offlineBackup.count({ where: { userId: { in: actorIds } } }),
      tx.offlineQuarantine.count({ where: { userId: { in: actorIds } } }),
      tx.offlineRecovery.count({ where: { ownerId: { in: actorIds } } }),
    ]) : [0, 0, 0, 0];
    requireCleanupOwnership(devices === 0 && backups === 0 && quarantines === 0 && recoveries === 0);

    if (state.requestIds.size) {
      await tx.operationOutbox.deleteMany({ where: { requestId: { in: [...state.requestIds] } } });
      await tx.commandReceipt.deleteMany({ where: { requestId: { in: [...state.requestIds] } } });
    }
    if (objectIds.length) await tx.operationAudit.deleteMany({ where: { objectId: { in: objectIds } } });
    if (state.identityCandidate) await tx.legacyIdentity.deleteMany({ where: { id: state.identityCandidate.id } });
    if (state.deliveryIds.size) await tx.deliveryAssignment.deleteMany({ where: { id: { in: [...state.deliveryIds] } } });
    if (batch) {
      await tx.appSheetLegacySettlement.deleteMany({ where: { batchId } });
      await tx.appSheetPendingImportDisposition.deleteMany({ where: { batchId } });
      await tx.appSheetPendingImportBatch.delete({ where: { id: batchId } });
    }
    if (objectIds.length) await tx.operationObject.deleteMany({ where: { id: { in: objectIds } } });
    if (snapshot) {
      await tx.legacyException.deleteMany({ where: { snapshotId } });
      await tx.legacyHistoricalFact.deleteMany({ where: { snapshotId } });
      await tx.legacySourceRecord.deleteMany({ where: { snapshotId } });
      await tx.legacyImportSnapshot.delete({ where: { id: snapshotId } });
    }
    if (capture) await tx.appSheetCaptureManifest.delete({ where: { captureId } });
    if (order) {
      await tx.operationOrderLine.deleteMany({ where: { orderId } });
      await tx.operationOrder.delete({ where: { id: orderId } });
    }
    if (member) await tx.operationMember.delete({ where: { id: memberId! } });
    if (actorIds.length) {
      await tx.operationSession.deleteMany({ where: { userId: { in: actorIds } } });
      await tx.operationAccess.deleteMany({ where: { userId: { in: actorIds } } });
      await tx.user.deleteMany({ where: { id: { in: actorIds } } });
    }
  }, { timeout: 60_000 });
}

let activeCleanup: ScenarioCleanupState | null = null;

test.afterEach(async () => {
  const state = activeCleanup;
  if (!state) return;
  try {
    await cleanupDestinationReviewScenario(state);
  } finally {
    activeCleanup = null;
  }
});

function command(targetId: string, name: string, data: Record<string, unknown>, expectedVersion = 0,
  cleanup?: ScenarioCleanupState): CommandEnvelope {
  const requestId = randomUUID();
  cleanup?.requestIds.add(requestId);
  return {
    schemaVersion: 1,
    requestId,
    targetId,
    command: name,
    data,
    expectedVersion,
    occurredAt: new Date().toISOString(),
  };
}

async function executeAs(actorId: string, envelope: CommandEnvelope) {
  const { executeCommand } = await import("../../server/operations/core.js");
  const actor = await db.user.findUniqueOrThrow({ where: { id: actorId } });
  return executeCommand(actor, envelope);
}

async function loginAs(page: Page, email: string) {
  await page.goto("/app");
  const response = await page.request.post("/api/auth/login", {
    data: { email, password: getIsolatedE2EPassword() },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto("/app/operations?section=imports");
  await expect(page.getByRole("heading", { name: "Importar libro legado", exact: true })).toBeVisible();
}

async function createDestinationReviewScenario(cleanup: ScenarioCleanupState) {
  const databaseURL = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"], "La spec sólo puede escribir en loopback").toContain(databaseURL.hostname);
  const schema = databaseURL.searchParams.get("schema") ?? "";
  expect(schema).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(process.env.BOMBO_E2E_ISOLATED).toBe("1");

  const suffix = randomUUID();
  const actorIds = {
    importer: `appsheet-importer-${suffix}`,
    sourceReviewer: `appsheet-source-reviewer-${suffix}`,
    destinationReviewer: `appsheet-destination-reviewer-${suffix}`,
    writerOnly: `appsheet-writer-only-${suffix}`,
    technicalReviewer: `appsheet-technical-${suffix}`,
    member: `appsheet-member-${suffix}`,
  };
  cleanup.actorIds = actorIds;
  const emails = Object.fromEntries(Object.entries(actorIds).filter(([key]) => key !== "technicalReviewer" && key !== "member")
    .map(([key, id]) => [key, `${id}@pending-import.test`])) as Record<"importer" | "sourceReviewer" | "destinationReviewer" | "writerOnly", string>;
  for (const [key, id] of Object.entries(actorIds)) {
    if (key === "technicalReviewer" || key === "member") continue;
    const typedKey = key as keyof typeof emails;
    cleanup.userEmails.set(id, emails[typedKey]);
    cleanup.operationAccess.set(id, key === "writerOnly" ? ["imports.write"] : ["imports.write", "imports.review"]);
  }
  for (const id of [actorIds.importer, actorIds.sourceReviewer, actorIds.destinationReviewer, actorIds.writerOnly])
    cleanup.userIds.add(id);
  const password = getIsolatedE2EPassword();
  const passwordHash = await bcrypt.hash(password, 4);
  const users = [actorIds.importer, actorIds.sourceReviewer, actorIds.destinationReviewer, actorIds.writerOnly];
  for (const id of users) {
    const email = id === actorIds.importer ? emails.importer
      : id === actorIds.sourceReviewer ? emails.sourceReviewer
        : id === actorIds.destinationReviewer ? emails.destinationReviewer : emails.writerOnly;
    await db.user.create({
      data: { id, name: "Synthetic AppSheet review actor", email, password: passwordHash, role: "admin" },
    });
    await db.operationAccess.create({
      data: {
        userId: id,
        profile: "admin",
        capabilities: id === actorIds.writerOnly ? ["imports.write"] : ["imports.write", "imports.review"],
        scope: {},
      },
    });
  }

  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseURL);
  const source = syntheticPendingHistorySource();
  const preparedHistory = prepareAppSheetHistoryProjection(source.capture, source.definition);
  const [existingCapture, existingSnapshot] = await Promise.all([
    db.appSheetCaptureManifest.findUnique({ where: { captureId: source.capture.manifest.captureId }, select: { captureId: true } }),
    db.legacyImportSnapshot.findUnique({ where: { id: preparedHistory.snapshotId }, select: { id: true } }),
  ]);
  requireCleanupOwnership(!existingCapture && !existingSnapshot);
  cleanup.captureCandidate = {
    id: source.capture.manifest.captureId,
    sourceId: source.capture.manifest.sourceId,
    manifestHash: source.capture.manifest.manifestHash,
    dataHash: source.capture.manifest.dataHash,
  };
  cleanup.snapshotCandidate = {
    id: preparedHistory.snapshotId,
    captureId: source.capture.manifest.captureId,
    fileHash: source.capture.manifest.manifestHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    createdBy: actorIds.importer,
    records: preparedHistory.persistedRecords.map(({ id, sourceTable, sourceKey, fileHash, contentHash, importerVersion }) =>
      ({ id, sourceTable, sourceKey, fileHash, contentHash, importerVersion })),
    factIds: preparedHistory.persistedFacts.map(fact => fact.id),
    exceptionIds: preparedHistory.exceptions.map(exception => exception.id),
  };
  cleanup.objectExpectations.set(preparedHistory.snapshotId, {
    kind: "legacyImport", createdBy: actorIds.importer, minimumVersion: 0, maximumVersion: 3,
  });
  const stageCommitSha = sha256("synthetic browser pending-import source commit").slice(0, 40);
  const backupSnapshotAt = new Date(Date.now() - 60_000).toISOString();
  const backupManifestHash = sha256("synthetic browser pending-import source backup");
  const technicalReview = {
    schemaVersion: 2,
    reviewKind: "independent-technical",
    captureId: source.capture.manifest.captureId,
    manifestHash: source.capture.manifest.manifestHash,
    definitionHash: source.definition.appliedDefinitionHash,
    projectionKind: "history",
    projectionHash: preparedHistory.projectionHash,
    commitSha: stageCommitSha,
    target: "isolated-test",
    destinationIdentity,
    importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    reviewer: actorIds.technicalReviewer,
    approved: true,
    reviewedAt: new Date(Date.now() - 120_000).toISOString(),
    findings: [],
  };
  const staged = await stageAppSheetHistoryProjection(preparedHistory, {
    actorId: actorIds.importer,
    technicalReview,
    commitSha: stageCommitSha,
    target: "isolated-test",
    destinationIdentity,
    backupEvidence: { manifestHash: sha256("synthetic source backup manifest"), snapshotAt: backupSnapshotAt },
  }, db);
  requireCleanupOwnership(!staged.replay && staged.captureManifestId === source.capture.manifest.captureId);
  expect(staged.status).toBe("staged");
  expect(staged.metrics.recordCount).toBe(4);
  const snapshotId = staged.snapshotId;

  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetHistorySourceReviewed", {
    fileHash: source.capture.manifest.manifestHash,
    captureId: source.capture.manifest.captureId,
    dataHash: source.capture.manifest.dataHash,
    projectionHash: preparedHistory.projectionHash,
    evidenceReference: "Revisión humana sintética del fixture AppSheet estable.",
  }, 0, cleanup));

  const existingMember = await db.operationMember.findUnique({ where: { id: actorIds.member }, select: { id: true } });
  requireCleanupOwnership(!existingMember);
  cleanup.memberCandidate = { id: actorIds.member, name: "Synthetic AppSheet pending-import member" };
  await db.operationMember.create({ data: {
    id: actorIds.member,
    name: "Synthetic AppSheet pending-import member",
    address: { address: "Domicilio actual sintético no sustituye al histórico" },
    preferences: {},
  } });
  const orderId = `appsheet-pending-order-${suffix}`;
  const lineId = `appsheet-pending-order-line-${suffix}`;
  const skuId = `appsheet-pending-sku-${suffix}`;
  const existingOrder = await db.operationOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  const existingOrderObject = await db.operationObject.findUnique({ where: { id: orderId }, select: { id: true } });
  requireCleanupOwnership(!existingOrder && !existingOrderObject);
  cleanup.orderCandidate = { id: orderId, memberId: actorIds.member, createdBy: actorIds.importer, lineId };
  cleanup.objectExpectations.set(orderId, { kind: "order", createdBy: actorIds.importer, minimumVersion: 1, maximumVersion: 1 });
  await db.operationOrder.create({ data: {
    id: orderId,
    memberId: actorIds.member,
    channel: "delivery",
    currency: "ARS",
    commercialState: "confirmed",
    quote: { schemaVersion: 1, source: "synthetic-test", lines: [{ skuId, requested: "1", unitPrice: "100" }] },
    quoteVersion: 1,
    subtotalMinor: 10_000n,
    totalMinor: 10_000n,
    verifiedMinor: 0n,
    refundedMinor: 0n,
    financialState: "unpaid",
    fulfillmentState: "unprepared",
    address: { address: "Domicilio actual sintético no sustituye al histórico" },
    createdBy: actorIds.importer,
    lines: { create: [{
      id: lineId,
      skuId,
      unit: "g",
      requested: "1",
      unitPrice: "100",
      referenceMinor: 10_000n,
      revenueMinor: 10_000n,
    }] },
  } });
  await db.operationObject.create({ data: { id: orderId, kind: "order", version: 1, createdBy: actorIds.importer } });
  const order = await db.operationOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
  const orderObject = await db.operationObject.findUniqueOrThrow({ where: { id: orderId } });
  const orderHash = sha256Canonical({
    id: order.id,
    currency: order.currency,
    totalMinor: order.totalMinor.toString(),
    verifiedMinor: order.verifiedMinor.toString(),
    refundedMinor: order.refundedMinor.toString(),
    commercialState: order.commercialState,
    financialState: order.financialState,
    version: orderObject.version,
  });
  expect(appSheetPendingOrderCommercialBasisHash(order)).toMatch(/^[a-f0-9]{64}$/);

  const planWithoutBinding = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
  const invoiceDisposition = planWithoutBinding.dispositions.find(row => row.sourceTable === "C_Facturacion" && row.dimension === "receivable");
  expect(invoiceDisposition?.sourceStatus).toBe("confirmed_pending");
  const snapshotObject = await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } });
  const identityId = sha256(`${APPSHEET_HISTORY_SOURCE_SYSTEM}\0C_Facturacion\0${source.invoiceSourceKey}\0order`);
  const existingIdentity = await db.legacyIdentity.findUnique({ where: { id: identityId }, select: { id: true } });
  requireCleanupOwnership(!existingIdentity);
  cleanup.identityCandidate = { id: identityId, sourceKey: source.invoiceSourceKey, destinationId: orderId, approvedBy: actorIds.sourceReviewer };
  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetPendingOrderIdentityReviewed", {
    sourceRecordId: invoiceDisposition!.sourceRecordId,
    sourceRecordHash: invoiceDisposition!.sourceRecordHash,
    reconciliationHash: invoiceDisposition!.reconciliationHash,
    mappingHash: invoiceDisposition!.mappingHash,
    operationOrderId: orderId,
    operationOrderVersion: orderObject.version,
    operationOrderHash: orderHash,
    evidence: "Vínculo sintético exacto entre captura y pedido preexistente.",
  }, snapshotObject.version, cleanup));

  const invoiceRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Facturacion" } });
  const motoRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Moto" } });
  const sourceCell = async (sourceRecordId: string, header: string) => {
    const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
    const original = record.original as { columns?: Array<Record<string, unknown>> };
    const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
    const originalMatch = (original.columns ?? []).filter(column => column.header === header);
    const normalizedMatch = (normalized.columns ?? []).filter(column => column.header === header);
    expect(originalMatch).toHaveLength(1);
    expect(normalizedMatch).toHaveLength(1);
    expect(typeof normalizedMatch[0]!.value).toBe("string");
    return {
      sourceRecordId: record.id,
      sourceRecordHash: record.contentHash,
      coordinate: String(originalMatch[0]!.coordinate),
      header,
      valueHash: sha256Canonical(originalMatch[0]!.value),
    };
  };
  const capturedCellValue = async (sourceRecordId: string, header: string) => {
    const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
    const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
    const matches = (normalized.columns ?? []).filter(column => column.header === header);
    expect(matches).toHaveLength(1);
    expect(typeof matches[0]!.value).toBe("string");
    return matches[0]!.value as string;
  };
  const planBeforeDelivery = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
  const motoDisposition = planBeforeDelivery.dispositions.find(row => row.sourceRecordId === motoRecord.id && row.dimension === "delivery");
  expect(motoDisposition?.sourceStatus).toBe("confirmed_pending");
  const [motoKeyCell, invoiceReferenceCell, invoiceKeyCell, invoiceAddressCell] = await Promise.all([
    sourceCell(motoRecord.id, "Id_Moto"),
    sourceCell(motoRecord.id, "N_Factura"),
    sourceCell(invoiceRecord.id, "N_factura"),
    sourceCell(invoiceRecord.id, "Domicilio"),
  ]);
  expect(await capturedCellValue(invoiceRecord.id, "N_factura")).toBe(source.invoiceNumber);
  expect(invoiceReferenceCell.valueHash).toBe(invoiceKeyCell.valueHash);
  const motoReference = await capturedCellValue(motoRecord.id, "N_Factura");
  const invoiceNumber = await capturedCellValue(invoiceRecord.id, "N_factura");
  expect(appSheetDeliveryInvoiceReferenceMatches(motoReference, invoiceNumber)).toBe(true);
  const currentSnapshotObject = await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } });
  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetPendingDeliveryResolved", {
    sourceRecordId: motoDisposition!.sourceRecordId,
    sourceRecordHash: motoDisposition!.sourceRecordHash,
    reconciliationHash: motoDisposition!.reconciliationHash,
    mappingHash: motoDisposition!.mappingHash,
    sourceSpecHash: planBeforeDelivery.sourceSpecHash,
    invoiceRecordId: invoiceRecord.id,
    invoiceRecordHash: invoiceRecord.contentHash,
    motoKeyCell,
    invoiceReferenceCell,
    invoiceKeyCell,
    invoiceAddressCell,
    operationOrderId: orderId,
    operationOrderVersion: orderObject.version,
    operationOrderHash: orderHash,
    evidence: "Referencia sintética exacta y domicilio histórico conservado desde la factura.",
  }, currentSnapshotObject.version, cleanup));

  const binding = {
    target: "isolated-test" as const,
    destinationIdentity,
    commitSha: sha256("synthetic browser pending-import destination commit").slice(0, 40),
    backupManifestHash: sha256("synthetic browser pending-import destination backup"),
    backupSnapshotAt: new Date().toISOString(),
  };
  const plan = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, {
    snapshotId,
    binding: { ...binding, backupSnapshotAt: new Date(binding.backupSnapshotAt) },
  }));
  expect(plan.materializedSettlements).toHaveLength(1);
  expect(plan.materializedDeliveries).toHaveLength(1);
  const reviewObjectId = `appsheet-pending-plan-review:${plan.batchId}`;
  const plannedDeliveryIds: string[] = [];
  for (const delivery of plan.materializedDeliveries) {
    const [assignment, deliveryObject] = await Promise.all([
      db.deliveryAssignment.findUnique({ where: { id: delivery.destinationId }, select: { id: true } }),
      db.operationObject.findUnique({ where: { id: delivery.destinationId }, select: { id: true } }),
    ]);
    requireCleanupOwnership(!assignment && !deliveryObject);
    plannedDeliveryIds.push(delivery.destinationId);
  }
  const existingBatch = await db.appSheetPendingImportBatch.findUnique({ where: { id: plan.batchId }, select: { id: true } });
  const existingReviewObject = await db.operationObject.findUnique({ where: { id: reviewObjectId }, select: { id: true } });
  requireCleanupOwnership(!existingBatch && !existingReviewObject);
  cleanup.batchCandidate = { id: plan.batchId, snapshotId, captureId: plan.captureId, createdBy: actorIds.importer };
  cleanup.objectExpectations.set(plan.batchId, { kind: "legacyImport", createdBy: actorIds.importer, minimumVersion: 1, maximumVersion: 2 });
  cleanup.objectExpectations.set(reviewObjectId, { kind: "legacyImport", createdBy: actorIds.destinationReviewer, minimumVersion: 1, maximumVersion: 1 });
  for (const deliveryId of plannedDeliveryIds) {
    cleanup.deliveryIds.add(deliveryId);
    cleanup.objectExpectations.set(deliveryId, {
      kind: "delivery", createdBy: actorIds.destinationReviewer, minimumVersion: 1, maximumVersion: 1,
    });
  }
  const review = (reviewKind: "independent-pending-import-plan" | "independent-pending-import-destination") => ({
    schemaVersion: "appsheet-pending-import-review/v1" as const,
    reviewKind,
    captureId: plan.captureId,
    manifestHash: plan.manifestHash,
    dataHash: plan.dataHash,
    mappingHash: plan.mappingHash,
    sourceSpecHash: plan.sourceSpecHash,
    sourceCoverageHash: plan.sourceCoverageHash,
    dispositionHash: plan.dispositionHash,
    destinationHash: plan.destinationHash,
    destinationVersion: 1,
    projectionHash: plan.projectionHash,
    target: "isolated-test" as const,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    importer: actorIds.importer,
    reviewer: actorIds.destinationReviewer,
    approved: true as const,
    reviewedAt: new Date().toISOString(),
    findings: [],
  });
  const planReview = command(reviewObjectId, "AppSheetPendingImportPlanReviewed", {
    snapshotId,
    importerId: actorIds.importer,
    target: binding.target,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    review: review("independent-pending-import-plan"),
  }, 0, cleanup);
  await executeAs(actorIds.destinationReviewer, planReview);
  const stage = command(plan.batchId, "AppSheetPendingImportStaged", {
    snapshotId,
    target: binding.target,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    planReviewRequestId: planReview.requestId,
  }, 0, cleanup);
  await executeAs(actorIds.importer, stage);

  return {
    actorIds,
    emails,
    snapshotId,
    batchId: plan.batchId,
    orderId,
    review: review("independent-pending-import-destination"),
  };
}

async function pendingEffects(orderId: string) {
  return {
    orders: await db.operationOrder.findMany({
      orderBy: { id: "asc" },
      select: { id: true, verifiedMinor: true, refundedMinor: true, financialState: true, fulfillmentState: true, totalMinor: true },
    }),
    orderObject: await db.operationObject.findUnique({ where: { id: orderId }, select: { kind: true, version: true } }),
    deliveryAssignments: await db.deliveryAssignment.count(),
    stockFacts: await db.stockFact.count(),
    stockBalances: await db.stockBalance.count(),
    ledgerEvents: await db.ledgerEvent.count(),
    cashEntries: await db.cashEntry.count(),
    collectionReports: await db.collectionReport.count(),
    payablePayments: await db.payablePayment.count(),
    invoiceSequences: await db.appSheetInvoiceSequence.count(),
    invoiceReservations: await db.appSheetInvoiceNumberReservation.count(),
  };
}

async function destinationState(batchId: string, snapshotId: string, orderId: string) {
  const batch = await db.appSheetPendingImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  return {
    snapshot: await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, select: { status: true, reviewedBy: true } }),
    batch: { status: batch.status, reviewedBy: batch.reviewedBy, destinationVersion: batch.destinationVersion, reviewEvidence: batch.reviewEvidence },
    batchObject: await db.operationObject.findUniqueOrThrow({ where: { id: batchId }, select: { kind: true, version: true } }),
    settlements: await db.appSheetLegacySettlement.findMany({
      where: { batchId }, orderBy: { id: "asc" },
      select: { id: true, status: true, dueMinor: true, legacyPaidMinor: true, remainingMinor: true, currency: true },
    }),
    assignments: await db.deliveryAssignment.findMany({
      where: { orderId }, orderBy: { id: "asc" },
      select: { id: true, status: true, routeId: true, driverId: true, dispatchedAt: true, deliveredAt: true, address: true },
    }),
    receiptCount: await db.commandReceipt.count(),
    outboxCount: await db.operationOutbox.count(),
    auditCount: await db.operationAudit.count(),
    effects: await pendingEffects(orderId),
  };
}

async function createReceiptFailureTrigger(requestId: string) {
  const schema = new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "";
  expect(schema).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
  const token = randomUUID().replaceAll("-", "");
  const functionName = `synthetic_destination_fail_${token}`;
  const triggerName = `synthetic_destination_fail_${token}`;
  await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}"."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."requestId" = '${requestId}'::uuid THEN
        RAISE EXCEPTION 'synthetic destination review rollback';
      END IF;
      RETURN NEW;
    END;
  $$`);
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${schema}"."CommandReceipt"
      FOR EACH ROW EXECUTE FUNCTION "${schema}"."${functionName}"()`);
  } catch (error) {
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${functionName}"()`);
    throw error;
  }
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."CommandReceipt"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${functionName}"()`);
  };
}

function destinationEnvelope(batchId: string, expectedVersion: number, review: Record<string, unknown>) {
  return { command: "AppSheetPendingImportDestinationReviewed", targetId: batchId, expectedVersion, data: { review } };
}

async function selectReviewFile(page: Page, filename: string, envelope: unknown) {
  const previewResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname.includes("/review-preview");
  });
  await page.getByLabel("Plan JSON de revisión (máximo 100 KB)").setInputFiles({
    name: filename,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(envelope), "utf8"),
  });
  return previewResponse;
}

test("la revisión de destino AppSheet muestra vista previa, bloquea planes obsoletos y materializa una sola entrega pendiente", async ({ page }) => {
  test.setTimeout(150_000);
  const cleanup = newScenarioCleanupState();
  activeCleanup = cleanup;
  const scenario = await createDestinationReviewScenario(cleanup);
  const commandPosts: Array<Record<string, unknown>> = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/operations/commands") {
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        commandPosts.push(body);
        if (typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId))
          cleanup.requestIds.add(body.requestId);
      } catch {
        // Request observation is best-effort; it must not change the UI test outcome.
      }
    }
  });
  const stateBefore = await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId);

  await loginAs(page, scenario.emails.writerOnly);
  await expect(page.getByRole("heading", { name: "Revisión humana autenticada" })).toHaveCount(0);
  await expect(page.getByLabel("Plan JSON de revisión (máximo 100 KB)")).toHaveCount(0);
  const writerPreview = await page.request.get(`/api/operations/appsheet-pending-imports/${encodeURIComponent(scenario.batchId)}/review-preview`);
  expect(writerPreview.status()).toBe(403);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  await loginAs(page, scenario.emails.destinationReviewer);
  await expect(page.getByRole("heading", { name: "Revisión humana autenticada" })).toBeVisible();
  const submit = page.getByRole("button", { name: "Revisar destino y crear entregas pendientes", exact: true });

  const wrongHashPlan = destinationEnvelope(scenario.batchId, 1, {
    ...scenario.review,
    destinationHash: sha256("hash distinto del destino vigente"),
  });
  const wrongHashPreview = await selectReviewFile(page, "synthetic-wrong-destination-hash.json", wrongHashPlan);
  expect((await wrongHashPreview).status()).toBe(200);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("El plan no coincide con el destino actual", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  const staleVersionPlan = destinationEnvelope(scenario.batchId, 0, scenario.review);
  const staleVersionPreview = await selectReviewFile(page, "synthetic-stale-destination-version.json", staleVersionPlan);
  expect((await staleVersionPreview).status()).toBe(200);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("El plan no coincide con el destino actual", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  const failingPreview = async (route: Route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Synthetic preview unavailable" }),
  });
  const previewPath = `**/api/operations/appsheet-pending-imports/${scenario.batchId}/review-preview`;
  await page.route(previewPath, failingPreview);
  const unavailablePreview = await selectReviewFile(page, "synthetic-preview-unavailable.json",
    destinationEnvelope(scenario.batchId, 1, scenario.review));
  expect((await unavailablePreview).status()).toBe(503);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("No se pudo verificar el destino", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);
  await page.unroute(previewPath, failingPreview);

  const validEnvelope = destinationEnvelope(scenario.batchId, 1, scenario.review);
  const validPreview = await selectReviewFile(page, "synthetic-current-destination-review.json", validEnvelope);
  const previewResponse = await validPreview;
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json() as Record<string, unknown>;
  expect(preview).toMatchObject({
    batchId: scenario.batchId,
    status: "staged",
    expectedVersion: 1,
    captureId: scenario.review.captureId,
    manifestHash: scenario.review.manifestHash,
    dataHash: scenario.review.dataHash,
    projectionHash: scenario.review.projectionHash,
    dispositionHash: scenario.review.dispositionHash,
    destinationHash: scenario.review.destinationHash,
    legacySettlementCount: 1,
    pendingDeliveryAssignmentCount: 1,
  });
  await expect(submit).toBeEnabled();
  await expect(page.getByText("La misma persona puede revisar el plan y el destino; debe ser distinta de quienes prepararon la carga o revisaron el origen y sus vínculos.", { exact: true })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  let rollbackRequestId = "";
  const rollbackDestinationReview = async (route: Route) => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith("/api/operations/commands")) return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.command !== "AppSheetPendingImportDestinationReviewed") return route.continue();
    rollbackRequestId = String(body.requestId ?? "");
    const dropTrigger = await createReceiptFailureTrigger(rollbackRequestId);
    try {
      const response = await route.fetch();
      expect(response.status()).toBeGreaterThanOrEqual(500);
      await route.fulfill({ response });
    } finally {
      await dropTrigger();
    }
  };
  await page.route("**/api/operations/commands", rollbackDestinationReview);
  const rollbackResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") &&
    response.request().postDataJSON().command === "AppSheetPendingImportDestinationReviewed");
  await submit.click();
  const rollbackResponse = await rollbackResponsePromise;
  expect(rollbackResponse.status()).toBeGreaterThanOrEqual(500);
  await page.unroute("**/api/operations/commands", rollbackDestinationReview);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(submit).toBeEnabled();
  expect(rollbackRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await db.commandReceipt.findUnique({ where: { requestId: rollbackRequestId } })).toBeNull();
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);
  expect(commandPosts).toHaveLength(1);

  let firstAcknowledgementRequestId = "";
  let committedResponse: Record<string, unknown> | undefined;
  const loseDestinationAcknowledgement = async (route: Route) => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith("/api/operations/commands")) return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.command !== "AppSheetPendingImportDestinationReviewed") return route.continue();
    firstAcknowledgementRequestId = String(body.requestId ?? "");
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committedResponse = await response.json() as Record<string, unknown>;
    await route.abort("failed");
  };
  await page.route("**/api/operations/commands", loseDestinationAcknowledgement);
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("el mismo UUID mientras esta vista siga abierta");
  expect(committedResponse).toBeDefined();
  expect(commandPosts).toHaveLength(2);
  await page.unroute("**/api/operations/commands", loseDestinationAcknowledgement);

  const replayResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") &&
    response.request().postDataJSON().command === "AppSheetPendingImportDestinationReviewed");
  await submit.click();
  const replayResponse = await replayResponsePromise;
  expect(replayResponse.status()).toBe(200, await replayResponse.text());
  const replay = await replayResponse.json() as Record<string, unknown>;
  expect(replay.replay).toBe(true);
  expect(replay.requestId).toBe(firstAcknowledgementRequestId);
  expect(commandPosts).toHaveLength(3);
  expect(commandPosts[1]!.requestId).toBe(firstAcknowledgementRequestId);
  expect(commandPosts[2]!.requestId).toBe(firstAcknowledgementRequestId);

  const receipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: firstAcknowledgementRequestId } });
  expect(receipt.actorId).toBe(scenario.actorIds.destinationReviewer);
  expect(await db.operationOutbox.count({ where: { requestId: firstAcknowledgementRequestId } })).toBe(1);
  expect(await db.operationAudit.count({ where: { requestId: firstAcknowledgementRequestId } })).toBe(1);
  expect(await db.operationAudit.count({ where: {
    objectId: scenario.batchId,
    action: "appsheet.pending_import_destination_reviewed",
  } })).toBe(1);
  const finalState = await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId);
  expect(finalState.snapshot.status).toBe("reviewed");
  expect(finalState.snapshot.reviewedBy).toBe(scenario.actorIds.destinationReviewer);
  expect(finalState.batch.status).toBe("reviewed");
  expect(finalState.batch.reviewedBy).toBe(scenario.actorIds.destinationReviewer);
  expect(finalState.batchObject).toEqual({ kind: "legacyImport", version: 2 });
  expect(finalState.settlements).toHaveLength(1);
  expect(finalState.settlements[0]).toMatchObject({
    status: "reviewed",
    dueMinor: 10_000n,
    legacyPaidMinor: 4_000n,
    remainingMinor: 6_000n,
    currency: "ARS",
  });
  expect(finalState.assignments).toHaveLength(1);
  expect(finalState.assignments[0]).toMatchObject({
    status: "pending",
    routeId: null,
    driverId: null,
    dispatchedAt: null,
    deliveredAt: null,
    address: expect.objectContaining({
      address: "Dirección histórica sintética 123, Salta",
      source: "appsheet-pending-import",
    }),
  });
  expect(finalState.effects).toEqual({ ...stateBefore.effects, deliveryAssignments: stateBefore.effects.deliveryAssignments + 1 });
  await expect(page.getByRole("status")).toContainText("1 asignación de entrega pendiente");
});
