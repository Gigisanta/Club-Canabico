import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import { legacyPayloadHash } from "../server/operations/legacy-upload-contract.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

// Owner boundary: persisted HTTP batch state, visibility and authorization across retries and cutover.
test("resumable imports preserve complete, immutable, actor-bound batches", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)); assert.match(url.pathname, /test|ci/i);
  const schema = `batch_${randomUUID().replaceAll("-", "")}`; url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = "test"; process.env.DEMO_MODE = "true";
  process.env.JWT_SECRET = "local-batch-tests-only-long-fixture-key"; process.env.ALLOWED_ORIGIN = "http://batch.test";
  const { db } = await import("../server/db.js"); await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrations = new URL("../prisma/migrations/", import.meta.url);
  for (const folder of (await readdir(migrations, { withFileTypes: true })).filter(f => f.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
    for (const sql of splitSqlStatements(await readFile(new URL(`${folder.name}/migration.sql`, migrations), "utf8"))) await db.$executeRawUnsafe(sql);
  for (const id of ["owner", "other"]) await db.user.create({ data: { id, name: id, email: `${id}@batch.test`, role: "owner", password: await bcrypt.hash("local-batch-fixture-only", 4) } });
  const { app } = await import("../server/app.js"); const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, cookies: Record<string, string> = {};
  for (const id of ["owner", "other"]) { const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { Origin: "http://batch.test", "Content-Type": "application/json" }, body: JSON.stringify({ email: `${id}@batch.test`, password: "local-batch-fixture-only" }) }); assert.equal(response.status, 200); cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!; }
  const call = (path: string, body?: unknown, actor = "owner") => fetch(base + path, { method: body ? "POST" : "GET", headers: { Cookie: cookies[actor], Origin: "http://batch.test", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope => ({ schemaVersion: 1, requestId: randomUUID(), targetId, command, data, expectedVersion, occurredAt: new Date().toISOString() });
  function fixture() {
    const targetId = `batch-${randomUUID()}`, fileHash = "a".repeat(64);
    const records = [2, 3].map(sourceRow => { const content = { sourceTable: "C_Cliente", sourceKey: `synthetic-${sourceRow}`, sourceRow, fileHash, importerVersion: "batch-fixture/1", original: { columns: [{ coordinate: `A${sourceRow}`, header: "Nombre", value: "Synthetic" }] }, normalized: { columns: [{ coordinate: `A${sourceRow}`, header: "Nombre", value: "Synthetic" }] }, treatment: "fact_candidate", exceptions: [] }; return { ...content, contentHash: legacyPayloadHash(content) }; });
    const chunks = records.map((record, index) => ({ index, contentHash: legacyPayloadHash([record]), records: [record] }));
    const manifest = { chunks: chunks.map(({ index, contentHash, records }) => ({ index, contentHash, recordCount: records.length })), recordsByTable: { C_Cliente: 2 } };
    const manifestHash = legacyPayloadHash(manifest);
    return { targetId, chunks, manifestHash, begin: envelope(targetId, "LegacyUploadBegun", { sourceSystem: `test-${randomUUID()}`, filename: "synthetic.xlsx", fileHash, importerVersion: "batch-fixture/1", manifestHash, manifest, controls: {}, coverage: [] }) };
  }
  try {
    await t.test("partial uploads stay hidden; timeout replay and finalization create each row once", async () => {
      const f = fixture(), begin = await call("/legacy-imports/batches", f.begin); assert.equal(begin.status, 201); assert.equal((await begin.json()).version, 1);
      const request = envelope(f.targetId, "LegacyUploadChunkStored", f.chunks[0]!, 1);
      const first = await call(`/legacy-imports/batches/${f.targetId}/chunks`, request); assert.equal(first.status, 200); const accepted = await first.json();
      const replay = await call(`/legacy-imports/batches/${f.targetId}/chunks`, request); assert.equal(replay.status, 200); assert.equal((await replay.json()).replay, true);
      assert.equal(await db.legacySourceRecord.count({ where: { snapshotId: f.targetId } }), 1);
      const hidden = await call(`/legacy-imports/staged-records?snapshotId=${f.targetId}`); assert.equal(hidden.status, 423); assert.equal((await hidden.json()).code, "IMPORT_INCOMPLETE");
      const coverage = await call("/legacy-imports/coverage", undefined, "other"); assert.equal(coverage.status, 200); assert.equal((await coverage.json()).items.some((row: { id: string }) => row.id === f.targetId), false);
      const early = await call(`/legacy-imports/batches/${f.targetId}/finalize`, envelope(f.targetId, "LegacyUploadFinalized", { manifestHash: f.manifestHash }, accepted.version)); assert.equal(early.status, 409);
      const tampered = await call(`/legacy-imports/batches/${f.targetId}/chunks`, { ...request, data: { ...request.data, contentHash: "b".repeat(64) } }); assert.equal(tampered.status, 409); assert.equal((await tampered.json()).code, "IDEMPOTENCY_KEY_REUSED");
      const other = await call(`/legacy-imports/batches/${f.targetId}/chunks`, request, "other"); assert.equal(other.status, 403);
      const invalid = structuredClone(f.chunks[1]!); invalid.records[0]!.normalized.columns[0]!.value = "Changed after hashing";
      const bad = await call(`/legacy-imports/batches/${f.targetId}/chunks`, envelope(f.targetId, "LegacyUploadChunkStored", invalid, accepted.version)); assert.equal(bad.status, 409);
      const second = await call(`/legacy-imports/batches/${f.targetId}/chunks`, envelope(f.targetId, "LegacyUploadChunkStored", f.chunks[1]!, accepted.version)); assert.equal(second.status, 200); const version = (await second.json()).version;
      const seal = envelope(f.targetId, "LegacyUploadFinalized", { manifestHash: f.manifestHash }, version);
      const finished = await call(`/legacy-imports/batches/${f.targetId}/finalize`, seal); assert.equal(finished.status, 200); assert.equal((await finished.json()).result.status, "staged");
      assert.equal((await call(`/legacy-imports/batches/${f.targetId}/finalize`, seal)).status, 200);
      const visible = await call(`/legacy-imports/staged-records?snapshotId=${f.targetId}`); assert.equal(visible.status, 200); assert.equal((await visible.json()).items.length, 2);
      assert.equal(await db.legacySourceRecord.count({ where: { snapshotId: f.targetId } }), 2);
    });
    await t.test("finalization preserves declared empty tables",async()=>{
      const f=fixture();const manifest={...(f.begin.data.manifest as object),recordsByTable:{C_Cliente:2,EmptySheet:0}};f.begin.data.manifest=manifest;f.begin.data.manifestHash=legacyPayloadHash(manifest);
      assert.equal((await call("/legacy-imports/batches",f.begin)).status,201);let version=1;
      for(const chunk of f.chunks){const response=await call(`/legacy-imports/batches/${f.targetId}/chunks`,envelope(f.targetId,"LegacyUploadChunkStored",chunk,version));assert.equal(response.status,200);version=(await response.json()).version;}
      const finalized=await call(`/legacy-imports/batches/${f.targetId}/finalize`,envelope(f.targetId,"LegacyUploadFinalized",{manifestHash:legacyPayloadHash(manifest)},version));assert.equal(finalized.status,200);assert.equal((await finalized.json()).result.status,"staged");
    });
    await t.test("duplicate source coordinates are rejected without persisting the conflicting chunk",async()=>{
      const f=fixture();f.chunks[1]!.records=[f.chunks[0]!.records[0]!];f.chunks[1]!.contentHash=legacyPayloadHash(f.chunks[1]!.records);
      const manifest={chunks:f.chunks.map(({index,contentHash,records})=>({index,contentHash,recordCount:records.length})),recordsByTable:{C_Cliente:2}};
      f.begin.data.manifest=manifest;f.begin.data.manifestHash=legacyPayloadHash(manifest);
      assert.equal((await call("/legacy-imports/batches",f.begin)).status,201);
      const first=await call(`/legacy-imports/batches/${f.targetId}/chunks`,envelope(f.targetId,"LegacyUploadChunkStored",f.chunks[0]!,1));assert.equal(first.status,200);
      const duplicate=await call(`/legacy-imports/batches/${f.targetId}/chunks`,envelope(f.targetId,"LegacyUploadChunkStored",f.chunks[1]!,2));assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).code,"IMPORT_COORDINATE_REUSED");
      assert.equal(await db.legacySourceRecord.count({where:{snapshotId:f.targetId}}),1);assert.equal(await db.legacyImportChunk.count({where:{snapshotId:f.targetId}}),1);
    });
    await t.test("actual UTF-8 request bytes bound each chunk and the cumulative upload",async()=>{
      const f=fixture();assert.equal((await call("/legacy-imports/batches",f.begin)).status,201);
      const request=envelope(f.targetId,"LegacyUploadChunkStored",f.chunks[0]!,1),oversized=" ".repeat(512*1024)+JSON.stringify(request);
      const rejected=await fetch(base+`/legacy-imports/batches/${f.targetId}/chunks`,{method:"POST",headers:{Cookie:cookies.owner!,Origin:"http://batch.test","Content-Type":"application/json"},body:oversized});assert.equal(rejected.status,413);assert.equal(await db.legacyImportChunk.count({where:{snapshotId:f.targetId}}),0);
      const padded=" ".repeat(4096)+JSON.stringify(request);
      const accepted=await fetch(base+`/legacy-imports/batches/${f.targetId}/chunks`,{method:"POST",headers:{Cookie:cookies.owner!,Origin:"http://batch.test","Content-Type":"application/json"},body:padded});assert.equal(accepted.status,200);
      assert.equal((await db.legacyImportUpload.findUniqueOrThrow({where:{snapshotId:f.targetId}})).receivedBytes,BigInt(Buffer.byteLength(padded)));
      await db.legacyImportUpload.update({where:{snapshotId:f.targetId},data:{receivedBytes:BigInt(128*1024*1024)}});
      const overTotal=await call(`/legacy-imports/batches/${f.targetId}/chunks`,envelope(f.targetId,"LegacyUploadChunkStored",f.chunks[1]!,2));assert.equal(overTotal.status,413);assert.equal((await overTotal.json()).code,"IMPORT_BATCH_LIMIT");assert.equal(await db.legacyImportChunk.count({where:{snapshotId:f.targetId}}),1);
    });
    await t.test("ordinary values under nested credential keys never reach persisted staging",async()=>{
      const f=fixture();f.begin.data.controls={nested:{password:"ordinary synthetic phrase"}};
      const rejected=await call("/legacy-imports/batches",f.begin);assert.equal(rejected.status,400);assert.equal(await db.legacyImportSnapshot.count({where:{id:f.targetId}}),0);
      const safe=fixture();assert.equal((await call("/legacy-imports/batches",safe.begin)).status,201);
      const record=safe.chunks[0]!.records[0]!;record.original.columns[0]!.value={token:"ordinary synthetic phrase"} as unknown as string;
      const {contentHash:_,...content}=record;record.contentHash=legacyPayloadHash(content);safe.chunks[0]!.contentHash=legacyPayloadHash(safe.chunks[0]!.records);
      const rowRejected=await call(`/legacy-imports/batches/${safe.targetId}/chunks`,envelope(safe.targetId,"LegacyUploadChunkStored",safe.chunks[0]!,1));assert.equal(rowRejected.status,422);assert.equal((await rowRejected.json()).code,"IMPORT_CREDENTIAL_VALUE_REJECTED");assert.equal(await db.legacySourceRecord.count({where:{snapshotId:safe.targetId}}),0);
    });
    await t.test("a changed authority quarantines the whole incomplete batch", async () => {
      const f = fixture(); assert.equal((await call("/legacy-imports/batches", f.begin)).status, 201);
      await db.operationAuthority.upsert({ where: { id: "operations" }, create: { id: "operations", mode: "active", epoch: 2 }, update: { mode: "active", epoch: 2 } });
      const result = await call(`/legacy-imports/batches/${f.targetId}/chunks`, envelope(f.targetId, "LegacyUploadChunkStored", f.chunks[0]!, 1)); assert.equal(result.status, 200); assert.equal((await result.json()).result.status, "quarantined");
      assert.equal(await db.legacySourceRecord.count({ where: { snapshotId: f.targetId } }), 0);
      assert.equal((await call(`/legacy-imports/staged-records?snapshotId=${f.targetId}`)).status, 423);
      assert.equal((await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: f.targetId } })).status, "quarantined");
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect(); }
});
