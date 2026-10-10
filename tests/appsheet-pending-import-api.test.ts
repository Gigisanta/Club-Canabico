import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION } from "../shared/operations/appsheet-history.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { splitSqlStatements } from "./migration-sql.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sha256Canonical = (value: unknown) => sha256(canonicalJson(value));

test("AppSheet pending import binds a reviewed receipt and preserves partial ARS settlement and exact pending delivery", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  if (process.env.DATABASE_URL) {
    const applicationUrl = new URL(process.env.DATABASE_URL);
    assert.notEqual(`${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`,
      `${applicationUrl.hostname}:${applicationUrl.port}${applicationUrl.pathname}`, "TEST_DATABASE_URL no puede ser la base de la aplicación");
  }

  const schema = `appsheet_pending_api_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseUrl);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: "appsheet-pending-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-pending.test",
  });

  // The fixture imports the canonical importer, which reaches server/db.ts.
  // Load it only after the isolated TEST_DATABASE_URL has become DATABASE_URL
  // so the process-wide Prisma singleton captures the intended destination.
  const { syntheticPendingHistorySource } = await import("./support/appsheet-pending-import-fixture.js");
  const { db } = await import("../server/db.js");
  const { executeCommand } = await import("../server/operations/core.js");
  const { prepareAppSheetHistoryProjection, stageAppSheetHistoryProjection } = await import("../server/operations/appsheet-history.js");
  const { requireBoundAppSheetHistoryStage } = await import("../server/operations/appsheet-history-review.js");
  const { prepareAppSheetPendingImportPlan, appSheetPendingOrderCommercialBasisHash } = await import("../server/operations/appsheet-pending-import.js");
  const { appSheetDeliveryInvoiceReferenceMatches } = await import("../shared/operations/appsheet-pending-import.js");
  await import("../server/operations/appsheet-pending-import.js");
  await import("../server/operations/finance.js");

  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const migrationActorA = `pending-migration-a-${randomUUID()}`;
    const migrationActorB = `pending-migration-b-${randomUUID()}`;
    const migrationActorC = `pending-migration-c-${randomUUID()}`;
    const actorIds = {
      sourceStager: migrationActorA,
      sourceTechnicalReviewer: `pending-source-technical-reviewer-${randomUUID()}`,
      sourceReviewer: migrationActorB,
      sourceReader: `pending-source-reader-${randomUUID()}`,
      orderMapper: migrationActorB,
      deliveryReviewer: migrationActorB,
      importer: migrationActorA,
      planReviewer: migrationActorC,
      destinationReviewer: migrationActorC,
      collectionReporter: `pending-collection-reporter-${randomUUID()}`,
      collectionVerifier: `pending-collection-verifier-${randomUUID()}`,
      member: `pending-member-${randomUUID()}`,
    };
    const httpPassword = `Synthetic-pending-api-${randomUUID()}`;
    const passwordHash = await bcrypt.hash(httpPassword, 4);
    const syntheticUserIds = [...new Set(Object.entries(actorIds)
      .filter(([key]) => key !== "member" && key !== "sourceTechnicalReviewer")
      .map(([, id]) => id))];
    for (const id of syntheticUserIds) {
      await db.user.create({
        data: { id, name: "Synthetic AppSheet pending-import actor", email: `${id}@pending-import.test`, password: passwordHash, role: "admin" },
      });
      const capabilities = id === actorIds.sourceReader ? ["imports.read"]
        : id === actorIds.collectionReporter ? ["collections.report", "finance.read"]
          : id === actorIds.collectionVerifier ? ["collections.verify"]
            : ["imports.write", "imports.review"];
      await db.operationAccess.create({
        data: { userId: id, profile: "admin", capabilities, scope: {} },
      });
    }
    const actor = async (id: string) => db.user.findUniqueOrThrow({ where: { id } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const cookies: Record<string, string> = {};
    const httpActors = [...new Set([actorIds.sourceReviewer, actorIds.sourceStager, actorIds.sourceReader, actorIds.orderMapper,
      actorIds.deliveryReviewer, actorIds.importer, actorIds.planReviewer, actorIds.destinationReviewer, actorIds.collectionVerifier])];
    for (const id of httpActors) {
      const response = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://appsheet-pending.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@pending-import.test`, password: httpPassword }),
      });
      assert.equal(response.status, 200, `login HTTP sintético de ${id}: ${await response.text()}`);
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    const commandOverHttp = async (actorId: string, envelope: unknown) => fetch(`${apiBase}/operations/commands`, {
      method: "POST",
      headers: { Cookie: cookies[actorId]!, Origin: "http://appsheet-pending.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    const source = syntheticPendingHistorySource();
    const preparedHistory = prepareAppSheetHistoryProjection(source.capture, source.definition);
    const stageBackup = { manifestHash: sha256("synthetic history backup manifest"), snapshotAt: new Date(Date.now() - 60_000).toISOString() };
    const stageCommitSha = sha256("synthetic history source commit").slice(0, 40);
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
      reviewer: actorIds.sourceTechnicalReviewer,
      approved: true,
      reviewedAt: new Date(Date.now() - 120_000).toISOString(),
      findings: [],
    };
    const stagedHistory = await stageAppSheetHistoryProjection(preparedHistory, {
      actorId: actorIds.sourceStager,
      technicalReview,
      commitSha: stageCommitSha,
      target: "isolated-test",
      destinationIdentity,
      backupEvidence: stageBackup,
    }, db);
    assert.equal(stagedHistory.status, "staged");
    assert.equal(stagedHistory.replay, false);
    assert.equal(stagedHistory.metrics.recordCount, 4);
    assert.equal(stagedHistory.metrics.factCount, 4);
    const snapshotId = stagedHistory.snapshotId;
    const sourceSnapshot = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    assert.equal(sourceSnapshot.status, "staged");
    assert.equal(sourceSnapshot.captureManifestId, source.capture.manifest.captureId);

    const request = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    const sourceReviewData = (evidenceReference: string, overrides: Record<string, unknown> = {}) => ({
      fileHash: source.capture.manifest.manifestHash,
      captureId: source.capture.manifest.captureId,
      dataHash: source.capture.manifest.dataHash,
      projectionHash: preparedHistory.projectionHash,
      evidenceReference,
      ...overrides,
    });
    const commandFailureState = async (envelope: CommandEnvelope, batchId?: string) => ({
      snapshot: await db.legacyImportSnapshot.findUnique({ where: { id: snapshotId }, select: { status: true, reviewedBy: true, reviewedAt: true, controls: true } }),
      batch: batchId ? await db.appSheetPendingImportBatch.findUnique({ where: { id: batchId } }) : null,
      pendingBatchCount: await db.appSheetPendingImportBatch.count({ where: { snapshotId } }),
      dispositionCount: await db.appSheetPendingImportDisposition.count({ where: batchId ? { batchId } : {} }),
      settlementCount: await db.appSheetLegacySettlement.count({ where: batchId ? { batchId } : {} }),
      targetObject: await db.operationObject.findUnique({ where: { id: envelope.targetId } }),
      receiptCount: await db.commandReceipt.count({ where: { requestId: envelope.requestId } }),
      outboxCount: await db.operationOutbox.count({ where: { requestId: envelope.requestId } }),
      auditCount: await db.operationAudit.count({ where: { requestId: envelope.requestId } }),
    });
    const rejectWithoutWrites = async (who: string, envelope: CommandEnvelope, batchId?: string) => {
      const before = await commandFailureState(envelope, batchId);
      await assert.rejects(executeCommand(await actor(who), envelope));
      assert.deepEqual(await commandFailureState(envelope, batchId), before, `${envelope.command} no debe persistir efectos al fallar`);
    };
    const rejectHttpWithoutWrites = async (who: string, envelope: CommandEnvelope, batchId?: string) => {
      const before = await commandFailureState(envelope, batchId);
      const response = await commandOverHttp(who, envelope);
      const body = await response.json() as Record<string, unknown>;
      assert.ok(response.status >= 400, `${envelope.command} debe fallar por HTTP; recibió ${response.status}`);
      assert.deepEqual(await commandFailureState(envelope, batchId), before,
        `${envelope.command} no debe persistir efectos al fallar por HTTP`);
      return { status: response.status, body };
    };

    const missingEvidence = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic missing evidence", { evidenceReference: undefined }),
    });
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, missingEvidence);
    const selfReview = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic self-review is not independent"),
    });
    await rejectHttpWithoutWrites(actorIds.sourceStager, selfReview);
    const staleSourceReview = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic stale source reference", { projectionHash: sha256("wrong projection hash") }),
    });
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, staleSourceReview);
    for (const [identity, overrides] of [
      ["file hash", { fileHash: sha256("wrong source file hash") }],
      ["capture id", { captureId: `appsreal-${sha256("wrong capture id").slice(0, 16)}` }],
      ["data hash", { dataHash: sha256("wrong source data hash") }],
    ] as const) {
      const staleIdentity = request(snapshotId, "AppSheetHistorySourceReviewed", {
        ...sourceReviewData(`synthetic stale ${identity}`, overrides),
      });
      await rejectHttpWithoutWrites(actorIds.sourceReviewer, staleIdentity);
    }
    const missingCaptureIdentity = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic missing capture identity", { captureId: undefined }),
    });
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, missingCaptureIdentity);
    const staleSourceReviewVersion = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic stale request version"),
    }, 1);
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, staleSourceReviewVersion);
    const missingReviewerCapability = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic source review without reviewer capability"),
    });
    await rejectHttpWithoutWrites(actorIds.sourceReader, missingReviewerCapability);
    const rollbackRequest = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic rollback after the human-review handler writes snapshot and audit"),
    });
    const rollbackToken = randomUUID().replaceAll("-", "").slice(0, 10);
    const rollbackFunction = `force_review_rb_${rollbackToken}`;
    const rollbackTrigger = `force_review_rb_${rollbackToken}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}"."${rollbackFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."requestId" = '${rollbackRequest.requestId}' THEN
          RAISE EXCEPTION 'synthetic rollback after AppSheet source-review writes';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${rollbackTrigger}" BEFORE INSERT ON "${schema}"."CommandReceipt"
      FOR EACH ROW EXECUTE FUNCTION "${schema}"."${rollbackFunction}"()`);
    try {
      await rejectHttpWithoutWrites(actorIds.sourceReviewer, rollbackRequest);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${rollbackTrigger}" ON "${schema}"."CommandReceipt"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${rollbackFunction}"()`);
    }
    const sourceReviewRequest = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic human review of the staged stable capture"),
    });
    const sourceReviewResponse = await commandOverHttp(actorIds.sourceReviewer, sourceReviewRequest);
    assert.equal(sourceReviewResponse.status, 200, await sourceReviewResponse.clone().text());
    const sourceReviewed = await sourceReviewResponse.json() as { result: Record<string, unknown>; replay: boolean; version: number };
    assert.equal(sourceReviewed.result.status, "reviewed");
    assert.equal(sourceReviewed.result.effects.stock, false);
    assert.equal(sourceReviewed.result.effects.cashLedger, false);
    assert.equal(sourceReviewed.result.effects.payments, false);
    assert.equal(sourceReviewed.result.effects.deliveries, false);
    assert.equal(sourceReviewed.result.effects.numbering, "not-generated");
    const reviewedSnapshot = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    assert.equal(reviewedSnapshot.status, "reviewed");
    assert.equal(reviewedSnapshot.reviewedBy, actorIds.sourceReviewer);
    const sourceReviewAuditWhere = { objectId: snapshotId, action: "legacy.appsheet_history_source_reviewed" };
    assert.equal(await db.operationAudit.count({ where: sourceReviewAuditWhere }), 1);
    const sourceReviewReplayResponse = await commandOverHttp(actorIds.sourceReviewer, sourceReviewRequest);
    assert.equal(sourceReviewReplayResponse.status, 200, await sourceReviewReplayResponse.clone().text());
    const sourceReviewReplay = await sourceReviewReplayResponse.json() as { result: Record<string, unknown>; replay: boolean; version: number };
    assert.equal(sourceReviewReplay.replay, true, "el mismo envelope de revisión se devuelve por receipt idempotente");
    assert.deepEqual(sourceReviewReplay.result, sourceReviewed.result);
    assert.equal(await db.operationAudit.count({ where: sourceReviewAuditWhere }), 1, "el replay conserva un único audit humano");
    const reusedReviewRequestId = {
      ...sourceReviewRequest,
      data: sourceReviewData("synthetic changed evidence under an already-used request id"),
    } as CommandEnvelope;
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, reusedReviewRequestId);
    const newReviewAfterReviewed = request(snapshotId, "AppSheetHistorySourceReviewed", {
      ...sourceReviewData("synthetic new request against already-reviewed source"),
    }, sourceReviewed.version);
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, newReviewAfterReviewed);
    const reviewedHistoryProof = await db.$transaction((tx) => requireBoundAppSheetHistoryStage(tx, snapshotId, {
      target: "isolated-test", destinationIdentity, requireReviewed: true,
    }));
    assert.equal(reviewedHistoryProof.snapshot.status, "reviewed");
    assert.equal(reviewedHistoryProof.snapshot.reviewedBy, actorIds.sourceReviewer);
    assert.equal(reviewedHistoryProof.capture.captureId, source.capture.manifest.captureId);
    assert.equal(reviewedHistoryProof.stage.projectionHash, preparedHistory.projectionHash);
    assert.equal(reviewedHistoryProof.metrics.recordCount, 4);

    const beforePendingEffects = async () => ({
      orders: await db.operationOrder.findMany({ orderBy: { id: "asc" }, select: { id: true, verifiedMinor: true, refundedMinor: true, financialState: true, fulfillmentState: true, totalMinor: true } }),
      deliveryAssignments: await db.deliveryAssignment.count(),
      stockFacts: await db.stockFact.count(),
      stockBalances: await db.stockBalance.count(),
      ledgerEvents: await db.ledgerEvent.count(),
      cashEntries: await db.cashEntry.count(),
      collectionReports: await db.collectionReport.count(),
      payablePayments: await db.payablePayment.count(),
      invoiceSequences: await db.appSheetInvoiceSequence.count(),
      invoiceReservations: await db.appSheetInvoiceNumberReservation.count(),
    });
    const memberId = actorIds.member;
    await db.operationMember.create({ data: {
      id: memberId, name: "Synthetic pending-import member", address: { address: "Current order address must not be substituted" }, preferences: {},
    } });
    const orderId = `pending-order-${randomUUID()}`;
    const skuId = `pending-sku-${randomUUID()}`;
    await db.operationOrder.create({
      data: {
        id: orderId,
        memberId,
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
        address: { address: "Current order address must not be substituted" },
        createdBy: actorIds.importer,
        lines: { create: [{
          id: `pending-order-line-${randomUUID()}`, skuId, unit: "g", requested: "1", unitPrice: "100",
          referenceMinor: 10_000n, revenueMinor: 10_000n,
        }] },
      },
    });
    await db.operationObject.create({ data: { id: orderId, kind: "order", version: 1, createdBy: actorIds.importer } });
    const order = await db.operationOrder.findUniqueOrThrow({ where: { id: orderId, }, include: { lines: true } });
    const orderObject = await db.operationObject.findUniqueOrThrow({ where: { id: orderId } });
    const operationsBeforePendingImport = await beforePendingEffects();
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
    assert.match(appSheetPendingOrderCommercialBasisHash(order) ?? "", /^[a-f0-9]{64}$/, "el pedido fixture tiene una base comercial sellable");

    const pendingBinding = {
      target: "isolated-test" as const,
      destinationIdentity,
      commitSha: sha256("synthetic pending importer commit").slice(0, 40),
      backupManifestHash: sha256("synthetic pending destination backup"),
      backupSnapshotAt: new Date().toISOString(),
    };
    const planWithoutIdentity = await db.$transaction((tx) => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
    const invoiceDisposition = planWithoutIdentity.dispositions.find((row) => row.sourceTable === "C_Facturacion" && row.dimension === "receivable");
    assert.ok(invoiceDisposition, "la factura sintética queda en la cobertura de cuentas por cobrar");
    assert.equal(invoiceDisposition.sourceStatus, "confirmed_pending");
    const orderIdentityRequest = request(snapshotId, "AppSheetPendingOrderIdentityReviewed", {
      sourceRecordId: invoiceDisposition.sourceRecordId,
      sourceRecordHash: invoiceDisposition.sourceRecordHash,
      reconciliationHash: invoiceDisposition.reconciliationHash,
      mappingHash: invoiceDisposition.mappingHash,
      operationOrderId: orderId,
      operationOrderVersion: orderObject.version,
      operationOrderHash: orderHash,
      evidence: "Vinculación sintética exacta entre la fila histórica y el pedido existente.",
    }, (await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } })).version);
    const orderMappingStateBeforeSpoof = await commandFailureState(orderIdentityRequest);
    const spoofedOrderMapping = { ...orderIdentityRequest, actorId: actorIds.planReviewer };
    const spoofedOrderMappingResponse = await commandOverHttp(actorIds.orderMapper, spoofedOrderMapping);
    assert.equal(spoofedOrderMappingResponse.status, 400,
      "la API autenticada rechaza `actorId` provisto en el envelope en vez de permitir suplantación");
    assert.deepEqual(await commandFailureState(orderIdentityRequest), orderMappingStateBeforeSpoof,
      "el intento de suplantar al actor no crea receipt, audit ni resolución");
    const mappedOrderResponse = await commandOverHttp(actorIds.orderMapper, orderIdentityRequest);
    assert.equal(mappedOrderResponse.status, 200, await mappedOrderResponse.clone().text());
    const mappedOrder = await mappedOrderResponse.json() as { result: Record<string, unknown>; replay: boolean };
    assert.equal(mappedOrder.result.operationOrderId, orderId);
    assert.equal((await db.commandReceipt.findUniqueOrThrow({ where: { requestId: orderIdentityRequest.requestId } })).actorId,
      actorIds.orderMapper, "la identidad registrada proviene de la sesión HTTP autenticada");

    const sourceCell = async (sourceRecordId: string, header: string) => {
      const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
      const original = record.original as { columns?: Array<Record<string, unknown>> };
      const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
      const originalMatches = (original.columns ?? []).filter((column) => column.header === header);
      const normalizedMatches = (normalized.columns ?? []).filter((column) => column.header === header);
      assert.equal(originalMatches.length, 1, `una celda original única para ${header}`);
      assert.equal(normalizedMatches.length, 1, `una celda normalizada única para ${header}`);
      const originalColumn = originalMatches[0]!;
      const normalizedColumn = normalizedMatches[0]!;
      assert.equal(typeof normalizedColumn.value, "string");
      return {
        sourceRecordId: record.id,
        sourceRecordHash: record.contentHash,
        coordinate: String(originalColumn.coordinate),
        header,
        valueHash: sha256Canonical(originalColumn.value),
      };
    };
    const capturedCellValue = async (sourceRecordId: string, header: string): Promise<string> => {
      const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
      const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
      const matches = (normalized.columns ?? []).filter((column) => column.header === header);
      assert.equal(matches.length, 1, `un valor capturado único para ${header}`);
      assert.equal(typeof matches[0]!.value, "string");
      return matches[0]!.value as string;
    };
    const invoiceRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Facturacion" } });
    const motoRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Moto" } });
    const planBeforeDeliveryResolution = await db.$transaction((tx) => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
    const motoDisposition = planBeforeDeliveryResolution.dispositions.find((row) => row.sourceRecordId === motoRecord.id && row.dimension === "delivery");
    assert.ok(motoDisposition);
    assert.equal(motoDisposition.sourceStatus, "confirmed_pending");
    const [motoKeyCell, invoiceReferenceCell, invoiceKeyCell, invoiceAddressCell] = await Promise.all([
      sourceCell(motoRecord.id, "Id_Moto"),
      sourceCell(motoRecord.id, "N_Factura"),
      sourceCell(invoiceRecord.id, "N_factura"),
      sourceCell(invoiceRecord.id, "Domicilio"),
    ]);
    const [capturedMotoInvoiceReference, capturedInvoiceNumber] = await Promise.all([
      capturedCellValue(motoRecord.id, "N_Factura"), capturedCellValue(invoiceRecord.id, "N_factura"),
    ]);
    assert.equal(capturedInvoiceNumber, source.invoiceNumber);
    assert.equal(invoiceReferenceCell.valueHash, invoiceKeyCell.valueHash,
      "el valor bruto C_Moto.N_Factura debe ser exactamente la celda C_Facturacion.N_factura");
    assert.equal(invoiceRecord.sourceKey, source.invoiceSourceKey);
    assert.notEqual(capturedInvoiceNumber, invoiceRecord.sourceKey, "la clave Id_Factura es distinta del valor N_factura");
    assert.equal(appSheetDeliveryInvoiceReferenceMatches(capturedMotoInvoiceReference, capturedInvoiceNumber), true,
      "la referencia de entrega coincide con la celda física C_Facturacion.N_factura");
    assert.equal(appSheetDeliveryInvoiceReferenceMatches(capturedMotoInvoiceReference, invoiceRecord.sourceKey), false,
      "la referencia de entrega no se coteja contra Id_Factura/sourceKey");
    const deliveryRequest = request(snapshotId, "AppSheetPendingDeliveryResolved", {
      sourceRecordId: motoDisposition.sourceRecordId,
      sourceRecordHash: motoDisposition.sourceRecordHash,
      reconciliationHash: motoDisposition.reconciliationHash,
      mappingHash: motoDisposition.mappingHash,
      sourceSpecHash: planBeforeDeliveryResolution.sourceSpecHash,
      invoiceRecordId: invoiceRecord.id,
      invoiceRecordHash: invoiceRecord.contentHash,
      motoKeyCell,
      invoiceReferenceCell,
      invoiceKeyCell,
      invoiceAddressCell,
      operationOrderId: orderId,
      operationOrderVersion: orderObject.version,
      operationOrderHash: orderHash,
      evidence: "N_Factura coincide exactamente con N_factura; el domicilio procede de la celda física Domicilio de la factura.",
    }, (await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } })).version);
    const resolvedDeliveryResponse = await commandOverHttp(actorIds.deliveryReviewer, deliveryRequest);
    assert.equal(resolvedDeliveryResponse.status, 200, await resolvedDeliveryResponse.clone().text());
    const resolvedDelivery = await resolvedDeliveryResponse.json() as { result: Record<string, unknown>; replay: boolean };
    assert.equal(resolvedDelivery.result.approvedBy, actorIds.deliveryReviewer);
    assert.equal((await db.commandReceipt.findUniqueOrThrow({ where: { requestId: deliveryRequest.requestId } })).actorId,
      actorIds.deliveryReviewer, "la resolución HTTP conserva el reviewer autenticado");

    const plan = await db.$transaction((tx) => prepareAppSheetPendingImportPlan(tx, { snapshotId, binding: {
      ...pendingBinding, backupSnapshotAt: new Date(pendingBinding.backupSnapshotAt),
    } }));
    assert.equal(plan.materializedSettlements.length, 1, "la factura parcial se prepara como liquidación histórica separada");
    assert.equal(plan.materializedSettlements[0]!.dueMinor, 10_000n);
    assert.equal(plan.materializedSettlements[0]!.legacyPaidMinor, 4_000n);
    assert.equal(plan.materializedSettlements[0]!.remainingMinor, 6_000n);
    assert.equal(plan.materializedDeliveries.length, 1, "C_Moto queda lista como asignación pendiente sin despacho");
    assert.equal(plan.materializedDeliveries[0]!.address.address, source.historicalAddress);

    const planReviewObjectId = `appsheet-pending-plan-review:${plan.batchId}`;
    const reviewFor = (reviewer: string, reviewKind: "independent-pending-import-plan" | "independent-pending-import-destination") => ({
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
      commitSha: plan.commitSha,
      backupManifestHash: plan.backupManifestHash,
      backupSnapshotAt: plan.backupSnapshotAt.toISOString(),
      importer: actorIds.importer,
      reviewer,
      approved: true as const,
      reviewedAt: new Date().toISOString(),
      findings: [],
    });
    const planReviewEnvelope = (expectedVersion: number) => request(planReviewObjectId, "AppSheetPendingImportPlanReviewed", {
      snapshotId,
      importerId: actorIds.importer,
      target: "isolated-test",
      destinationIdentity,
      commitSha: plan.commitSha,
      backupManifestHash: plan.backupManifestHash,
      backupSnapshotAt: plan.backupSnapshotAt.toISOString(),
      review: reviewFor(actorIds.planReviewer, "independent-pending-import-plan"),
    }, expectedVersion);
    const stageEnvelope = (planReviewRequestId: string) => request(plan.batchId, "AppSheetPendingImportStaged", {
      snapshotId,
      target: "isolated-test",
      destinationIdentity,
      commitSha: plan.commitSha,
      backupManifestHash: plan.backupManifestHash,
      backupSnapshotAt: plan.backupSnapshotAt.toISOString(),
      planReviewRequestId,
    });
    const missingPlanReviewRequest = stageEnvelope(randomUUID());
    await rejectWithoutWrites(actorIds.importer, missingPlanReviewRequest, plan.batchId);

    const firstPlanReviewRequest = planReviewEnvelope(0);
    const projectionTamperRecord = await db.legacySourceRecord.findFirstOrThrow({
      where: { snapshotId, sourceTable: "C_Facturacion" }, select: { id: true, normalized: true, contentHash: true },
    });
    const originalNormalized = structuredClone(projectionTamperRecord.normalized);
    const tamperedNormalized = {
      ...(originalNormalized as Record<string, unknown>),
      syntheticReviewNote: "synthetic post-capture projection tamper",
    };
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacySourceRecord" DISABLE TRIGGER "LegacySourceRecord_immutable"`);
    try {
      await db.legacySourceRecord.update({
        where: { id: projectionTamperRecord.id },
        data: { normalized: tamperedNormalized as Prisma.InputJsonValue },
      });
      assert.equal((await db.legacySourceRecord.findUniqueOrThrow({ where: { id: projectionTamperRecord.id } })).contentHash,
        projectionTamperRecord.contentHash, "el tamper sintético no altera el hash declarado del registro");
      const tamperedPlanReview = await rejectHttpWithoutWrites(actorIds.planReviewer, firstPlanReviewRequest, plan.batchId);
      assert.equal(tamperedPlanReview.body.code, "history_source_projection_content_changed",
        "la revisión vuelve a sellar la proyección real y rechaza normalized alterado pese a conservar contentHash");
    } finally {
      try {
        await db.legacySourceRecord.update({
          where: { id: projectionTamperRecord.id },
          data: { normalized: originalNormalized as Prisma.InputJsonValue },
        });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacySourceRecord" ENABLE TRIGGER "LegacySourceRecord_immutable"`);
      }
    }
    await rejectHttpWithoutWrites(actorIds.importer, firstPlanReviewRequest, plan.batchId);
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, firstPlanReviewRequest, plan.batchId);
    const planReviewStateBeforeSpoof = await commandFailureState(firstPlanReviewRequest, plan.batchId);
    const spoofedPlanReview = { ...firstPlanReviewRequest, actorId: actorIds.destinationReviewer };
    const spoofedPlanReviewResponse = await commandOverHttp(actorIds.planReviewer, spoofedPlanReview);
    assert.equal(spoofedPlanReviewResponse.status, 400,
      "la API de revisión rechaza un actorId del body y usa exclusivamente la sesión autenticada");
    assert.deepEqual(await commandFailureState(firstPlanReviewRequest, plan.batchId), planReviewStateBeforeSpoof,
      "el envelope de revisión con actorId adicional no persiste receipt ni review");
    const firstPlanReviewResponse = await commandOverHttp(actorIds.planReviewer, firstPlanReviewRequest);
    assert.equal(firstPlanReviewResponse.status, 200, await firstPlanReviewResponse.clone().text());
    const firstPlanReview = await firstPlanReviewResponse.json() as { result: Record<string, unknown>; replay: boolean; version: number };
    assert.equal(firstPlanReview.result.batchId, plan.batchId);
    assert.equal(firstPlanReview.result.sourceSpecHash, plan.sourceSpecHash,
      "el recibo real de revisión debe sellar sourceSpecHash para que Stage pueda verificarlo");
    const reviewReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: firstPlanReviewRequest.requestId } });
    assert.equal(reviewReceipt.actorId, actorIds.planReviewer, "PlanReviewed registra la sesión autenticada como reviewer");
    const planReviewObject = await db.operationObject.findUniqueOrThrow({ where: { id: planReviewObjectId } });
    await db.operationObject.update({ where: { id: planReviewObjectId }, data: { version: { increment: 1 } } });
    const stalePlanReviewRequest = stageEnvelope(reviewReceipt.requestId);
    await rejectWithoutWrites(actorIds.importer, stalePlanReviewRequest, plan.batchId);

    const currentPlanReviewObject = await db.operationObject.findUniqueOrThrow({ where: { id: planReviewObjectId } });
    assert.equal(currentPlanReviewObject.version, planReviewObject.version + 1);
    const currentPlanReviewRequest = planReviewEnvelope(currentPlanReviewObject.version);
    const currentPlanReviewResponse = await commandOverHttp(actorIds.planReviewer, currentPlanReviewRequest);
    assert.equal(currentPlanReviewResponse.status, 200, await currentPlanReviewResponse.clone().text());
    const currentPlanReview = await currentPlanReviewResponse.json() as { result: Record<string, unknown>; replay: boolean };
    assert.equal(currentPlanReview.result.sourceSpecHash, plan.sourceSpecHash);
    const stageRequest = stageEnvelope(currentPlanReviewRequest.requestId);
    const stageStateBeforePublicAttempt = await commandFailureState(stageRequest, plan.batchId);
    const publicStageResponse = await commandOverHttp(actorIds.importer, stageRequest);
    assert.equal(publicStageResponse.status, 403, "la carga por lotes conserva su frontera interna");
    assert.equal((await publicStageResponse.json()).code, "INTERNAL_COMMAND");
    assert.deepEqual(await commandFailureState(stageRequest, plan.batchId), stageStateBeforePublicAttempt,
      "la API humana no expone el staging interno ni deja efectos");
    const stagedPending = await executeCommand(await actor(actorIds.importer), stageRequest);
    assert.equal(stagedPending.result.status, "staged");
    assert.equal(stagedPending.result.sourceSpecHash, plan.sourceSpecHash);
    assert.equal(stagedPending.result.effects.stock, false);
    assert.equal(stagedPending.result.effects.cashLedger, false);
    assert.equal(stagedPending.result.effects.payments, false);
    assert.equal(stagedPending.result.effects.dispatches, false);
    const batch = await db.appSheetPendingImportBatch.findUniqueOrThrow({ where: { id: plan.batchId } });
    assert.equal(batch.status, "staged");
    assert.equal(batch.sourceSpecHash, plan.sourceSpecHash);
    assert.equal(await db.appSheetPendingImportDisposition.count({ where: { batchId: plan.batchId } }), 16);
    assert.equal(await db.appSheetLegacySettlement.count({ where: { batchId: plan.batchId, dueMinor: 10_000n, legacyPaidMinor: 4_000n, remainingMinor: 6_000n, status: "staged" } }), 1);
    const effectsAfterStage = await beforePendingEffects();
    assert.deepEqual(effectsAfterStage, operationsBeforePendingImport, "staging conserva la orden y no crea efectos operativos históricos");
    const stagedPendingReplay = await executeCommand(await actor(actorIds.importer), stageRequest);
    assert.equal(stagedPendingReplay.replay, true);
    assert.equal(await db.appSheetPendingImportBatch.count({ where: { snapshotId } }), 1);
    assert.equal(await db.appSheetPendingImportDisposition.count({ where: { batchId: plan.batchId } }), 16);
    assert.deepEqual(await beforePendingEffects(), operationsBeforePendingImport);

    const destinationReviewRequest = request(plan.batchId, "AppSheetPendingImportDestinationReviewed", {
      review: reviewFor(actorIds.destinationReviewer, "independent-pending-import-destination"),
    }, 1);
    const destinationPreviewUrl = `${apiBase}/operations/appsheet-pending-imports/${encodeURIComponent(plan.batchId)}/review-preview`;
    const previewReadState = async () => ({
      operations: await beforePendingEffects(),
      auditCount: await db.operationAudit.count(),
      receiptCount: await db.commandReceipt.count(),
      outboxCount: await db.operationOutbox.count(),
    });
    const previewStateBefore = await previewReadState();
    const unauthenticatedPreview = await fetch(destinationPreviewUrl, {
      headers: { Origin: "http://appsheet-pending.test" },
    });
    assert.equal(unauthenticatedPreview.status, 401, "la vista previa de destino requiere sesión autenticada");
    const readOnlyPreview = await fetch(destinationPreviewUrl, {
      headers: { Cookie: cookies[actorIds.sourceReader]!, Origin: "http://appsheet-pending.test" },
    });
    assert.equal(readOnlyPreview.status, 403, "la vista previa requiere imports.review aunque el actor tenga imports.read");
    const previewResponse = await fetch(destinationPreviewUrl, {
      headers: { Cookie: cookies[actorIds.sourceReviewer]!, Origin: "http://appsheet-pending.test" },
    });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const destinationPreview = await previewResponse.json() as Record<string, unknown>;
    assert.deepEqual(destinationPreview, {
      batchId: plan.batchId,
      status: "staged",
      expectedVersion: 1,
      captureId: plan.captureId,
      manifestHash: plan.manifestHash,
      dataHash: plan.dataHash,
      projectionHash: plan.projectionHash,
      dispositionHash: plan.dispositionHash,
      destinationHash: plan.destinationHash,
      dispositionCount: 16,
      legacySettlementCount: 1,
      pendingDeliveryAssignmentCount: 1,
    }, "la vista previa expone sólo hashes ligados y conteos derivados del plan actual");
    const destinationReviewBody = destinationReviewRequest.data as { review: Record<string, unknown> };
    for (const key of ["captureId", "manifestHash", "dataHash", "projectionHash", "dispositionHash", "destinationHash"])
      assert.equal(destinationPreview[key], destinationReviewBody.review[key], `${key} coincide con la revisión del destino`);
    assert.equal(destinationPreview.expectedVersion, destinationReviewRequest.expectedVersion,
      "la versión de la vista previa es la esperada por el comando de revisión");
    const unknownPreview = await fetch(`${apiBase}/operations/appsheet-pending-imports/${encodeURIComponent(`unknown-${randomUUID()}`)}/review-preview`, {
      headers: { Cookie: cookies[actorIds.sourceReviewer]!, Origin: "http://appsheet-pending.test" },
    });
    assert.equal(unknownPreview.status, 404, "un lote desconocido no filtra registros ni se presenta como vista previa vacía");
    assert.deepEqual(await previewReadState(), previewStateBefore, "consultar la vista previa no escribe efectos, receipts, audits ni outbox");
    await rejectHttpWithoutWrites(actorIds.importer, destinationReviewRequest, plan.batchId);
    await rejectHttpWithoutWrites(actorIds.sourceReviewer, destinationReviewRequest, plan.batchId);
    assert.equal((await db.appSheetPendingImportBatch.findUniqueOrThrow({ where: { id: plan.batchId } })).status, "staged");
    assert.equal(await db.deliveryAssignment.count({ where: { orderId } }), 0);

    const destinationReviewResponse = await commandOverHttp(actorIds.destinationReviewer, destinationReviewRequest);
    assert.equal(destinationReviewResponse.status, 200, await destinationReviewResponse.clone().text());
    const destinationReview = await destinationReviewResponse.json() as { result: Record<string, unknown>; replay: boolean };
    assert.equal(destinationReview.result.status, "reviewed");
    assert.equal((await db.commandReceipt.findUniqueOrThrow({ where: { requestId: destinationReviewRequest.requestId } })).actorId,
      actorIds.destinationReviewer, "DestinationReviewed registra al actor de la sesión autenticada");
    const reviewedBatch = await db.appSheetPendingImportBatch.findUniqueOrThrow({ where: { id: plan.batchId } });
    assert.equal(reviewedBatch.status, "reviewed");
    assert.equal(reviewedBatch.reviewedBy, actorIds.destinationReviewer);
    const settlement = await db.appSheetLegacySettlement.findFirstOrThrow({ where: { batchId: plan.batchId } });
    assert.equal(settlement.currency, "ARS");
    assert.equal(settlement.dueMinor, 10_000n);
    assert.equal(settlement.legacyPaidMinor, 4_000n);
    assert.equal(settlement.remainingMinor, 6_000n);
    assert.equal(settlement.status, "reviewed");
    const assignment = await db.deliveryAssignment.findFirstOrThrow({ where: { orderId } });
    assert.equal(assignment.status, "pending");
    assert.equal(assignment.routeId, null);
    assert.equal(assignment.driverId, null);
    assert.equal(assignment.dispatchedAt, null);
    assert.equal(assignment.deliveredAt, null);
    assert.deepEqual(assignment.address, {
      address: source.historicalAddress,
      source: "appsheet-pending-import",
      captureId: source.capture.manifest.captureId,
      invoiceSourceRecordId: invoiceRecord.id,
      invoiceSourceRecordHash: invoiceRecord.contentHash,
      invoiceAddressCoordinate: invoiceAddressCell.coordinate,
    });
    assert.notDeepEqual(assignment.address, order.address, "la entrega conserva el domicilio histórico verificado de C_Facturacion");
    assert.deepEqual(await beforePendingEffects(), {
      ...operationsBeforePendingImport,
      deliveryAssignments: 1,
    }, "la revisión sólo materializa una asignación pendiente y no cobra, despacha ni altera stock/caja");
    const effectsAfterDestinationReview = await beforePendingEffects();
    const replayedDestinationReviewResponse = await commandOverHttp(actorIds.destinationReviewer, destinationReviewRequest);
    assert.equal(replayedDestinationReviewResponse.status, 200, await replayedDestinationReviewResponse.clone().text());
    const replayedDestinationReview = await replayedDestinationReviewResponse.json() as { result: Record<string, unknown>; replay: boolean };
    assert.equal(replayedDestinationReview.replay, true);
    assert.deepEqual(await beforePendingEffects(), effectsAfterDestinationReview, "repetir la revisión exacta no duplica liquidación ni asignación");

    const collectionAccountId = `pending-import-cash-${randomUUID()}`;
    await db.operationAccount.create({ data: {
      id: collectionAccountId, name: "Synthetic collection cash", currency: "ARS", kind: "cash", holder: "Fixture",
      purpose: "Fail-closed legacy settlement contract", verified: true, openingApprovedBy: actorIds.importer,
      openingEvidence: { reference: "synthetic account opening" },
    } });
    const collectionId = `pending-import-collection-${randomUUID()}`;
    const collectionReportRequest = request(collectionId, "CollectionReported", {
      orderId, method: "cash", currency: "ARS", amountMinor: "1000", evidence: { reference: "synthetic reported cash receipt" },
    });
    const collectionReported = await executeCommand(await actor(actorIds.collectionReporter), collectionReportRequest);
    assert.equal(collectionReported.result.effect, "reported_only");
    const verifyCollectionRequest = request(collectionId, "CollectionVerified", {
      accountId: collectionAccountId, evidence: { reference: "synthetic verification blocked by revoked import reviewer" },
    }, collectionReported.version);
    const collectionFailureState = async () => ({
      report: await db.collectionReport.findUniqueOrThrow({ where: { id: collectionId } }),
      order: await db.operationOrder.findUniqueOrThrow({ where: { id: orderId }, select: {
        verifiedMinor: true, refundedMinor: true, financialState: true, totalMinor: true,
      } }),
      orderObject: await db.operationObject.findUniqueOrThrow({ where: { id: orderId } }),
      collectionObject: await db.operationObject.findUniqueOrThrow({ where: { id: collectionId } }),
      ledgerEventCount: await db.ledgerEvent.count(),
      ledgerLegCount: await db.ledgerLeg.count(),
      memberCreditCount: await db.memberCredit.count(),
      receiptCount: await db.commandReceipt.count({ where: { requestId: verifyCollectionRequest.requestId } }),
      outboxCount: await db.operationOutbox.count({ where: { requestId: verifyCollectionRequest.requestId } }),
      auditCount: await db.operationAudit.count({ where: { requestId: verifyCollectionRequest.requestId } }),
    });
    const collectionBeforeRevokedReviewerVerification = await collectionFailureState();
    await db.operationAccess.update({ where: { userId: actorIds.destinationReviewer }, data: { capabilities: ["imports.write"] } });
    const revokedReviewerReplay = await commandOverHttp(actorIds.destinationReviewer, destinationReviewRequest);
    assert.equal(revokedReviewerReplay.status, 403, "la capacidad actual se comprueba antes de devolver el receipt en caché");
    assert.equal((await revokedReviewerReplay.json()).code, "CAPABILITY_REQUIRED");
    assert.equal(await db.commandReceipt.count({ where: { requestId: destinationReviewRequest.requestId } }), 1,
      "el replay denegado conserva el receipt original y no fabrica otro");
    assert.equal(await db.operationAudit.count({ where: { objectId: plan.batchId, action: "appsheet.pending_import_destination_reviewed" } }), 1,
      "el replay denegado no duplica el audit de destino");
    const revokedReviewerCollectionResponse = await commandOverHttp(actorIds.collectionVerifier, verifyCollectionRequest);
    assert.equal(revokedReviewerCollectionResponse.status, 403);
    assert.equal((await revokedReviewerCollectionResponse.json()).code, "CAPABILITY_REQUIRED",
      "no se acepta el pago si la persona que revisó la importación perdió imports.review");
    assert.deepEqual(await collectionFailureState(), collectionBeforeRevokedReviewerVerification,
      "revocar la capacidad de quien revisó el destino no produce asiento ni modifica el pedido o cobro reportado");

    assert.equal(await db.appSheetPendingImportBatch.count({ where: { snapshotId } }), 1);
    assert.equal(await db.appSheetLegacySettlement.count({ where: { batchId: plan.batchId } }), 1);
    assert.equal(await db.deliveryAssignment.count({ where: { orderId } }), 1);
    assert.equal(await db.appSheetInvoiceSequence.count(), 0);
    assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
