import test from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("offline recovery binds the recipient at request and approval and releases its key only once", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /test|ci/i);
  const schema = "recovery_" + randomUUID().replaceAll("-", "");
  url.searchParams.set("schema", schema);

  const escrow = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const alternateRecipient = generateKeyPairSync("rsa", { modulusLength: 3072 });
  process.env.DATABASE_URL = url.toString();
  process.env.DEMO_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "offline-recovery-test-secret-more-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://recovery.test";
  process.env.OFFLINE_QUEUE_RECOVERY_PUBLIC_KEY = escrow.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.OFFLINE_QUEUE_RECOVERY_PRIVATE_KEY = escrow.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
  const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
  for (const folder of (await readdir(migrationRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = await readFile(new URL(folder.name + "/migration.sql", migrationRoot), "utf8");
    for (const statement of splitSqlStatements(source)) await db.$executeRawUnsafe(statement);
  }

  const password = await bcrypt.hash("Only-a-local-recovery-test-123", 4);
  await db.user.createMany({ data: [
    { id: "owner", name: "Recovery owner", email: "owner@recovery.test", password, role: "owner" },
    { id: "finance", name: "Recovery reviewer", email: "finance@recovery.test", password, role: "admin" },
  ] });
  const { profileCapabilities } = await import("../shared/operations/contracts.js");
  await db.operationAccess.create({ data: { userId: "finance", profile: "finance", capabilities: profileCapabilities.finance } });
  const queueKey = randomBytes(32);
  const backupId = randomUUID();
  const recoveryId = randomUUID();
  const wrappedForEscrow = publicEncrypt({
    key: escrow.publicKey,
    oaepHash: "sha256",
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, queueKey).toString("base64");
  await db.offlineBackup.create({ data: {
    id: backupId,
    userId: "owner",
    deviceId: randomUUID(),
    leaseId: randomUUID(),
    sha256: createHash("sha256").update("synthetic encrypted offline backup").digest("hex"),
    package: { schemaVersion: 1, keyring: { queueRecoveryWrappedKey: wrappedForEscrow } },
  } });

  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api";
  const cookies: Record<string, string> = {};
  const call = (path: string, actor: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookies[actor] ?? "", Origin: "http://recovery.test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function login(id: string) {
    const response = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: "http://recovery.test", "Content-Type": "application/json" },
      body: JSON.stringify({ email: id + "@recovery.test", password: "Only-a-local-recovery-test-123" }),
    });
    assert.equal(response.status, 200);
    cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function envelope(targetId: string, command: string, data: Record<string, unknown>): Promise<CommandEnvelope> {
    return {
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion: (await db.operationObject.findUnique({ where: { id: targetId } }))?.version ?? 0,
      occurredAt: new Date().toISOString(),
    };
  }
  async function sendCommand(targetId: string, name: string, data: Record<string, unknown>, actor: string) {
    const response = await call("/operations/commands", actor, await envelope(targetId, name, data));
    return { response, body: await response.json() as Record<string, unknown> };
  }

  try {
    await login("owner");
    await login("finance");
    const recipientPublicKey = recipient.publicKey.export({ type: "spki", format: "pem" }).toString();
    const alternatePublicKey = alternateRecipient.publicKey.export({ type: "spki", format: "pem" }).toString();
    const recipientFingerprint = createHash("sha256").update(recipient.publicKey.export({ type: "spki", format: "der" })).digest("hex");

    const requested = await sendCommand(recoveryId, "QueueRecoveryRequested", {
      backupId,
      reason: "Restore a synthetic offline queue",
      recipientPublicKey,
      evidence: { reference: "synthetic recovery fixture" },
    }, "owner");
    assert.equal(requested.response.status, 200, JSON.stringify(requested.body));

    const mismatch = await sendCommand(recoveryId, "QueueRecoveryApproved", {
      recipientKeyFingerprint: createHash("sha256").update(alternateRecipient.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
      evidence: { reference: "reviewed a different recipient" },
    }, "finance");
    assert.equal(mismatch.response.status, 422);
    assert.equal((mismatch.body as { code: string }).code, "RECOVERY_RECIPIENT_MISMATCH");
    assert.equal((await db.offlineRecovery.findUniqueOrThrow({ where: { id: recoveryId } })).status, "requested");

    const approved = await sendCommand(recoveryId, "QueueRecoveryApproved", {
      recipientKeyFingerprint: recipientFingerprint,
      evidence: { reference: "reviewed the fixed recipient fingerprint" },
    }, "finance");
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));

    const endpoint = "/delivery/recoveries/" + recoveryId + "/key";
    const replacementAttempt = await call(endpoint, "owner", { recipientPublicKey: alternatePublicKey });
    assert.equal(replacementAttempt.status, 400);
    assert.equal((await db.offlineRecovery.findUniqueOrThrow({ where: { id: recoveryId } })).status, "approved");

    const [first, second] = await Promise.all([call(endpoint, "owner", {}), call(endpoint, "owner", {})]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const delivered = await (first.status === 200 ? first : second).json() as { wrappedQueueKey: string; recipientKeyFingerprint: string };
    assert.equal(delivered.recipientKeyFingerprint, recipientFingerprint);
    const recoveredKey = privateDecrypt({
      key: recipient.privateKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    }, Buffer.from(delivered.wrappedQueueKey, "base64"));
    assert.deepEqual(recoveredKey, queueKey);
    recoveredKey.fill(0);
    assert.equal((await db.offlineRecovery.findUniqueOrThrow({ where: { id: recoveryId } })).status, "released");
    assert.equal(await db.operationAudit.count({ where: { objectId: recoveryId, action: "queue.key_recovered" } }), 1);
    assert.equal((await call(endpoint, "owner", {})).status, 409);
  } finally {
    queueKey.fill(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$executeRawUnsafe('DROP SCHEMA "' + schema + '" CASCADE');
    await db.$disconnect();
  }
});
