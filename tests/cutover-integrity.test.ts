import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import { cutoverGateIds, type CommandEnvelope } from "../shared/operations/contracts.js";

test("cutover keeps legacy reviews compatible, rejects an unproven AppSheet gate, and rolls back activation", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /test|ci|ui_restore/i, "tests require an isolated local test/rehearsal database");
  const schema = `cutover_${randomUUID().replaceAll("-", "")}`;
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.DEMO_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "cutover-test-only-secret-more-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://cutover.test";
  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrations = new URL("../prisma/migrations/", import.meta.url);
  for (const entry of (await readdir(migrations, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(new URL(`${entry.name}/migration.sql`, migrations), "utf8");
    for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
  }
  const { finalDeltaProofForCapture } = await import("../server/operations/access.js");
  const pause = new Date(Date.now() - 120_000);
  const firstReadAt = new Date(pause.getTime() + 1_000);
  const verificationStartedAt = new Date(firstReadAt.getTime() + 1_000);
  const verificationCompletedAt = new Date(verificationStartedAt.getTime() + 1_000);
  const cutoffAt = new Date(verificationCompletedAt.getTime() + 1_000);
  const capture = {
    captureId: `appsreal-${"b".repeat(16)}`, manifestHash: "a".repeat(64), dataHash: "c".repeat(64), definitionHash: null,
    firstReadAt, verificationStartedAt, verificationCompletedAt, cutoffAt,
    stability: { stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true,
      scanComplete: true, changedPages: 0, failedPages: 0, unresolvedFormulaCount: 0, sourceWriteDetected: false },
  };
  const finalDeltaInput = {
    manualPauseStartedAt: pause.toISOString(), manualPauseEndedAt: null,
    manualPauseEvidenceRef: "pause-log:synthetic-test", expectedHandoffChangesRef: "delta-review:synthetic-test",
  };
  const finalDeltaProof = finalDeltaProofForCapture(capture, finalDeltaInput);
  assert.equal(finalDeltaProof.capture.captureId, capture.captureId);
  assert.equal(finalDeltaProof.capture.manifestHash, capture.manifestHash);
  assert.equal(finalDeltaProof.expectedHandoffChanges.disposition, "separate-review");
  for (const changedCapture of [
    { ...capture, stability: { ...capture.stability, sourceWriteDetected: true } },
    { ...capture, stability: { stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true,
      scanComplete: true, changedPages: 0, failedPages: 0, unresolvedFormulaCount: 0 } },
    { ...capture, firstReadAt: new Date(pause.getTime() - 1) },
    { ...capture, cutoffAt: new Date(pause.getTime() - 1) },
    { ...capture, stability: { ...capture.stability, changedPages: 1 } },
  ]) assert.throws(() => finalDeltaProofForCapture(changedCapture, finalDeltaInput));
  assert.throws(() => finalDeltaProofForCapture(capture, { ...finalDeltaInput, manualPauseEndedAt: new Date(cutoffAt.getTime() - 1).toISOString() }));
  assert.throws(() => finalDeltaProofForCapture(capture, { ...finalDeltaInput, expectedHandoffChangesRef: finalDeltaInput.manualPauseEvidenceRef }));
  const password = await bcrypt.hash("Synthetic-cutover-test-only-123", 4);
  for (const id of ["cutover-owner", "cutover-author", "cutover-reviewer", "cutover-activator", "cutover-admin"])
    await db.user.create({ data: { id, name: id, email: `${id}@test.local`, password, role: "owner" } });
  await db.user.update({ where: { id: "cutover-admin" }, data: { role: "admin" } });
  await db.operationAccess.create({ data: { userId: "cutover-admin", profile: "owner", capabilities: ["cutover.approve"], scope: {}, enabled: true } });
  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const cookies: Record<string, string> = {};
  async function login(id: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { Origin: "http://cutover.test", "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${id}@test.local`, password: "Synthetic-cutover-test-only-123" }),
    });
    assert.equal(response.status, 200);
    cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
  }
  const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope => ({
    schemaVersion: 1, requestId: randomUUID(), targetId, command, data, expectedVersion, occurredAt: new Date().toISOString(),
  });
  async function call(path: string, actor: string, body?: unknown) {
    return fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookies[actor]!, Origin: "http://cutover.test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const priorApproval = process.env.CLUB_OPERATIONS_APPROVED;
  try {
    for (const id of ["cutover-owner", "cutover-author", "cutover-reviewer", "cutover-activator", "cutover-admin"]) await login(id);

    const firstGate = cutoverGateIds[0]!;
    const positiveReview = envelope(firstGate, "CutoverGateReviewed", {
      gateId: firstGate, authorId: "cutover-author", evidence: { reference: "synthetic legacy compatibility test" },
    });
    const positiveResponse = await call("/operations/commands", "cutover-reviewer", positiveReview);
    assert.equal(positiveResponse.status, 200, await positiveResponse.clone().text());
    const positiveBody = await positiveResponse.json();
    assert.equal(positiveBody.result.cutoverProfile, "legacy", "omitting a profile preserves the existing behavior");
    assert.equal(positiveBody.result.captureId, null);
    const legacyGate = await db.cutoverGate.findUniqueOrThrow({ where: { id: firstGate } });
    assert.equal(legacyGate.status, "approved");
    assert.equal(legacyGate.captureManifestId, null);
    assert.equal(legacyGate.approvedBy, "cutover-author");
    assert.equal(legacyGate.reviewedBy, "cutover-reviewer");

    const authorityResponse = await call("/operations/authority", "cutover-owner");
    assert.equal(authorityResponse.status, 200);
    const authorityBody = await authorityResponse.json();
    assert.equal(authorityBody.versions[firstGate], 1, "the gate UI receives a finite version after the first review");
    assert.equal(authorityBody.versions.operations, 0, "the authority command starts with aggregate version zero");

    const unprovenGate = cutoverGateIds[1]!;
    await db.cutoverGate.create({ data: {
      id: unprovenGate, status: "approved", evidence: { note: "synthetic existing legacy gate" },
      approvedBy: "cutover-author", reviewedBy: "cutover-reviewer", approvedAt: new Date(),
    } });
    const deniedRequest = envelope(unprovenGate, "CutoverGateReviewed", {
      gateId: unprovenGate, cutoverProfile: "appsheet-replacement", captureId: `appsreal-${"a".repeat(16)}`,
      authorId: "cutover-author", evidence: { reference: "synthetic replacement attempt without capture" },
    });
    const beforeDeniedGate = await db.cutoverGate.findUniqueOrThrow({ where: { id: unprovenGate } });
    const deniedResponse = await call("/operations/commands", "cutover-reviewer", deniedRequest);
    const deniedBody = await deniedResponse.json();
    assert.equal(deniedResponse.status, 423);
    assert.equal(deniedBody.code, "APPSHEET_REPLACEMENT_NOT_READY");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: deniedRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedRequest.requestId } }), 0);
    assert.equal(await db.operationObject.findUnique({ where: { id: unprovenGate } }), null);
    assert.deepEqual(await db.cutoverGate.findUniqueOrThrow({ where: { id: unprovenGate } }), beforeDeniedGate);

    for (const gateId of cutoverGateIds.slice(2)) await db.cutoverGate.create({ data: {
      id: gateId, status: "approved", evidence: { note: "synthetic legacy fixture for rollback boundary" },
      approvedBy: "cutover-author", reviewedBy: "cutover-reviewer", approvedAt: new Date(),
    } });
    const captureManifestHash = "d".repeat(64);
    const captureId = `appsreal-${captureManifestHash.slice(0, 16)}`;
    const captureTime = new Date("2026-10-01T12:00:00.000Z");
    await db.appSheetCaptureManifest.create({ data: {
      captureId, sourceSystem: "appsheet-live-verified", sourceId: "synthetic-spreadsheet", spreadsheetId: "synthetic-spreadsheet",
      metadataHash: "a".repeat(64), headersHash: "b".repeat(64), manifestHash: captureManifestHash, dataHash: "c".repeat(64),
      definitionHash: null, stability: { stable: false }, firstReadAt: captureTime, verificationStartedAt: captureTime,
      verificationCompletedAt: captureTime, cutoffAt: captureTime, dataCoverage: {}, pageManifest: [],
      dataSheetCount: 0, dataPageCount: 0, dataRecordCount: 0, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
    } });
    const firstRealWriteAt = new Date("2026-10-01T12:00:00.000Z");
    const authorityEvidence = { reference: "synthetic preserved activation evidence" };
    await db.operationAuthority.create({ data: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement", epoch: 7,
      captureManifestId: captureId, firstRealWriteAt, approvedBy: "cutover-activator", evidence: authorityEvidence } });
    process.env.CLUB_OPERATIONS_APPROVED = "true";
    const activation = envelope("operations", "AuthorityActivated", { evidence: { reference: "synthetic rollback test" } });
    const rejectedActivation = await call("/operations/commands", "cutover-activator", activation);
    const activationBody = await rejectedActivation.json();
    assert.equal(rejectedActivation.status, 423);
    assert.equal(activationBody.code, "APPSHEET_REPLACEMENT_REQUIRED");
    assert.equal(activationBody.details?.captureId, captureId,
      "a legacy activation cannot downgrade the existing AppSheet replacement authority");
    assert.equal(await db.operationObject.findUnique({ where: { id: "operations" } }), null,
      "the rejected legacy activation must not create an authority aggregate");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: activation.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: activation.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: activation.requestId } }), 0);
    const unchangedAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(unchangedAuthority.mode, "active");
    assert.equal(unchangedAuthority.cutoverProfile, "appsheet-replacement");
    assert.equal(unchangedAuthority.epoch, 7);

    const rollbackSuspension = envelope("operations", "AuthoritySuspended", { reason: "Pausa con colisión de salida" });
    await db.$executeRawUnsafe(`ALTER TABLE "OperationAudit" ADD CONSTRAINT "cutover_test_force_audit_failure" CHECK ("action" <> 'AuthoritySuspendedReason')`);
    const failedSuspension = await call("/operations/commands", "cutover-owner", rollbackSuspension);
    assert.notEqual(failedSuspension.status, 200, "a later audit failure must reject the transaction after the authority update was attempted");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: rollbackSuspension.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: rollbackSuspension.requestId } }), 0);
    assert.equal(await db.operationObject.findUnique({ where: { id: "operations" } }), null);
    const rollbackAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(rollbackAuthority.mode, "active");
    assert.equal(rollbackAuthority.epoch, 7);
    assert.equal(rollbackAuthority.captureManifestId, captureId);
    await db.$executeRawUnsafe(`ALTER TABLE "OperationAudit" DROP CONSTRAINT "cutover_test_force_audit_failure"`);

    const nonOwnerSuspension = envelope("operations", "AuthoritySuspended", { reason: "Pausa operativa por revisión" });
    const rejectedNonOwnerSuspension = await call("/operations/commands", "cutover-admin", nonOwnerSuspension);
    assert.equal(rejectedNonOwnerSuspension.status, 403);
    assert.equal((await rejectedNonOwnerSuspension.json()).code, "OWNER_REQUIRED");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: nonOwnerSuspension.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: nonOwnerSuspension.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: nonOwnerSuspension.requestId } }), 0);
    assert.equal(await db.operationObject.findUnique({ where: { id: "operations" } }), null);

    const staleSuspension = envelope("operations", "AuthoritySuspended", { reason: "Pausa operativa por revisión" }, 3);
    const rejectedSuspension = await call("/operations/commands", "cutover-owner", staleSuspension);
    assert.equal(rejectedSuspension.status, 409);
    assert.equal((await rejectedSuspension.json()).code, "VERSION_CONFLICT");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: staleSuspension.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: staleSuspension.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: staleSuspension.requestId } }), 0);
    assert.equal(await db.operationObject.findUnique({ where: { id: "operations" } }), null,
      "a stale suspension rolls back its provisional aggregate creation");
    const activeAfterConflict = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(activeAfterConflict.mode, "active");
    assert.equal(activeAfterConflict.epoch, 7);

    const suspend = envelope("operations", "AuthoritySuspended", { reason: "Pausa operativa por revisión humana" }, 0);
    const suspendedResponse = await call("/operations/commands", "cutover-owner", suspend);
    assert.equal(suspendedResponse.status, 200, await suspendedResponse.clone().text());
    const suspendedAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(suspendedAuthority.mode, "shadow");
    assert.equal(suspendedAuthority.epoch, 8);
    assert.equal(suspendedAuthority.firstRealWriteAt?.toISOString(), firstRealWriteAt.toISOString());
    assert.equal(suspendedAuthority.cutoverProfile, "appsheet-replacement");
    assert.equal(suspendedAuthority.captureManifestId, captureId);
    assert.equal(suspendedAuthority.approvedBy, "cutover-activator");
    assert.deepEqual(suspendedAuthority.evidence, authorityEvidence);
    const suspendedRead = await call("/operations/authority", "cutover-owner");
    assert.equal((await suspendedRead.json()).versions.operations, 1, "the UI reads the incremented aggregate version for reactivation");
    const reasonAudit = await db.operationAudit.findFirst({ where: { requestId: suspend.requestId, action: "AuthoritySuspendedReason" } });
    assert.equal((reasonAudit?.details as { reason?: string } | null)?.reason, "Pausa operativa por revisión humana");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: "operations" } })).version, 1);

    const unprovenReplacementReactivation = envelope("operations", "AuthorityActivated", {
      cutoverProfile: "appsheet-replacement", captureId, evidence: { reference: "synthetic unproven replacement reactivation" },
    }, 1);
    const deniedReplacementReactivation = await call("/operations/commands", "cutover-activator", unprovenReplacementReactivation);
    assert.equal(deniedReplacementReactivation.status, 423);
    assert.equal((await deniedReplacementReactivation.json()).code, "APPSHEET_REPLACEMENT_NOT_READY");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: unprovenReplacementReactivation.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: unprovenReplacementReactivation.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: unprovenReplacementReactivation.requestId } }), 0);
    const stillShadowAndBound = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(stillShadowAndBound.mode, "shadow");
    assert.equal(stillShadowAndBound.cutoverProfile, "appsheet-replacement");
    assert.equal(stillShadowAndBound.captureManifestId, captureId);

    for (const expectedVersion of [0, 1]) {
      const legacyReactivation = envelope("operations", "AuthorityActivated", {
        cutoverProfile: "legacy", evidence: { reference: "synthetic legacy downgrade after suspension" },
      }, expectedVersion);
      const rejectedReactivation = await call("/operations/commands", "cutover-activator", legacyReactivation);
      assert.equal(rejectedReactivation.status, 423);
      const rejection = await rejectedReactivation.json();
      assert.equal(rejection.code, "APPSHEET_REPLACEMENT_REQUIRED",
        "both stale and current versions must preserve the AppSheet replacement profile");
      assert.equal(rejection.details?.captureId, captureId);
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId: legacyReactivation.requestId } }), null);
      assert.equal(await db.operationAudit.count({ where: { requestId: legacyReactivation.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: legacyReactivation.requestId } }), 0);
      assert.deepEqual(await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } }), suspendedAuthority);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: "operations" } })).version, 1);
    }
    const stillSuspendedRead = await call("/operations/authority", "cutover-owner");
    assert.equal((await stillSuspendedRead.json()).versions.operations, 1);
  } finally {
    if (priorApproval === undefined) delete process.env.CLUB_OPERATIONS_APPROVED;
    else process.env.CLUB_OPERATIONS_APPROVED = priorApproval;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
