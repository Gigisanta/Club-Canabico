import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

const technicalSources = [
  "appsheet-business-archive",
  "appsheet-finance-observations",
] as const;
const blockedCode = "LEGACY_TECHNICAL_SOURCE_BLOCKED";
const testPassword = "Only-a-local-technical-source-123";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));

type FixtureRow = {
  id: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  contentHash: string;
  fileHash: string;
  importerVersion: string;
  treatment: string;
};

test("technical AppSheet source identities cannot become canonical history, while generic archive rows remain projectable", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async t => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL must use loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a disposable bombo_ui_* database");

  const schema = "technical_source_" + randomUUID().replaceAll("-", "");
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "true",
    JWT_SECRET: "technical-source-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://technical-source.test",
  });

  let db: (typeof import("../server/db.js"))["db"] | undefined;
  let server: import("node:http").Server | undefined;
  let schemaCreated = false;
  try {
    ({ db } = await import("../server/db.js"));
    await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;

    const [{ versionNumber }] = await db.$queryRaw<Array<{ versionNumber: number }>>`
      SELECT current_setting('server_version_num')::integer AS "versionNumber"`;
    assert.ok(versionNumber >= 180000 && versionNumber < 190000, `the isolated source-guard test requires PostgreSQL 18, got ${versionNumber}`);

    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(migration.name + "/migration.sql", migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const suffix = randomUUID();
    const ownerId = "technical-owner-" + suffix;
    const reviewerId = "technical-reviewer-" + suffix;
    const importerId = "technical-importer-" + suffix;
    const password = await bcrypt.hash(testPassword, 4);
    for (const [id, role] of [[ownerId, "owner"], [reviewerId, "admin"], [importerId, "admin"]] as const) {
      await db.user.create({ data: { id, name: id, email: id + "@technical-source.test", password, role } });
    }
    await db.operationAccess.create({
      data: { userId: reviewerId, profile: "finance", capabilities: ["imports.review"] },
    });
    await db.operationAccess.create({
      data: { userId: importerId, profile: "finance", capabilities: ["imports.write"] },
    });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port + "/api";
    const origin = "http://technical-source.test";
    const cookies: Record<string, string> = {};

    async function login(id: string) {
      const response = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: id + "@technical-source.test", password: testPassword }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function call(path: string, actor = ownerId, body?: unknown) {
      return fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookies[actor] ?? "",
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    function envelope(targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope {
      return {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId,
        command,
        data,
        expectedVersion,
        occurredAt: new Date().toISOString(),
      };
    }

    async function createApprovedMapping(mappingId: string, proposedBy: string) {
      await db!.operationalConfiguration.create({
        data: {
          id: mappingId,
          name: mappingId,
          kind: "legacy_history_mapping",
          version: 1,
          state: "approved",
          definition: {
            tables: ["C_Mercaderia", "SyntheticArchiveFixture"].map(table => ({
              table,
              kind: "archive",
              dateField: null,
              amountField: null,
              quantityField: null,
              currencyField: null,
              unitField: null,
              defaultCurrency: null,
              defaultUnit: null,
            })),
            evidence: { note: "synthetic owner-approved historical mapping" },
          },
          validFrom: "2026-01-01",
          proposedBy,
          approvedBy: ownerId,
          approvedAt: new Date(),
        },
      });
    }

    async function createSnapshot(
      sourceSystem: string,
      mappingId: string,
      label: string,
      rowDefinitions: Array<{ table: string; key: string; row: number; treatment?: string }>,
      options: { status?: "staged" | "reviewed"; factIndexes?: number[] } = {},
    ) {
      const snapshotId = "technical-fixture-" + label + "-" + randomUUID();
      const fileHash = hash(snapshotId + "\0file");
      const importerVersion = "synthetic-fixture/" + randomUUID();
      const status = options.status ?? "reviewed";
      const snapshot = await db!.legacyImportSnapshot.create({
        data: {
          id: snapshotId,
          sourceSystem,
          filename: "synthetic-fixture.xlsx",
          fileHash,
          importerVersion,
          status,
          createdBy: importerId,
          reviewedBy: status === "reviewed" ? reviewerId : null,
          reviewedAt: status === "reviewed" ? new Date() : null,
          controls: {
            originSourceSystem: "synthetic-generic-source",
            sourceClass: "ordinary-business-data",
            requiresChangedContentReview: false,
          },
          coverage: [{ name: "SyntheticArchiveFixture", role: "archive_only" }],
        },
      });
      await db!.operationObject.create({ data: { id: snapshotId, kind: "legacyImport", version: 4, createdBy: importerId } });

      const rows: FixtureRow[] = [];
      for (const definition of rowDefinitions) {
        const id = hash(`${snapshotId}\0${definition.table}\0${definition.row}`);
        const contentHash = hash(`${id}\0content`);
        rows.push(await db!.legacySourceRecord.create({
          data: {
            id,
            snapshotId,
            sourceTable: definition.table,
            sourceKey: definition.key,
            sourceRow: definition.row,
            fileHash,
            contentHash,
            importerVersion,
            original: { columns: [] },
            normalized: { columns: [{ header: "Reference", value: definition.key }] },
            treatment: definition.treatment ?? "fact_candidate",
          },
        }) as FixtureRow);
      }

      for (const index of options.factIndexes ?? []) {
        const row = rows[index]!;
        await db!.legacyHistoricalFact.create({
          data: {
            id: "fact-" + row.id,
            snapshotId,
            sourceRecordId: row.id,
            sourceTable: row.sourceTable,
            sourceKey: row.sourceKey,
            sourceRow: row.sourceRow,
            sourceHash: row.contentHash,
            mappingId,
            kind: "archive",
            occurredOn: null,
            dateState: "absent",
            currency: null,
            currencyState: "absent",
            unit: null,
            unitState: "absent",
            amountMinor: null,
            amountState: "absent",
            quantity: null,
            quantityState: "absent",
            attributes: { sourceTreatment: row.treatment, financialEffect: "history-only" },
            createdBy: importerId,
          },
        });
      }
      return { snapshot, snapshotId, fileHash, mappingId, rows };
    }

    async function createPublication(snapshotId: string, sourceSystem: string, fileHash: string, mappingId: string) {
      return db!.legacyHistoryPublication.create({
        data: {
          sourceSystem,
          snapshotId,
          fileHash,
          mappingId,
          fingerprint: hash(snapshotId + "\0preexisting-publication"),
          publishedBy: ownerId,
          evidence: { note: "synthetic preexisting publication" },
        },
      });
    }

    async function observableState(snapshotId: string, sourceSystem: string, requestId?: string, masterCode?: string) {
      const [snapshot, upload, chunks, records, exceptions, facts, publication, identities, skus, object, receipts, audits, outbox, mapping] = await Promise.all([
        db!.legacyImportSnapshot.findUnique({ where: { id: snapshotId } }),
        db!.legacyImportUpload.findUnique({ where: { snapshotId } }),
        db!.legacyImportChunk.findMany({ where: { snapshotId }, orderBy: { index: "asc" } }),
        db!.legacySourceRecord.findMany({ where: { snapshotId }, orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }] }),
        db!.legacyException.findMany({ where: { snapshotId }, orderBy: { id: "asc" } }),
        db!.legacyHistoricalFact.findMany({ where: { snapshotId }, orderBy: { id: "asc" } }),
        db!.legacyHistoryPublication.findUnique({ where: { sourceSystem } }),
        db!.legacyIdentity.findMany({ where: { sourceSystem }, orderBy: { id: "asc" } }),
        masterCode ? db!.catalogSku.findMany({ where: { OR: [{ sourceSystem }, { code: masterCode }] }, orderBy: { id: "asc" } }) : Promise.resolve([]),
        db!.operationObject.findUnique({ where: { id: snapshotId } }),
        db!.commandReceipt.findMany({ where: { targetId: snapshotId }, orderBy: { requestId: "asc" } }),
        db!.operationAudit.findMany({ where: { objectId: snapshotId }, orderBy: { id: "asc" } }),
        requestId ? db!.operationOutbox.findMany({ where: { requestId }, orderBy: { id: "asc" } }) : Promise.resolve([]),
        db!.operationalConfiguration.findUnique({ where: { id: snapshotId } }),
      ]);
      return plain({ snapshot, upload, chunks, records, exceptions, facts, publication, identities, skus, object, receipts, audits, outbox, mapping });
    }

    async function assertRejectedWithoutEffects(
      responsePromise: Promise<Response>,
      before: unknown,
      readAfter: () => Promise<unknown>,
      label: string,
    ) {
      const response = await responsePromise;
      const body = await response.json() as { code?: string };
      const after = await readAfter();
      assert.deepEqual(after, before, `${label} must leave persisted state unchanged`);
      assert.equal(response.status, 423, `${label}: ${JSON.stringify(body)}`);
      assert.equal(body.code, blockedCode);
    }

    for (const id of [ownerId, reviewerId, importerId]) await login(id);

    for (const sourceSystem of technicalSources) {
      const mappingId = "technical-mapping-" + sourceSystem + "-" + suffix;
      await createApprovedMapping(mappingId, ownerId);
      const sourceKey = "catalog-key-" + sourceSystem + "-" + suffix;

      const review = await createSnapshot(sourceSystem, mappingId, "review", [], { status: "staged" });
      const activation = await createSnapshot(sourceSystem, mappingId, "activation", [
        { table: "C_Mercaderia", key: sourceKey, row: 2 },
      ]);
      const projection = await createSnapshot(sourceSystem, mappingId, "projection", [
        { table: "C_Mercaderia", key: sourceKey + "-existing", row: 2 },
        { table: "C_Mercaderia", key: sourceKey + "-missing", row: 3 },
      ], { factIndexes: [0] });
      const publication = await createSnapshot(sourceSystem, mappingId, "publication", [
        { table: "C_Mercaderia", key: sourceKey + "-published", row: 2 },
      ], { factIndexes: [0] });
      const correction = await createSnapshot(sourceSystem, mappingId, "correction", [
        { table: "C_Mercaderia", key: sourceKey + "-corrected", row: 2 },
      ], { factIndexes: [0] });
      const correctionFactId = "fact-" + correction.rows[0]!.id;
      const masterCode = "TECHNICAL-GUARD-" + suffix;

      await t.test(`${sourceSystem} blocks independent review by source identity`, async () => {
        const requestId = randomUUID();
        const before = await observableState(review.snapshotId, sourceSystem, requestId);
        await assertRejectedWithoutEffects(
          call(`/legacy-imports/${review.snapshotId}/review`, reviewerId, {
            requestId,
            fileHash: review.fileHash,
            changedContentReviewed: false,
            evidence: { note: "synthetic independent review attempt" },
          }),
          before,
          () => observableState(review.snapshotId, sourceSystem, requestId),
          "technical snapshot review",
        );
      });

      await t.test(`${sourceSystem} blocks master activation after a distinct review`, async () => {
        const requestId = randomUUID();
        const before = await observableState(activation.snapshotId, sourceSystem, requestId, masterCode);
        await assertRejectedWithoutEffects(
          call(`/legacy-imports/${activation.snapshotId}/activate-master`, ownerId, {
            requestId,
            snapshotId: activation.snapshotId,
            sourceRecordId: activation.rows[0]!.id,
            destinationType: "sku",
            approvedData: {
              code: masterCode,
              name: "Synthetic technical-source SKU",
              variety: "Synthetic",
              category: "Fixture",
              unit: "g",
              minQuantity: "0",
              minVarieties: 0,
              active: true,
            },
            evidence: { note: "synthetic independent master activation attempt" },
          }),
          before,
          () => observableState(activation.snapshotId, sourceSystem, requestId, masterCode),
          "technical source master activation",
        );
      });

      await t.test(`${sourceSystem} blocks history projection even when a row is manipulated as a fact candidate`, async () => {
        const request = envelope(projection.snapshotId, "LegacyHistoryProjected", {
          fileHash: projection.fileHash,
          mappingId,
          records: projection.rows.map(row => ({ id: row.id, contentHash: row.contentHash })),
        }, 4);
        const before = await observableState(projection.snapshotId, sourceSystem, request.requestId);
        await assertRejectedWithoutEffects(
          call("/operations/commands", reviewerId, request),
          before,
          () => observableState(projection.snapshotId, sourceSystem, request.requestId),
          "technical source history projection",
        );
      });

      await t.test(`${sourceSystem} blocks publication without changing the publication or command ledger`, async () => {
        const request = envelope(publication.snapshotId, "LegacyHistoryPublished", {
          fileHash: publication.fileHash,
          mappingId,
          evidence: { note: "synthetic owner publication attempt" },
        }, 4);
        const before = await observableState(publication.snapshotId, sourceSystem, request.requestId);
        await assertRejectedWithoutEffects(
          call("/operations/commands", ownerId, request),
          before,
          () => observableState(publication.snapshotId, sourceSystem, request.requestId),
          "technical source history publication",
        );
      });

      await t.test(`${sourceSystem} blocks corrections and preserves the source fact`, async () => {
        const request = envelope(correction.snapshotId, "LegacyHistoryCorrected", {
          factId: correctionFactId,
          replacement: {
            occurredOn: null,
            dateState: "absent",
            currency: "ARS",
            currencyState: "known",
            unit: null,
            unitState: "not-applicable",
            amountValue: "123",
            amountState: "known",
            quantityValue: null,
            quantityState: "not-applicable",
          },
          evidence: { note: "synthetic correction attempt" },
        }, 4);
        const before = await observableState(correction.snapshotId, sourceSystem, request.requestId);
        await assertRejectedWithoutEffects(
          call("/operations/commands", ownerId, request),
          before,
          () => observableState(correction.snapshotId, sourceSystem, request.requestId),
          "technical source history correction",
        );
        assert.equal(await db!.legacyHistoricalFact.count({ where: { correctionOf: correctionFactId } }), 0);
      });

      await t.test(`${sourceSystem} blocks both historical preview endpoints without writing`, async () => {
        for (const path of [
          `/legacy-imports/history/publication-preview?snapshotId=${publication.snapshotId}`,
          `/legacy-imports/history/projection-status?snapshotId=${publication.snapshotId}&mappingId=${mappingId}`,
        ]) {
          const before = await observableState(publication.snapshotId, sourceSystem);
          const response = await call(path, reviewerId);
          const body = await response.json() as { code?: string };
          assert.deepEqual(await observableState(publication.snapshotId, sourceSystem), before, `${path} must remain read-only`);
          assert.equal(response.status, 423, `${path}: ${JSON.stringify(body)}`);
          assert.equal(body.code, blockedCode);
        }
      });
    }

    const genericSource = "synthetic-generic-archive";
    const genericMappingId = "generic-archive-mapping-" + suffix;
    await createApprovedMapping(genericMappingId, ownerId);
    const generic = await createSnapshot(genericSource, genericMappingId, "generic-archive", [
      { table: "SyntheticArchiveFixture", key: "legacy-archive-row-1", row: 2, treatment: "archive_only" },
    ]);
    const genericRequest = envelope(generic.snapshotId, "LegacyHistoryProjected", {
      fileHash: generic.fileHash,
      mappingId: genericMappingId,
      records: generic.rows.map(row => ({ id: row.id, contentHash: row.contentHash })),
    }, 4);
    const genericBefore = await observableState(generic.snapshotId, genericSource, genericRequest.requestId);
    const genericResponse = await call("/operations/commands", reviewerId, genericRequest);
    const genericBody = await genericResponse.json() as {
      requestId: string;
      targetId: string;
      version: number;
      result: { projected: number; historyCreatesBalances: boolean };
    };
    const genericAfter = await observableState(generic.snapshotId, genericSource, genericRequest.requestId);
    assert.equal(genericResponse.status, 200, JSON.stringify(genericBody));
    assert.equal(genericBody.result.projected, 1);
    assert.equal(genericBody.result.historyCreatesBalances, false);
    assert.equal(genericBody.version, 5);
    assert.equal(genericAfter.facts.length, 1, "the canonical API must persist the generic archive projection");
    assert.equal(genericAfter.facts[0]!.kind, "archive");
    assert.equal(genericAfter.facts[0]!.attributes.sourceTreatment, "archive_only");
    assert.equal(genericAfter.object.version, 5);
    assert.equal(genericAfter.receipts.length, genericBefore.receipts.length + 1);
    assert.equal(genericAfter.audits.length, genericBefore.audits.length + 1);
    assert.equal(genericAfter.outbox.length, genericBefore.outbox.length + 1);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try {
      if (schemaCreated && db) await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    } finally {
      if (db) await db.$disconnect();
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});
