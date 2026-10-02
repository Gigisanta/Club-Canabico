import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import { restoreCatalogObjectCount } from "../scripts/backup-restore-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const backupScript = join(repositoryRoot, "scripts/operations-backup.mjs");
const backupWorkerScript = join(repositoryRoot, "scripts/operations-backup-worker.mjs");
function requireTestDatabase() {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, "TEST_DATABASE_URL is required for the operations backup CLI boundary");
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "TEST_DATABASE_URL must use loopback");
  assert.match(url.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a dedicated bombo_ui_ database");
  return url;
}

function requireRestoreTestDatabase() {
  const raw = process.env.RESTORE_TEST_DATABASE_URL;
  assert.ok(raw, "RESTORE_TEST_DATABASE_URL is required for the isolated restore rehearsal");
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "RESTORE_TEST_DATABASE_URL must use loopback");
  assert.match(url.pathname, /^\/bombo_ui_restore(?:_[a-z0-9_-]+)?$/i, "RESTORE_TEST_DATABASE_URL must name a dedicated bombo_ui_restore database");
  return url;
}

function processEnvironment(values: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
  };
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;
  return env;
}

function runBackupCli(mode: "backup" | "restore" | "verify", directory: string, values: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [backupScript, mode, directory], {
      cwd: repositoryRoot,
      env: processEnvironment(values),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function runBackupWorker(values: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [backupWorkerScript, "--once"], {
      cwd: repositoryRoot,
      env: processEnvironment(values),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function seedMigrationHistory(db: PrismaClient, schema: string) {
  const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )`);
  const applied: Array<{ name: string; checksum: string }> = [];
  for (const migration of migrations) {
    const source = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot));
    const checksum = createHash("sha256").update(source).digest("hex");
    await db.$executeRawUnsafe(
      `INSERT INTO "${schema}"."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      randomUUID(), checksum, migration.name,
    );
    applied.push({ name: migration.name, checksum });
  }
  return applied;
}

async function seedSnapshotFacts(db: PrismaClient) {
  const accountId = `backup-account-${randomUUID()}`;
  const ledgerEventId = `backup-ledger-${randomUUID()}`;
  const requestId = randomUUID();
  await db.operationAccount.create({
    data: { id: accountId, name: "Synthetic backup account", currency: "ARS", kind: "cash", holder: "fixture", purpose: "backup test" },
  });
  await db.ledgerEvent.create({
    data: { id: ledgerEventId, requestId, kind: "test", occurredAt: new Date("2026-10-01T12:00:00.000Z"), actorId: "backup-test", sourceObjectId: accountId, description: "Synthetic exact fingerprint", metadata: { amountMinor: "9007199254740993" } },
  });
  await db.ledgerLeg.create({
    data: { id: `backup-leg-${randomUUID()}`, eventId: ledgerEventId, accountId, currency: "ARS", amountMinor: 9007199254740993n },
  });
  await db.stockReservation.create({
    data: { id: `backup-reservation-${randomUUID()}`, orderId: "synthetic-order", lineId: "synthetic-line", balanceId: "synthetic-balance", quantity: "1.250", consumed: "0.250", status: "active" },
  });
  const payableId = `backup-payable-${randomUUID()}`;
  await db.operationPayable.create({
    data: { id: payableId, beneficiaryId: "synthetic-beneficiary", kind: "supplier", currency: "ARS", amountMinor: 12001n, paidMinor: 2001n, dueDate: "2026-10-15", accrualPeriod: "2026-10", evidence: { reference: "synthetic" } },
  });
  await db.payablePayment.create({
    data: { id: `backup-payment-${randomUUID()}`, payableId, accountId, currency: "ARS", amountMinor: 2001n, appliedMinor: 2001n, exchangeRate: "1.000000000000", date: "2026-10-01", eventId: ledgerEventId },
  });
  await db.memberCredit.create({
    data: { id: `backup-credit-${randomUUID()}`, memberId: "synthetic-member", collectionId: "synthetic-collection", currency: "ARS", amountMinor: 51n, resolvedMinor: 1n, treatment: "credit" },
  });
  await db.collectionReport.create({
    data: { id: `backup-collection-${randomUUID()}`, orderId: "synthetic-order", reporterId: "synthetic-driver", method: "cash", currency: "ARS", amountMinor: 4001n, accountId, custodianId: "synthetic-driver", evidence: { reference: "synthetic" }, status: "verified", appliedMinor: 4001n },
  });
  await db.rendition.create({
    data: { id: `backup-rendition-${randomUUID()}`, driverId: "synthetic-driver", fromAccountId: accountId, toAccountId: "synthetic-destination", currency: "ARS", grossMinor: 4001n, deliveredMinor: 4001n, feeMinor: 0n, mode: "gross", acceptedBy: "backup-test" },
  });
  await db.accountReconciliation.create({
    data: { id: `backup-reconciliation-${randomUUID()}`, accountId, date: "2026-10-01", calculatedMinor: 4001n, countedMinor: 4001n, differenceMinor: 0n, evidence: { reference: "synthetic" }, reviewerId: "synthetic-reviewer" },
  });
  await db.deliveryRoute.create({
    data: { id: `backup-route-${randomUUID()}`, driverId: "synthetic-driver", shiftDate: "2026-10-01", custodianAccountId: accountId, remunerationMinor: 0n, remunerationCurrency: "ARS" },
  });
  await db.commandReceipt.create({
    data: { requestId, actorId: "backup-test", targetId: ledgerEventId, command: "SyntheticFinancialReceipt", bodyHash: "a".repeat(64), response: { amountMinor: "9007199254740993" }, resultingVersion: 1, authorityEpoch: 1, occurredAt: new Date("2026-10-01T12:00:00.000Z") },
  });
  await db.legacyImportSnapshot.create({
    data: { id: "synthetic-snapshot", sourceSystem: "synthetic-backup", filename: "synthetic.xlsx", fileHash: "e".repeat(64), importerVersion: "fixture-1", createdBy: "backup-test", controls: {}, coverage: {} },
  });
  await db.legacySourceRecord.create({
    data: { id: "synthetic-source-record", snapshotId: "synthetic-snapshot", sourceTable: "invoice", sourceKey: "fixture-1", sourceRow: 1, fileHash: "e".repeat(64), contentHash: "f".repeat(64), importerVersion: "fixture-1", original: { total: "30.01" }, normalized: { amountMinor: "3001" }, treatment: "reviewed" },
  });
  await db.legacyHistoricalFact.create({
    data: { id: `backup-history-fact-${randomUUID()}`, snapshotId: "synthetic-snapshot", sourceRecordId: "synthetic-source-record", sourceTable: "invoice", sourceKey: "fixture-1", sourceRow: 1, sourceHash: "b".repeat(64), mappingId: "synthetic-map", kind: "invoice", occurredOn: "2026-10-01", dateState: "known", currency: "ARS", currencyState: "known", unit: null, unitState: "absent", amountMinor: 3001n, amountState: "known", quantity: null, quantityState: "absent", attributes: { totalMinor: "3001" }, correctionOf: null, createdBy: "backup-test" },
  });
  await db.legacyHistoryPublication.create({
    data: { sourceSystem: "synthetic-backup", snapshotId: "synthetic-snapshot", fileHash: "c".repeat(64), mappingId: "synthetic-map", fingerprint: "d".repeat(64), publishedBy: "backup-test", evidence: { reference: "synthetic" } },
  });
}

function safeOutput(result: { stdout: string; stderr: string }) {
  return `${result.stdout}\n${result.stderr}`.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL]");
}

