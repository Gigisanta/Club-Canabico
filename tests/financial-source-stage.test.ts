import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import {
  createFinancialSourceReviewManifest,
  FINANCIAL_SOURCE_STAGE_ACTOR,
  FinancialSourceStageError,
  prepareFinancialSourceStage,
  stageFinancialSource,
} from "../server/operations/financial-source-stage.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const backupScript = join(repositoryRoot, "scripts/operations-backup.mjs");
const backupEncryptionKey = "a".repeat(64);
const piiSentinel = "SYNTHETIC_USER_ROW_MUST_NOT_BE_STAGED";

interface FixtureRow {
  date: string | null;
  movement: string;
  cashBox: string;
  amount: number | string;
  currency: string;
  sourceKey: string;
}

function requireTestDatabase() {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, "TEST_DATABASE_URL is required for isolated financial source staging");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    assert.fail("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "TEST_DATABASE_URL must be a PostgreSQL URL");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  assert.ok(hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."), "TEST_DATABASE_URL must use loopback");
  assert.match(url.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a dedicated bombo_ui_ database");
  assert.ok(process.env.PG_BIN, "PG_BIN must point to the PostgreSQL 18 client tools");
  return url;
}

function optionalWrongTargetDatabase(testDatabase: URL) {
  const raw = process.env.WRONG_TARGET_TEST_DATABASE_URL;
  if (!raw) return new URL(testDatabase);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    assert.fail("WRONG_TARGET_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "the wrong-target test database must be a PostgreSQL URL");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  assert.ok(hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."), "the wrong-target test database must use loopback");
  assert.match(url.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "the wrong-target test database must name a dedicated bombo_ui_ database");
  assert.notEqual(databaseTargetIdentity(testDatabase), databaseTargetIdentity(url),
    "WRONG_TARGET_TEST_DATABASE_URL must name a different database from TEST_DATABASE_URL");
  const restoreRaw = process.env.RESTORE_TEST_DATABASE_URL;
  if (restoreRaw) {
    let restoreUrl: URL;
    try {
      restoreUrl = new URL(restoreRaw);
    } catch {
      assert.fail("RESTORE_TEST_DATABASE_URL must be a valid PostgreSQL URL");
    }
    assert.notEqual(databaseTargetIdentity(url), databaseTargetIdentity(restoreUrl),
      "the wrong-target test database must remain separate from the empty restore rehearsal database");
  }
  return url;
}

function databaseTargetIdentity(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHost = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")
    ? "loopback"
    : hostname;
  return JSON.stringify([normalizedHost, url.port || "5432", decodeURIComponent(url.pathname.slice(1))]);
}

function assertSeparateDatabaseTargets(testDatabase: URL, applicationDatabaseUrl: string | undefined) {
  if (!applicationDatabaseUrl) return;
  let applicationDatabase: URL;
  try {
    applicationDatabase = new URL(applicationDatabaseUrl);
  } catch {
    assert.fail("DATABASE_URL must be a valid PostgreSQL URL when supplied");
  }
  assert.ok(["postgres:", "postgresql:"].includes(applicationDatabase.protocol), "DATABASE_URL must be a PostgreSQL URL when supplied");
  assert.equal(
    databaseTargetIdentity(testDatabase) === databaseTargetIdentity(applicationDatabase),
    false,
    "TEST_DATABASE_URL must target a different PostgreSQL database from DATABASE_URL",
  );
}

function testProcessEnvironment(values: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
  };
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;
  return env;
}

