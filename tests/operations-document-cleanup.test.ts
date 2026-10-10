import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";

test("concurrent transport replay retains the winning PDF and reaps only stale unreferenced exact versions", { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname));
  assert.match(databaseUrl.pathname, /test|ci/i);
  const schema = `document_assets_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);

  const putBodies = new Map<string, Buffer>();
  const puts: Array<{ key: string; version: string }> = [];
  const deletes: Array<{ key: string; version: string | null }> = [];
  let putGateRelease!: () => void;
  const putGate = new Promise<void>(resolve => { putGateRelease = resolve; });
  let bothPutsArrived!: () => void;
  const bothPuts = new Promise<void>(resolve => { bothPutsArrived = resolve; });
  let putCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/");
      if (request.method === "GET" && url.searchParams.has("versioning")) {
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>');
        return;
      }
      if (request.method === "PUT") {
        const version = `synthetic-version-${++putCount}`;
        puts.push({ key, version });
        putBodies.set(`${key}\u0000${version}`, body);
        if (putCount === 2) bothPutsArrived();
        await putGate;
        response.writeHead(200, { "x-amz-version-id": version, ETag: '"synthetic-etag"' });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        deletes.push({ key, version: url.searchParams.get("versionId") });
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const version = url.searchParams.get("versionId") ?? "";
        const bytes = putBodies.get(`${key}\u0000${version}`);
        if (!bytes) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "Content-Length": String(bytes.length), "x-amz-version-id": version });
        response.end(bytes);
        return;
      }
      response.writeHead(500);
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.NODE_ENV = "test";
  process.env.DEMO_MODE = "true";
  process.env.JWT_SECRET = "document-cleanup-only-test-signing-key-longer-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://document-cleanup.local";
  process.env.PRIVATE_OBJECT_PROVIDER = "s3";
  process.env.PRIVATE_S3_BUCKET = "synthetic-private-bucket";
  process.env.PRIVATE_S3_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.PRIVATE_S3_PATH_STYLE = "true";
  process.env.PRIVATE_S3_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "synthetic-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "synthetic-secret-key";
  process.env.AWS_EC2_METADATA_DISABLED = "true";

  let db: PrismaClient | undefined;
  let appServer: Server | undefined;
  let databaseCreated = false;
  try {
    ({ db } = await import("../server/db.js"));
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    databaseCreated = true;
    const migrations = new URL("../prisma/migrations/", import.meta.url);
    for (const folder of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = await readFile(new URL(`${folder.name}/migration.sql`, migrations), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    await db.user.create({ data: { id: "asset-owner", name: "Asset test owner", email: "asset-owner@test.local", password: await bcrypt.hash("Document-cleanup-test-password", 4), role: "owner" } });
    await db.operationMember.create({ data: { id: "asset-member", name: "Synthetic member", address: {}, preferences: {} } });
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
    const future = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    const deliveryId = randomUUID();
    await db.memberPermission.create({ data: { memberId: "asset-member", kind: "operations", status: "verified", validFrom: today, validUntil: future } });
    await db.operationOrder.create({ data: { id: "asset-order", memberId: "asset-member", channel: "delivery", currency: "ARS", quote: {}, address: {}, createdBy: "asset-owner" } });
    await db.deliveryAssignment.create({ data: { id: deliveryId, orderId: "asset-order", driverId: "asset-driver", address: {}, incidents: {} } });
    await db.documentTemplate.create({ data: { id: "asset-template", version: 1, kind: "transport", definition: { title: "Synthetic transport", requiredFields: ["memberName", "driverId", "physicalItems"] }, approvedAt: now, approvedBy: "asset-owner" } });
    await db.catalogSku.create({ data: { id: "asset-sku", code: "ASSET-1", name: "Synthetic material", variety: "Synthetic", category: "Test", unit: "g" } });
    await db.inventoryLot.create({ data: { id: "asset-lot", skuId: "asset-sku", label: "Synthetic lot", unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: now } });
    await db.preparationAllocation.create({ data: { id: "asset-allocation", orderId: "asset-order", lineId: "asset-line", lotId: "asset-lot", balanceId: "asset-balance", requestedQuantity: "1", actualQuantity: "1", costMinor: 1n, state: "prepared" } });

    const { executeCommand } = await import("../server/operations/core.js");
    await import("../server/operations/documents.js");
    const { processOperationOutbox } = await import("../server/operations/outbox.js");
    const actor = await db.user.findUniqueOrThrow({ where: { id: "asset-owner" } });
    const targetId = randomUUID(), requestId = randomUUID();
    const request = {
      schemaVersion: 1 as const,
      requestId,
      targetId,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
      command: "TransportDocumentGenerated",
      data: {
        orderId: "asset-order",
        deliveryId,
        templateId: "asset-template",
        transportistName: "Synthetic driver",
        vehiclePlate: "FIXTURE",
        origin: "Synthetic origin",
        destination: "Synthetic destination",
        evidence: { reference: "local-document-cleanup-test" },
      },
    };
    const executions = [executeCommand(actor, request), executeCommand(actor, request)];
    await bothPuts;
    const preparing = await db.operationOutbox.findMany({ where: { topic: "document.asset-intent", requestId } });
    assert.equal(preparing.length, 2, "each concurrent upload has a durable intent before the object store accepts either PDF");
    assert.ok(preparing.every(row => row.status === "asset-preparing"));
    const preparedKeys = preparing.map(row => (row.payload as { key: string }).key);
    assert.equal(new Set(preparedKeys).size, 2, "each intent owns a distinct private key");
    putGateRelease();
    const results = await Promise.all(executions);
    assert.equal(results.filter(result => "replay" in result && result.replay).length, 1, "the losing concurrent request replays the winning receipt");

    const document = await db.operationDocument.findUniqueOrThrow({ where: { id: targetId } });
    assert.equal(document.state, "available");
    assert.ok(document.objectKey && document.objectVersion && document.checksum && document.bytes);
    const winnerBytes = putBodies.get(`${document.objectKey}\u0000${document.objectVersion}`);
    assert.ok(winnerBytes);
    assert.equal(winnerBytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(createHash("sha256").update(winnerBytes).digest("hex"), document.checksum);

    const intents = await db.operationOutbox.findMany({ where: { topic: "document.asset-intent", requestId } });
    const losingIntent = intents.find(row => row.status === "asset-ready");
    assert.ok(losingIntent);
    assert.equal(intents.filter(row => row.status === "processed" && (row.payload as { key?: string }).key === document.objectKey).length, 1);
    await db.$executeRaw`UPDATE "OperationOutbox" SET "createdAt"=CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id"=${losingIntent.id}::uuid`;

    const referencedRequest = randomUUID(), referencedIntentId = randomUUID();
    await db.operationOutbox.create({ data: {
      id: referencedIntentId, requestId: referencedRequest, topic: "document.asset-intent", status: "asset-ready",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      payload: { version: 1, requestId: referencedRequest, documentId: targetId, key: document.objectKey, checksum: document.checksum, bytes: document.bytes, mediaType: "application/pdf", sourceHash: "a".repeat(64), stored: { key: document.objectKey, version: document.objectVersion, checksum: document.checksum, bytes: document.bytes, mediaType: "application/pdf" } },
    } });

    const unknownDocumentId = randomUUID(), unknownKey = `documents/${unknownDocumentId}/${randomUUID()}`;
    const unknownBody = Buffer.from("%PDF-1.4\nunknown S3 version fixture");
    const unknownChecksum = createHash("sha256").update(unknownBody).digest("hex");
    const { putPrivateObject, getPrivateObject } = await import("../server/operations/object-store.js");
    const unknownObject = await putPrivateObject(unknownKey, unknownBody, "application/pdf");
    const unknownRequest = randomUUID(), unknownIntentId = randomUUID();
    await db.operationOutbox.create({ data: {
      id: unknownIntentId, requestId: unknownRequest, topic: "document.asset-intent", status: "asset-preparing",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      payload: { version: 1, requestId: unknownRequest, documentId: unknownDocumentId, key: unknownKey, checksum: unknownChecksum, bytes: unknownBody.length, mediaType: "application/pdf", sourceHash: "b".repeat(64) },
    } });
    await db.$executeRaw`UPDATE "OperationOutbox" SET "createdAt"=CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" IN (${referencedIntentId}::uuid, ${unknownIntentId}::uuid)`;
    const staleRows = await db.$queryRaw<Array<{ id: string; status: string; createdAt: Date }>>`SELECT "id","status","createdAt" FROM "OperationOutbox" WHERE "topic"='document.asset-intent' AND "status" IN ('asset-preparing','asset-ready') AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 hour'`;
    assert.ok(staleRows.some(row => row.id === losingIntent.id), JSON.stringify(staleRows.map(row => ({ id: row.id, status: row.status, createdAt: row.createdAt.toISOString() }))));

    const processedEvents = await processOperationOutbox(10);
    assert.equal(processedEvents, 1, "the regular outbox maintenance call also runs bounded asset cleanup after its transaction");
    const finalLosingIntent = await db.operationOutbox.findUniqueOrThrow({ where: { id: losingIntent.id } });
    assert.equal(finalLosingIntent.status, "processed");
    const finalReferenced = await db.operationOutbox.findFirstOrThrow({ where: { topic: "document.asset-intent", requestId: referencedRequest } });
    assert.equal(finalReferenced.status, "processed");
    assert.equal(deletes.length, 1, "only the unreferenced PDF was deleted");
    assert.deepEqual(deletes[0], { key: (losingIntent.payload as { key: string }).key, version: (losingIntent.payload as { stored: { version: string } }).stored.version });
    const finalUnknown = await db.operationOutbox.findUniqueOrThrow({ where: { id: unknownIntentId } });
    assert.equal(finalUnknown.status, "review", "an unknown S3 version remains durably reviewable");
    assert.equal((finalUnknown.payload as { reviewReason: string }).reviewReason, "OBJECT_VERSION_UNKNOWN");
    assert.deepEqual(await getPrivateObject(unknownObject.key, unknownObject.version, unknownObject.checksum), unknownBody, "unknown-version cleanup does not guess at an object to delete");
    assert.equal((await db.operationDocument.findUniqueOrThrow({ where: { id: targetId } })).objectVersion, document.objectVersion, "the winning canonical PDF remains referenced");

    // Manual uploads use the mounted HTTP route, including authentication and the
    // upload/availability split. A valid image abandoned here must be reapable.
    const { app } = await import("../server/app.js");
    appServer = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => appServer!.once("listening", resolve));
    const base = `http://127.0.0.1:${(appServer.address() as { port: number }).port}/api`;
    const origin = "http://document-cleanup.local";
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: actor.email, password: "Document-cleanup-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
    const manualId = randomUUID();
    const reference = await executeCommand(actor, { schemaVersion: 1, requestId: randomUUID(), targetId: manualId, expectedVersion: 0, occurredAt: new Date().toISOString(), command: "DocumentReferenced", data: { kind: "manual-fixture", sensitivity: "commercial" } });
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("synthetic-upload-content")]);
    const checksum = createHash("sha256").update(png).digest("hex");
    async function uploadImage() {
      const response = await fetch(`${base}/operations/documents/${manualId}/upload`, { method: "POST", headers, body: JSON.stringify({ contentBase64: png.toString("base64"), mediaType: "image/png", checksum }) });
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { key: string; version: string; checksum: string; bytes: number; mediaType: string };
    }
    const abandoned = await uploadImage();
    const abandonedIntent = await db.operationOutbox.findFirst({ where: { topic: "document.asset-intent", payload: { path: ["key"], equals: abandoned.key } } });
    assert.ok(abandonedIntent, "a successful manual upload must leave a durable cleanup intent even if availability is never confirmed");
    const retained = await uploadImage();
    const available = await fetch(`${base}/operations/commands`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), targetId: manualId, expectedVersion: reference.version, occurredAt: new Date().toISOString(), command: "DocumentMadeAvailable", data: retained }) });
    assert.equal(available.status, 200, await available.clone().text());
    await db.$executeRaw`UPDATE "OperationOutbox" SET "createdAt"=CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "topic"='document.asset-intent' AND "payload"->>'documentId'=${manualId}`;
    const deletedBefore = deletes.length;
    await processOperationOutbox(10);
    assert.deepEqual(deletes.slice(deletedBefore), [{ key: abandoned.key, version: abandoned.version }], "cleanup covers images uploaded manually and preserves the referenced exact version");
    const content = await fetch(`${base}/operations/documents/${manualId}/content`, { headers });
    assert.equal(content.status, 200);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
    assert.equal((await db.operationOutbox.findFirstOrThrow({ where: { topic: "document.asset-intent", payload: { path: ["key"], equals: retained.key } } })).status, "processed");
  } finally {
    putGateRelease();
    if (appServer) await new Promise<void>(resolve => appServer!.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (db) {
      if (databaseCreated) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.$disconnect();
    }
  }
});