async function writeDumpStub(directory: string, exitCode: number) {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "pg_dump");
  const source = [
    `#!${process.execPath}`,
    'import { writeFile } from "node:fs/promises";',
    'if (process.argv.includes("--version")) { console.log("pg_dump (PostgreSQL) 18.0"); process.exit(0); }',
    'const index = process.argv.indexOf("--file");',
    'if (index < 0 || !process.env.PG_DUMP_MARKER) process.exit(90);',
    'await writeFile(process.argv[index + 1], "partial synthetic dump");',
    'await writeFile(process.env.PG_DUMP_MARKER, "started");',
    `process.exit(${exitCode});`,
    "",
  ].join("\n");
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("backup CLI removes a partial snapshot after pg_dump and transaction failures", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = requireTestDatabase();
  const schema = `ops_dump_failure_${randomUUID().replaceAll("-", "")}`;
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-dump-cleanup-test-"));
  let schemaCreated = false;

  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await seedMigrationHistory(db, schema);
    const pgBin = join(temporaryRoot, "pg-bin");
    const marker = join(temporaryRoot, "pg-dump-started");
    await writeDumpStub(pgBin, 23);
    const failedDirectory = join(temporaryRoot, "dump-failed");
    const failed = await runBackupCli("backup", failedDirectory, {
      DATABASE_URL: url.toString(),
      PRIVATE_OBJECT_ROOT: join(temporaryRoot, "source-objects"),
      PG_BIN: pgBin,
      PG_DUMP_MARKER: marker,
    });
    assert.equal(await readFile(marker, "utf8"), "started");
    assert.notEqual(failed.code, 0);
    assert.match(safeOutput(failed), /pg_dump falló \(23\)/);
    await assert.rejects(lstat(join(failedDirectory, "snapshot.tmp")), { code: "ENOENT" });

    await writeDumpStub(pgBin, 0);
    await rm(marker, { force: true });
    const transactionFailureDirectory = join(temporaryRoot, "transaction-failed");
    const transactionFailure = await runBackupCli("backup", transactionFailureDirectory, {
      DATABASE_URL: url.toString(),
      PRIVATE_OBJECT_ROOT: join(temporaryRoot, "source-objects"),
      PG_BIN: pgBin,
      PG_DUMP_MARKER: marker,
    });
    assert.equal(await readFile(marker, "utf8"), "started");
    assert.notEqual(transactionFailure.code, 0);
    assert.match(safeOutput(transactionFailure), /OperationDocument|relation .* does not exist/i);
    await assert.rejects(lstat(join(transactionFailureDirectory, "snapshot.tmp")), { code: "ENOENT" });
  } finally {
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("restore CLI rejects unsafe roots before database changes and stores objects locally", {
  skip: !process.env.RESTORE_TEST_DATABASE_URL || process.env.OPERATIONS_BACKUP_RESTORE_E2E !== "true",
}, async (t) => {
  const baseUrl = requireRestoreTestDatabase();
  const schema = `ops_restore_${randomUUID().replaceAll("-", "")}`;
  baseUrl.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasources: { db: { url: baseUrl.toString() } } });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-restore-cli-test-"));
  const sourceRoot = join(temporaryRoot, "normal-objects");
  const workerBackupRoot = join(temporaryRoot, "scheduled-backups");
  let backupDirectory = join(temporaryRoot, "backup-package");
  const restoreRoot = join(temporaryRoot, "restore-objects");
  const documentId = randomUUID();
  const backupEncryptionKey = "b".repeat(64);
  const objectBytes = Buffer.from("%PDF-1.4\nSynthetic restore rehearsal evidence\n%%EOF");
  const objectKey = `documents/${documentId}/${randomUUID()}`;
  let s3Server: ReturnType<typeof createServer> | undefined;
  const s3Requests: string[] = [];

  try {
    const preexistingCatalogObjects = await restoreCatalogObjectCount(db);

    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const migration of migrations) {
      const source = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(source)) await db.$executeRawUnsafe(statement);
    }
    const appliedMigrations = await seedMigrationHistory(db, schema);

    process.env.NODE_ENV = "test";
    process.env.PRIVATE_OBJECT_ROOT = sourceRoot;
    delete process.env.PRIVATE_S3_BUCKET;
    const { putPrivateObject } = await import("../server/operations/object-store.js");
    const originalObject = await putPrivateObject(objectKey, objectBytes, "application/pdf");
    await db.operationDocument.create({
      data: {
        id: documentId,
        kind: "synthetic-restore-test",
        sensitivity: "commercial",
        state: "available",
        objectKey,
        objectVersion: originalObject.version,
        checksum: originalObject.checksum,
        bytes: objectBytes.length,
        mediaType: "application/pdf",
        metadata: { fixture: "synthetic" },
        createdBy: "restore-boundary-test",
      },
    });
    await seedSnapshotFacts(db);

    const backup = await runBackupWorker({
      DATABASE_URL: baseUrl.toString(),
      BACKUP_ROOT: workerBackupRoot,
      BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
      PRIVATE_OBJECT_ROOT: sourceRoot,
      PRIVATE_OBJECT_PROVIDER: "local",
      PRIVATE_S3_BUCKET: "",
    });
    assert.equal(backup.code, 0, safeOutput(backup));
    const workerSummary = JSON.parse(backup.stdout) as { mode: string; ok: boolean; encrypted: boolean; backupId: string };
    assert.deepEqual({ mode: workerSummary.mode, ok: workerSummary.ok, encrypted: workerSummary.encrypted },
      { mode: "backup-worker", ok: true, encrypted: true });
    backupDirectory = join(workerBackupRoot, workerSummary.backupId);
    assert.match(workerSummary.backupId, /^backup-/);
    const manifestBytes = await readFile(join(backupDirectory, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      schemaVersion: number;
      databaseMajor: number;
      databaseVersion: string;
      schema: string;
      migrations: Array<{ name: string; checksum: string }>;
      counts: Record<string, number>;
      financialFingerprints: Record<string, { sha256: string; rowCounts: Record<string, number> }>;
    };
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.databaseMajor, 18);
    assert.match(manifest.databaseVersion, /^18(?:\.|$)/);
    assert.equal((JSON.parse(manifestBytes.toString("utf8")) as { encrypted: boolean }).encrypted, true);
    assert.equal(manifest.schema, schema);
    assert.deepEqual(manifest.migrations, appliedMigrations);
    assert.equal(manifest.counts.legacyHistoricalFacts, 1);
    assert.equal(manifest.counts.legacyHistoryPublications, 1);
    for (const category of ["ledger", "reservations", "debt", "custody", "receipts"]) {
      const fingerprint = manifest.financialFingerprints[category];
      assert.ok(fingerprint && /^[a-f0-9]{64}$/.test(fingerprint.sha256), `missing exact ${category} fingerprint`);
      assert.ok(Object.values(fingerprint.rowCounts).some((count) => count > 0), `${category} fingerprint has no fixture rows`);
    }

    const originalManifestHash = createHash("sha256").update(manifestBytes).digest("hex");
    const invalidManifestBytes = Buffer.from(JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(1) }, null, 2));
    await writeFile(join(backupDirectory, "manifest.json"), invalidManifestBytes);
    await writeFile(join(backupDirectory, "manifest.sha256"), createHash("sha256").update(invalidManifestBytes).digest("hex"));
    const invalidMigrationPackage = await runBackupCli("verify", backupDirectory, { BACKUP_ENCRYPTION_KEY: backupEncryptionKey });
    assert.notEqual(invalidMigrationPackage.code, 0);
    assert.match(safeOutput(invalidMigrationPackage), /migraci|migration/i);
    await writeFile(join(backupDirectory, "manifest.json"), manifestBytes);
    await writeFile(join(backupDirectory, "manifest.sha256"), `${originalManifestHash}\n`);

    const nonEmptyRoot = join(temporaryRoot, "non-empty-restore");
    await mkdir(nonEmptyRoot);
    await writeFile(join(nonEmptyRoot, "keep.txt"), "sentinel");
    const symlinkTarget = join(temporaryRoot, "restore-symlink-target");
    await mkdir(symlinkTarget);
    const symlinkRoot = join(temporaryRoot, "restore-symlink");
    await symlink(symlinkTarget, symlinkRoot, "dir");
    const rootCases: Array<{ label: string; value?: string; expected: RegExp }> = [
      { label: "missing", expected: /RESTORE_PRIVATE_OBJECT_ROOT/ },
      { label: "relative", value: "restore-relative", expected: /absoluta/ },
      { label: "non-empty", value: nonEmptyRoot, expected: /vacío/ },
      { label: "symlink", value: symlinkRoot, expected: /enlace simbólico/ },
      { label: "same as normal root", value: sourceRoot, expected: /separado|solaparse/ },
      { label: "inside normal root", value: join(sourceRoot, "restore"), expected: /separado|solaparse/ },
      { label: "inside backup", value: join(backupDirectory, "restore"), expected: /backup|solaparse/ },
    ];

    for (const rootCase of rootCases) {
      const result = await runBackupCli("restore", backupDirectory, {
        RESTORE_DATABASE_URL: baseUrl.toString(),
        BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
        ...(rootCase.value === undefined ? {} : { RESTORE_PRIVATE_OBJECT_ROOT: rootCase.value }),
        PRIVATE_OBJECT_ROOT: sourceRoot,
        PRIVATE_S3_BUCKET: "synthetic-normal-bucket-must-not-be-used",
      });
      assert.notEqual(result.code, 0, `${rootCase.label} root unexpectedly restored`);
      assert.match(safeOutput(result), rootCase.expected, `${rootCase.label} root was rejected for an unrelated reason`);
      assert.equal(await db.operationDocument.count({ where: { id: documentId } }), 1, `${rootCase.label} root changed the test database`);
    }

    await mkdir(restoreRoot);
    const acceptedEmptyRoot = await runBackupCli("restore", backupDirectory, {
      RESTORE_DATABASE_URL: baseUrl.toString(),
      BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
      RESTORE_PRIVATE_OBJECT_ROOT: restoreRoot,
      PRIVATE_OBJECT_ROOT: sourceRoot,
      PRIVATE_S3_BUCKET: "synthetic-normal-bucket-must-not-be-used",
    });
    assert.notEqual(acceptedEmptyRoot.code, 0);
    assert.match(safeOutput(acceptedEmptyRoot), /El destino contiene objetos/);
    assert.deepEqual(await readdir(restoreRoot), []);
    assert.equal(await db.operationDocument.count({ where: { id: documentId } }), 1);

    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);

    await t.test("restore rejects a standalone user schema and enum in an otherwise empty database", {
      skip: preexistingCatalogObjects > 0 ? "the authorized restore test database already contains user catalog objects" : false,
    }, async () => {
      const schemaGuard = `restore_schema_guard_${randomUUID().replaceAll("-", "")}`;
      const enumGuard = `restore_enum_guard_${randomUUID().replaceAll("-", "")}`;
      const restoreValues = {
        RESTORE_DATABASE_URL: baseUrl.toString(),
        BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
        RESTORE_PRIVATE_OBJECT_ROOT: restoreRoot,
        PRIVATE_OBJECT_ROOT: sourceRoot,
      };
      try {
        await db.$executeRawUnsafe(`CREATE SCHEMA "${schemaGuard}"`);
        const schemaOnly = await runBackupCli("restore", backupDirectory, restoreValues);
        assert.notEqual(schemaOnly.code, 0);
        assert.match(safeOutput(schemaOnly), /El destino contiene objetos/);
        assert.deepEqual(await readdir(restoreRoot), []);
      } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaGuard}" CASCADE`);
      }
      try {
        await db.$executeRawUnsafe(`CREATE TYPE "public"."${enumGuard}" AS ENUM ('blocked')`);
        const enumOnly = await runBackupCli("restore", backupDirectory, restoreValues);
        assert.notEqual(enumOnly.code, 0);
        assert.match(safeOutput(enumOnly), /El destino contiene objetos/);
        assert.deepEqual(await readdir(restoreRoot), []);
      } finally {
        await db.$executeRawUnsafe(`DROP TYPE IF EXISTS "public"."${enumGuard}"`);
      }
    });

    await t.test("a valid empty restore root routes files locally without writing to the normal bucket", {
      skip: preexistingCatalogObjects > 0 ? "the authorized test database has unrelated objects and restore correctly requires it to be empty" : false,
    }, async () => {
      s3Server = createServer((request, response) => {
        void (async () => {
          for await (const _chunk of request) { /* consume the synthetic request body */ }
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          s3Requests.push(`${request.method} ${url.pathname}${url.search}`);
          if (request.method === "GET" && url.searchParams.has("versioning")) {
            response.writeHead(200, { "Content-Type": "application/xml" });
            response.end("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
          } else if (request.method === "PUT") {
            response.writeHead(200, { "x-amz-version-id": "synthetic-normal-bucket-version" });
            response.end();
          } else if (request.method === "GET") {
            response.writeHead(200, { "Content-Length": String(objectBytes.length) });
            response.end(objectBytes);
          } else {
            response.writeHead(500);
            response.end();
          }
        })().catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      await new Promise<void>((resolveListen) => s3Server!.listen(0, "127.0.0.1", resolveListen));
      const address = s3Server.address();
      assert.ok(address && typeof address !== "string");
      const restored = await runBackupCli("restore", backupDirectory, {
        RESTORE_DATABASE_URL: baseUrl.toString(),
        BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
        RESTORE_PRIVATE_OBJECT_ROOT: restoreRoot,
        PRIVATE_OBJECT_ROOT: sourceRoot,
        PRIVATE_S3_BUCKET: "synthetic-normal-bucket-must-not-be-used",
        PRIVATE_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
        PRIVATE_S3_PATH_STYLE: "true",
        PRIVATE_S3_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "synthetic-access-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret-key",
        AWS_EC2_METADATA_DISABLED: "true",
      });
      assert.equal(restored.code, 0, safeOutput(restored));
      const restoreReport = JSON.parse(restored.stdout) as {
        migrationsValid?: boolean;
        elapsedMilliseconds?: number;
        financialFingerprints?: typeof manifest.financialFingerprints;
      };
      assert.equal(restoreReport.migrationsValid, true);
      assert.ok(Number.isSafeInteger(restoreReport.elapsedMilliseconds) && restoreReport.elapsedMilliseconds! >= 0);
      t.diagnostic(`Restore aislado PostgreSQL 18: ${restoreReport.elapsedMilliseconds} ms (medido por operations-backup.mjs).`);
      assert.deepEqual(restoreReport.financialFingerprints, manifest.financialFingerprints);
      assert.deepEqual(s3Requests, [], "restore sent requests to the configured normal S3 bucket");
      const restoredManifest = JSON.parse(await readFile(join(backupDirectory, "manifest.json"), "utf8")) as {
        objects: Array<{ file: string; objectKey: string; objectVersion: string }>;
      };
      assert.equal(restoredManifest.objects.length, 1);
      const restoredObject = restoredManifest.objects[0]!;
      assert.deepEqual(await readFile(resolve(restoreRoot, restoredObject.objectKey, restoredObject.objectVersion)), objectBytes);
      const restoredDocument = await db.operationDocument.findUniqueOrThrow({ where: { id: documentId } });
      assert.equal(restoredDocument.objectKey, objectKey);
      assert.equal(restoredDocument.checksum, originalObject.checksum);
    });
  } finally {
    if (s3Server?.listening) await new Promise<void>((resolveClose, reject) => s3Server!.close((error) => error ? reject(error) : resolveClose()));
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