function runBackupCli(mode: "backup" | "verify", directory: string, values: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [backupScript, mode, directory], {
      cwd: repositoryRoot,
      env: testProcessEnvironment(values),
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

function safeCliOutput(result: { stdout: string; stderr: string }) {
  return `${result.stdout}\n${result.stderr}`
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[PostgreSQL URL redacted]")
    .split(backupEncryptionKey).join("[synthetic fixture key]");
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
  for (const migration of migrations) {
    const source = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot));
    const checksum = createHash("sha256").update(source).digest("hex");
    await db.$executeRawUnsafe(
      `INSERT INTO "${schema}"."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      randomUUID(), checksum, migration.name,
    );
  }
}

async function createSchema(testDatabase: URL, schema: string) {
  const base = new PrismaClient({ datasources: { db: { url: testDatabase.toString() } } });
  const scopedUrl = new URL(testDatabase);
  scopedUrl.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
  let schemaCreated = false;
  try {
    await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const migration of migrations) {
      const source = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(source)) await db.$executeRawUnsafe(statement);
    }
    await seedMigrationHistory(db, schema);
    return { base, db, scopedUrl };
  } catch (error) {
    if (schemaCreated) {
      try { await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally {
        await db.$disconnect();
        await base.$disconnect();
      }
    } else {
      await db.$disconnect();
      await base.$disconnect();
    }
    throw error;
  }
}

function fixtureRows(prefix: string): FixtureRow[] {
  return [
    { date: "2026-08-31", movement: "Ingreso", cashBox: "Caja sintética A", amount: 125.5, currency: "ARS", sourceKey: `${prefix}-ars-in` },
    { date: "2026-08-31", movement: "Egreso", cashBox: "Caja sintética A", amount: 25.25, currency: "ARS", sourceKey: `${prefix}-ars-out` },
    { date: "2026-09-01", movement: "Ingreso", cashBox: "Caja sintética USD", amount: 10, currency: "USD", sourceKey: `${prefix}-usd-in` },
    { date: "2026-10-09", movement: "Ingreso", cashBox: "Caja sintética A", amount: "30.00", currency: "ARS", sourceKey: `${prefix}-future-text-amount` },
    { date: null, movement: "Ingreso", cashBox: "Caja sintética A", amount: 15, currency: "ARS", sourceKey: `${prefix}-missing-date` },
    { date: "2026-08-20", movement: "Ingreso", cashBox: "Caja sintética USD", amount: "no-numérico", currency: "USD", sourceKey: `${prefix}-invalid-amount` },
    { date: "2026-08-22", movement: "Ingreso", cashBox: "Caja sintética A", amount: 30, currency: "ARS", sourceKey: `${prefix}-duplicate-key` },
    { date: "2026-08-23", movement: "Ingreso", cashBox: "", amount: 40, currency: "ARS", sourceKey: `${prefix}-duplicate-key` },
  ];
}

async function workbookBytes(prefix: string) {
  const workbook = new ExcelJS.Workbook();
  const movements = workbook.addWorksheet("Movimiento_Nueva");
  movements.addRow(["Fecha", "Tipo_Movimiento", "Caja", "Monto", "Tipo_Moneda", "ID_Movimiento_Unique"]);
  for (const row of fixtureRows(prefix))
    movements.addRow([row.date, row.movement, row.cashBox, row.amount, row.currency, row.sourceKey]);
  const users = workbook.addWorksheet("T_Usuarios");
  users.addRow(["ID_Usuario", "Nombre", "Contraseña", "Token"]);
  users.addRow(["synthetic-user", piiSentinel, "synthetic-password", "synthetic-token"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function canonicalFixtureJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalFixtureJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function operationState(db: PrismaClient, snapshotId?: string) {
  return {
    snapshots: await db.legacyImportSnapshot.count(snapshotId ? { where: { id: snapshotId } } : undefined),
    records: await db.legacySourceRecord.count(snapshotId ? { where: { snapshotId } } : undefined),
    exceptions: await db.legacyException.count(snapshotId ? { where: { snapshotId } } : undefined),
    operationObjects: await db.operationObject.count(snapshotId ? { where: { id: snapshotId } } : undefined),
    audits: await db.operationAudit.count(snapshotId ? { where: { objectId: snapshotId } } : undefined),
    commandReceipts: await db.commandReceipt.count(snapshotId ? { where: { targetId: snapshotId } } : undefined),
    ledgerEvents: await db.ledgerEvent.count(),
    ledgerLegs: await db.ledgerLeg.count(),
    historicalFacts: await db.legacyHistoricalFact.count(),
    historyPublications: await db.legacyHistoryPublication.count(),
  };
}

test("financial source staging is scoped, digest checked, atomic, and idempotent", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const testDatabase = requireTestDatabase();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBackupEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  assertSeparateDatabaseTargets(testDatabase, originalDatabaseUrl);
  assert.equal(originalBackupEncryptionKey === undefined, true, "the test runner must not inherit a backup key");
  assert.equal(
    testProcessEnvironment({}).OPERATIONS_BACKUP_RESTORE_E2E,
    undefined,
    "the backup CLI helper must not inherit the restore rehearsal opt-in",
  );
  const sameTargetWithDifferentCredentialsAndSchema = new URL(testDatabase);
  sameTargetWithDifferentCredentialsAndSchema.hostname = "localhost";
  sameTargetWithDifferentCredentialsAndSchema.username = "synthetic-app-user";
  sameTargetWithDifferentCredentialsAndSchema.searchParams.set("schema", "synthetic-app-schema");
  assert.throws(
    () => assertSeparateDatabaseTargets(testDatabase, sameTargetWithDifferentCredentialsAndSchema.toString()),
    /TEST_DATABASE_URL must target a different PostgreSQL database from DATABASE_URL/,
    "different credentials, schema, or loopback aliases must not disguise the same database target",
  );
  const schema = `financial_stage_${randomUUID().replaceAll("-", "")}`;
  const wrongTargetDatabase = optionalWrongTargetDatabase(testDatabase);
  assertSeparateDatabaseTargets(wrongTargetDatabase, originalDatabaseUrl);
  const wrongSchema = `financial_wrong_target_${randomUUID().replaceAll("-", "")}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-financial-source-stage-"));
  const backupDirectory = join(temporaryRoot, "verified-backup");
  const legacyBackupDirectory = join(temporaryRoot, "legacy-unbound-backup");
  const privateObjectRoot = join(temporaryRoot, "private-objects");
  let schemaCreated = false;
  let wrongSchemaCreated = false;
  let base: PrismaClient | undefined;
  let db: PrismaClient | undefined;
  let wrongBase: PrismaClient | undefined;
  let wrongDb: PrismaClient | undefined;

  try {
    const schemaState = await createSchema(testDatabase, schema);
    ({ base, db } = schemaState);
    schemaCreated = true;
    const wrongSchemaState = await createSchema(wrongTargetDatabase, wrongSchema);
    ({ base: wrongBase, db: wrongDb } = wrongSchemaState);
    wrongSchemaCreated = true;
    await mkdir(privateObjectRoot, { recursive: true });

    const backup = await runBackupCli("backup", backupDirectory, {
      DATABASE_URL: schemaState.scopedUrl.toString(),
      BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
      PRIVATE_OBJECT_ROOT: privateObjectRoot,
      PRIVATE_OBJECT_PROVIDER: "local",
      PRIVATE_S3_BUCKET: "",
    });
    assert.equal(backup.code, 0, safeCliOutput(backup));
    const backupSummary = JSON.parse(backup.stdout) as { mode: string; files: number; encrypted: boolean; scope: string };
    assert.equal(backupSummary.mode, "backup");
    assert.equal(backupSummary.files, 1);
    assert.equal(backupSummary.encrypted, true);
    assert.equal(backupSummary.scope, "confirmed-server-state-only");

    const verified = await runBackupCli("verify", backupDirectory, { BACKUP_ENCRYPTION_KEY: backupEncryptionKey });
    assert.equal(verified.code, 0, safeCliOutput(verified));
    assert.deepEqual(JSON.parse(verified.stdout), {
      mode: "verify", files: 1, integrity: true, migrationsValid: true, scope: "confirmed-server-state-only",
    });
    const equivalentLoopbackUrl = new URL(schemaState.scopedUrl);
    equivalentLoopbackUrl.hostname = "localhost";
    const boundVerification = await runBackupCli("verify", backupDirectory, {
      DATABASE_URL: equivalentLoopbackUrl.toString(),
      BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
    });
    assert.equal(boundVerification.code, 0, safeCliOutput(boundVerification));
    const boundVerificationSummary = JSON.parse(boundVerification.stdout) as {
      mode: string; targetVerified: boolean; targetFingerprint: string;
    };
    assert.equal(boundVerificationSummary.mode, "verify");
    assert.equal(boundVerificationSummary.targetVerified, true);
    assert.match(boundVerificationSummary.targetFingerprint, /^[a-f0-9]{64}$/);
    const backupManifestBytes = await readFile(join(backupDirectory, "manifest.json"));
    const backupManifest = JSON.parse(backupManifestBytes.toString("utf8")) as {
      databaseMajor: number; databaseVersion: string; encrypted: boolean; schema: string; scope: string; targetFingerprint: string;
    };
    const backupManifestHash = createHash("sha256").update(backupManifestBytes).digest("hex");
    assert.equal(backupManifest.databaseMajor, 18);
    assert.equal(backupManifest.encrypted, true);
    assert.equal(backupManifest.schema, schema);
    assert.equal(backupManifest.targetFingerprint, boundVerificationSummary.targetFingerprint);
    assert.match(backupManifest.targetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(backupManifest.scope, "confirmed-server-state-only");
    assert.match(backupManifest.databaseVersion, /^18(?:\.|$)/);
    assert.equal((await readFile(join(backupDirectory, "manifest.sha256"), "utf8")).trim(), backupManifestHash);

    process.env.DATABASE_URL = schemaState.scopedUrl.toString();
    process.env.BACKUP_ENCRYPTION_KEY = backupEncryptionKey;
    const { bytes, prepared, reviewManifest } = await (async () => {
      const bytes = await workbookBytes(randomUUID());
      const prepared = await prepareFinancialSourceStage(bytes, "fixture-financial-source.xlsx");
      return { bytes, prepared, reviewManifest: createFinancialSourceReviewManifest(prepared.reconciliationManifest) };
    })();

    assert.equal(prepared.snapshot.fileHash, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(prepared.snapshot.sheets.map(sheet => sheet.name), ["Movimiento_Nueva"]);
    assert.equal(prepared.snapshot.records.length, 8);
    assert.equal(JSON.stringify(prepared).includes(piiSentinel), false, "T_Usuarios content must be dropped before staging");
    assert.deepEqual(prepared.metrics, {
      rawCount: 8,
      eligibleCount: 3,
      excludedCount: 5,
      keyedRecordCount: 8,
      duplicateKeyCount: 1,
      exceptionCount: 7,
      readerExceptionCount: 0,
      periodCount: 2,
      exceptionCounts: {
        missingDate: 1,
        invalidDate: 0,
        futureDate: 1,
        nonNumericAmount: 2,
        negativeAmount: 0,
        invalidMovementType: 0,
        invalidCurrency: 0,
        blankCashBox: 1,
        duplicateIdentity: 2,
      },
    });
    assert.equal(prepared.metrics.readerExceptionCount, 0, "archive-only rows do not enter the fact-candidate reader duplicate pass");
    assert.equal(prepared.metrics.exceptionCount, 7, "persisted exceptions include the seven row exclusion findings");
    assert.equal(prepared.observationRows[3]?.amountMinor, null, "a numeric-looking text amount has no exact minor units");
    assert.equal(
      prepared.snapshot.records[3]?.normalized.columns.find(column => column.header === "Monto")?.moneyMinorUnits,
      undefined,
      "a numeric-looking text amount must not be normalized as numeric evidence",
    );
    assert.deepEqual(prepared.reconciliationManifest, {
      fileHash: prepared.snapshot.fileHash,
      cutoffDate: "2026-10-08",
      rawCount: 8,
      eligibleCount: 3,
      excludedCount: 5,
      periods: [
        { month: "2026-08", currency: "ARS", count: 2, inflowMinor: "12550", outflowMinor: "2525", netMovementMinor: "10025" },
        { month: "2026-09", currency: "USD", count: 1, inflowMinor: "1000", outflowMinor: "0", netMovementMinor: "1000" },
      ],
    });

    const originalDatabaseUrlForStage = process.env.DATABASE_URL;
    const originalBackupKeyForStage = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = backupEncryptionKey;
    const wrongConnection = await wrongDb.$queryRawUnsafe<Array<{ database: string; schema: string }>>(
      "SELECT current_database() AS database, current_schema() AS schema",
    );
    assert.equal(wrongConnection[0]?.database, decodeURIComponent(wrongTargetDatabase.pathname.slice(1)));
    assert.equal(wrongConnection[0]?.schema, wrongSchema);
    const beforeWrongTarget = await operationState(wrongDb);
    const beforeOriginWrongTarget = await operationState(db);
    process.env.DATABASE_URL = wrongSchemaState.scopedUrl.toString();
    await assert.rejects(
      stageFinancialSource(prepared, {
        filename: prepared.filename,
        reviewManifest,
        backupReference: backupDirectory,
      }),
      (error: unknown) => error instanceof FinancialSourceStageError && error.code === "backup_verification_failed",
      "a same-version backup must be rejected when the configured live destination differs",
    );
    assert.deepEqual(await operationState(wrongDb), beforeWrongTarget, "a wrong-target rejection must not write into the configured destination");
    assert.deepEqual(await operationState(db), beforeOriginWrongTarget, "a wrong-target rejection must not write into the backup source either");

    await cp(backupDirectory, legacyBackupDirectory, { recursive: true });
    const legacyManifest = JSON.parse(await readFile(join(legacyBackupDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
    delete legacyManifest.targetFingerprint;
    const legacyManifestBytes = Buffer.from(JSON.stringify(legacyManifest, null, 2));
    await writeFile(join(legacyBackupDirectory, "manifest.json"), legacyManifestBytes);
    await writeFile(join(legacyBackupDirectory, "manifest.sha256"), `${createHash("sha256").update(legacyManifestBytes).digest("hex")}\n`);
    await writeFile(join(legacyBackupDirectory, "manifest.hmac"), `${createHmac("sha256", Buffer.from(backupEncryptionKey, "hex")).update(legacyManifestBytes).digest("hex")}\n`);
    process.env.DATABASE_URL = schemaState.scopedUrl.toString();
    const beforeLegacyTarget = await operationState(db);
    await assert.rejects(
      stageFinancialSource(prepared, {
        filename: prepared.filename,
        reviewManifest,
        backupReference: legacyBackupDirectory,
      }),
      (error: unknown) => error instanceof FinancialSourceStageError && error.code === "backup_verification_failed",
      "a correctly authenticated historical manifest without destination binding must not authorize application",
    );
    assert.deepEqual(await operationState(db), beforeLegacyTarget, "a legacy unbound backup must reject before writes");
    if (originalDatabaseUrlForStage === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrlForStage;
    if (originalBackupKeyForStage === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = originalBackupKeyForStage;

    const beforeRejectedManifest = await operationState(db);
    const mismatchedReviewManifest = structuredClone(reviewManifest) as typeof reviewManifest;
    mismatchedReviewManifest.source.fileHash = "0".repeat(64);
    await assert.rejects(
      stageFinancialSource(prepared, {
        filename: prepared.filename,
        reviewManifest: mismatchedReviewManifest,
        backupReference: backupDirectory,
      }),
      (error: unknown) => error instanceof FinancialSourceStageError && error.code === "review_manifest_mismatch",
    );
    assert.deepEqual(await operationState(db), beforeRejectedManifest, "hash mismatch must reject before database writes");

    const beforeStage = await operationState(db);
    const staged = await stageFinancialSource(prepared, {
      filename: prepared.filename,
      reviewManifest,
      backupReference: backupDirectory,
    });
    assert.equal(staged.status, "staged");
    assert.equal(staged.alreadyStaged, false);
    assert.equal(staged.recordCount, 8);
    assert.equal(staged.exceptionCount, 7);
    assert.equal(staged.eligibleCount, 3);
    assert.equal(staged.excludedCount, 5);
    assert.equal(staged.rowManifestHash, prepared.rowManifestHash);
    assert.equal(staged.backupManifestHash, backupManifestHash);
    assert.equal(staged.reviewManifestHash, createHash("sha256").update(canonicalFixtureJson(reviewManifest), "utf8").digest("hex"));

    const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: staged.snapshotId } });
    assert.ok(snapshot);
    assert.equal(snapshot.status, "staged");
    assert.equal(snapshot.createdBy, FINANCIAL_SOURCE_STAGE_ACTOR);
    assert.equal(snapshot.reviewedBy, null);
    assert.equal(snapshot.reviewedAt, null);
    assert.equal(snapshot.fileHash, prepared.snapshot.fileHash);
    const sourceControls = (snapshot.controls as { financialSourceStage?: {
      reviewManifestHash?: unknown;
      rowManifestHash?: unknown;
      backupManifestHash?: unknown;
    } }).financialSourceStage;
    assert.equal(sourceControls?.reviewManifestHash, staged.reviewManifestHash);
    assert.equal(sourceControls?.rowManifestHash, staged.rowManifestHash);
    assert.equal(sourceControls?.backupManifestHash, staged.backupManifestHash);
    const operationObject = await db.operationObject.findUnique({ where: { id: staged.snapshotId } });
    assert.ok(operationObject, "the staged snapshot must be a real reviewable OperationObject");
    assert.deepEqual({ id: operationObject.id, kind: operationObject.kind, version: operationObject.version, createdBy: operationObject.createdBy }, {
      id: staged.snapshotId,
      kind: "legacyImport",
      version: 0,
      createdBy: FINANCIAL_SOURCE_STAGE_ACTOR,
    });
    const persistedRecords = await db.legacySourceRecord.findMany({ where: { snapshotId: staged.snapshotId }, orderBy: { sourceRow: "asc" } });
    assert.equal(persistedRecords.length, 8);
    assert.ok(persistedRecords.every(record => record.sourceTable === "Movimiento_Nueva"));
    assert.equal(JSON.stringify(persistedRecords).includes(piiSentinel), false);
    const persistedExceptions = await db.legacyException.findMany({ where: { snapshotId: staged.snapshotId } });
    assert.equal(persistedExceptions.length, 7);
    const stagedAudits = await db.operationAudit.findMany({ where: { objectId: staged.snapshotId } });
    assert.equal(stagedAudits.length, 1);
    assert.equal(stagedAudits[0]?.action, "legacy.financial_source_staged");
    const auditDetails = stagedAudits[0]?.details as { rowManifestHash?: unknown; reviewManifestHash?: unknown; backupManifestHash?: unknown };
    assert.equal(auditDetails.rowManifestHash, staged.rowManifestHash);
    assert.equal(auditDetails.reviewManifestHash, staged.reviewManifestHash);
    assert.equal(auditDetails.backupManifestHash, staged.backupManifestHash);
    assert.equal(await db.commandReceipt.count({ where: { targetId: staged.snapshotId } }), 0);
    assert.equal(await db.legacyHistoricalFact.count({ where: { snapshotId: staged.snapshotId } }), 0);
    assert.equal(await db.legacyHistoryPublication.count({ where: { snapshotId: staged.snapshotId } }), 0);
    const afterStage = await operationState(db);
    assert.deepEqual({
      ledgerEvents: afterStage.ledgerEvents,
      ledgerLegs: afterStage.ledgerLegs,
      historicalFacts: afterStage.historicalFacts,
      historyPublications: afterStage.historyPublications,
    }, {
      ledgerEvents: beforeStage.ledgerEvents,
      ledgerLegs: beforeStage.ledgerLegs,
      historicalFacts: beforeStage.historicalFacts,
      historyPublications: beforeStage.historyPublications,
    }, "staging must not create ledger facts or publish history");
    assert.equal(afterStage.snapshots, beforeStage.snapshots + 1);
    assert.equal(afterStage.records, beforeStage.records + 8);
    assert.equal(afterStage.exceptions, beforeStage.exceptions + 7);
    assert.equal(afterStage.operationObjects, beforeStage.operationObjects + 1);
    assert.equal(afterStage.audits, beforeStage.audits + 1);
    assert.equal(afterStage.commandReceipts, beforeStage.commandReceipts);

    const beforeRepeat = await operationState(db);
    const repeated = await stageFinancialSource(prepared, {
      filename: prepared.filename,
      reviewManifest,
      backupReference: backupDirectory,
    });
    assert.equal(repeated.status, "already-staged");
    assert.equal(repeated.alreadyStaged, true);
    assert.equal(repeated.snapshotId, staged.snapshotId);
    assert.equal(repeated.rowManifestHash, staged.rowManifestHash);
    assert.equal(repeated.reviewManifestHash, staged.reviewManifestHash);
    assert.equal(repeated.backupManifestHash, staged.backupManifestHash);
    assert.deepEqual(await operationState(db), beforeRepeat, "idempotent retry must not append or rewrite staged state");

    const beforeImmutableUpdate = await operationState(db);
    const originalPersistedHash = persistedRecords[0]!.contentHash;
    await assert.rejects(
      db.legacySourceRecord.update({
        where: { id: persistedRecords[0]!.id },
        data: { contentHash: "0".repeat(64) },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("23514") &&
        error.message.includes("Source evidence is immutable; resolutions are separate"),
      "the database immutability trigger must reject changing source evidence contentHash",
    );
    const recordAfterBlockedUpdate = await db.legacySourceRecord.findUnique({
      where: { id: persistedRecords[0]!.id },
      select: { contentHash: true },
    });
    assert.equal(recordAfterBlockedUpdate?.contentHash, originalPersistedHash, "the rejected update must preserve the original evidence hash");
    assert.deepEqual(await operationState(db), beforeImmutableUpdate, "the rejected evidence mutation must leave persisted state unchanged");

    const replayAfterImmutableUpdate = await stageFinancialSource(prepared, {
      filename: prepared.filename,
      reviewManifest,
      backupReference: backupDirectory,
    });
    assert.equal(replayAfterImmutableUpdate.status, "already-staged");
    assert.deepEqual(await operationState(db), beforeImmutableUpdate, "the replay after blocked mutation must not append or rewrite state");

    const rollbackBytes = await workbookBytes(randomUUID());
    const rollbackPrepared = await prepareFinancialSourceStage(rollbackBytes, "fixture-financial-source-rollback.xlsx");
    assert.ok(rollbackPrepared.exceptions.length > 0);
    const rollbackManifest = createFinancialSourceReviewManifest(rollbackPrepared.reconciliationManifest);
    const rollbackInput = {
      ...rollbackPrepared,
      exceptions: [rollbackPrepared.exceptions[0]!, rollbackPrepared.exceptions[0]!],
    };
    const beforeRollback = await operationState(db);
    await assert.rejects(
      stageFinancialSource(rollbackInput, {
        filename: rollbackPrepared.filename,
        reviewManifest: rollbackManifest,
        backupReference: backupDirectory,
      }),
      (error: unknown) => error instanceof FinancialSourceStageError && error.code === "stage_transaction_failed",
    );
    assert.deepEqual(await operationState(db), beforeRollback, "late unique-key failure must roll back snapshot, rows, exceptions, object and audit");
    assert.equal(await db.legacyImportSnapshot.count({ where: { id: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.legacySourceRecord.count({ where: { snapshotId: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.legacyException.count({ where: { snapshotId: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.operationObject.count({ where: { id: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { objectId: rollbackPrepared.snapshotId } }), 0);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalBackupEncryptionKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = originalBackupEncryptionKey;
    if (schemaCreated && base) {
      try { await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await base.$disconnect(); }
    } else {
      await base?.$disconnect();
    }
    await db?.$disconnect();
    await wrongDb?.$disconnect();
    if (wrongSchemaCreated && wrongBase) {
      try { await wrongBase.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${wrongSchema}" CASCADE`); }
      finally { await wrongBase.$disconnect(); }
    } else {
      await wrongBase?.$disconnect();
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
