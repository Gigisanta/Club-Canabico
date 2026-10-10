import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";

type AppSheetArchiveStageModule = typeof import("../server/operations/appsheet-archive-stage.js");
let appSheetArchiveStage: AppSheetArchiveStageModule | undefined;

function appSheetStage(): AppSheetArchiveStageModule {
  assert.ok(appSheetArchiveStage, "the AppSheet stage module must be loaded after selecting the fixture DATABASE_URL");
  return appSheetArchiveStage;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const backupScript = join(repositoryRoot, "scripts/operations-backup.mjs");
const backupEncryptionKey = "a".repeat(64);
const authCanary = "SYNTHETIC_AUTH_CANARY_MUST_NOT_BE_STAGED";

const fixturePrimaryKeyHeaders: Record<string, string> = {
  C_Cliente: "Id_Cliente",
  D_Catalogo_Mercaderia: "CatalogoID",
  C_Facturacion: "Id_Factura",
  C_Detalle_Fact: "Id_Detalle",
  C_Moto: "Id_Moto",
  C_Mercaderia: "ID_Mercaderia",
  Mov_Stock1: "ID_Mov_Stock_Total",
  C_gastos_operacion: "Id_gastos",
  C_OperacionUSD: "ID_OPUSD",
  Movimiento_Nueva: "ID_Movimiento_Unique",
  Pre_Venta: "Id_Preventa",
  Pre_Detalle_Fact: "Id_Pre_Detalle",
  Movimiento: "ID_Movimiento",
};

function requireTestDatabase(): URL {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, "TEST_DATABASE_URL is required for isolated AppSheet archive staging");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    assert.fail("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "TEST_DATABASE_URL must be PostgreSQL");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  assert.ok(hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."), "TEST_DATABASE_URL must use loopback");
  assert.match(url.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a dedicated bombo_ui_ database");
  assert.ok(process.env.PG_BIN, "PG_BIN must point to PostgreSQL 18 client tools");

  const applicationUrl = process.env.DATABASE_URL;
  if (applicationUrl) {
    let applicationDatabase: URL;
    try {
      applicationDatabase = new URL(applicationUrl);
    } catch {
      assert.fail("DATABASE_URL must be a valid URL when supplied");
    }
    const target = (candidate: URL) => {
      const host = candidate.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const normalizedHost = host === "localhost" || host === "::1" || host.startsWith("127.") ? "loopback" : host;
      return JSON.stringify([normalizedHost, candidate.port || "5432", decodeURIComponent(candidate.pathname.slice(1))]);
    };
    assert.notEqual(target(url), target(applicationDatabase), "TEST_DATABASE_URL must target a different PostgreSQL database from DATABASE_URL");
  }
  return url;
}

function processEnvironment(values: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH ?? "/dev/null",
    ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
  };
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;
  return env;
}

function createEncryptedBackup(directory: string, values: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [backupScript, "backup", directory], {
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

function safeCliOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[PostgreSQL URL redacted]")
    .split(backupEncryptionKey).join("[synthetic fixture key]");
}

async function applyMigrations(db: PrismaClient, schema: string): Promise<void> {
  const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const migration of migrations) {
    const source = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
    for (const statement of splitSqlStatements(source)) await db.$executeRawUnsafe(statement);
  }
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
    await db.$executeRawUnsafe(
      `INSERT INTO "${schema}"."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      randomUUID(), createHash("sha256").update(source).digest("hex"), migration.name,
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
    await applyMigrations(db, schema);
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

function fixtureManifest(fileHash: string, formulaOnlyRow = false, collationOrderRows = false) {
  const { APPSHEET_ARCHIVE_SHEETS, APPSHEET_ARCHIVE_SOURCE_SYSTEM } = appSheetStage();
  return {
    schemaVersion: 1,
    fileHash,
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    sheets: APPSHEET_ARCHIVE_SHEETS.map((name) => {
      const recordCount = name === "C_Cliente" || name === "Movimiento_Nueva" ||
        (formulaOnlyRow && name === "D_Catalogo_Mercaderia") ||
        (collationOrderRows && (name === "C_gastos_operacion" || name === "C_Mercaderia")) ? 1 : 0;
      const primaryKeyHeader = fixturePrimaryKeyHeaders[name] ?? null;
      return {
        name,
        recordCount,
        keyedRecordCount: primaryKeyHeader === null ? null : name === "D_Catalogo_Mercaderia" && formulaOnlyRow ? 0 : recordCount,
        duplicateKeyCount: primaryKeyHeader === null ? null : 0,
        missingKeyCount: primaryKeyHeader === null ? null : name === "D_Catalogo_Mercaderia" && formulaOnlyRow ? 1 : 0,
        primaryKeyHeader,
        archiveOnly: name === "Movimiento_Nueva" || primaryKeyHeader === null,
      };
    }),
  };
}

function fixtureCoordinateCoverage(fileHash: string) {
  const { APPSHEET_COORDINATE_ONLY_SHEETS, APPSHEET_ARCHIVE_SOURCE_SYSTEM } = appSheetStage();
  return {
    schemaVersion: 1,
    fileHash,
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    sheets: APPSHEET_COORDINATE_ONLY_SHEETS.map((name) => ({ name, extracted: false as const, dimension: "A1" })),
  };
}

async function syntheticWorkbook(label: string, options: {
  credentialHeaderOnBusinessSheet?: boolean;
  formulaOnlyRow?: boolean;
  collationOrderRows?: boolean;
} = {}) {
  const { APPSHEET_ARCHIVE_SHEETS, APPSHEET_COORDINATE_ONLY_SHEETS } = appSheetStage();
  const workbook = new ExcelJS.Workbook();
  const { credentialHeaderOnBusinessSheet = false, formulaOnlyRow = false, collationOrderRows = false } = options;
  for (const name of APPSHEET_ARCHIVE_SHEETS) {
    const sheet = workbook.addWorksheet(name);
    const primaryKeyHeader = fixturePrimaryKeyHeaders[name];
    const headers = name === "C_Cliente" && credentialHeaderOnBusinessSheet
      ? ["Id_Cliente", "Nombre", "Token"]
      : name === "C_Cliente"
      ? ["Id_Cliente", "Nombre", "Monto"]
      : name === "Movimiento_Nueva"
        ? ["ID_Movimiento_Unique", "Descripción"]
        : primaryKeyHeader ? [primaryKeyHeader, "Dato_sintético"] : ["Dato_sintético"];
    if (name === "Auditoria_General") {
      sheet.addRow(["metadato sintético"]);
      sheet.addRow(headers);
    } else {
      sheet.addRow(headers);
    }
    if (name === "C_Cliente") sheet.addRow([0, `Cliente sintético ${label}`, credentialHeaderOnBusinessSheet ? "synthetic-token-only" : 0]);
    if (name === "D_Catalogo_Mercaderia" && formulaOnlyRow) sheet.getCell("B2").value = { formula: "1+1" };
    if (name === "Movimiento_Nueva") sheet.addRow([`movimiento-sintético-${label}`, "Fila de archivo sintética"]);
    if (name === "C_gastos_operacion" && collationOrderRows) sheet.addRow([`gasto-sintético-${label}`, "Gasto sintético"]);
    if (name === "C_Mercaderia" && collationOrderRows) sheet.addRow([`mercadería-sintética-${label}`, "Mercadería sintética"]);
  }

  for (const name of APPSHEET_COORDINATE_ONLY_SHEETS) {
    const sheet = workbook.addWorksheet(name);
    sheet.getCell("A1").value = `SYNTHETIC_COORDINATE_ONLY_${name}`;
  }
  const users = workbook.addWorksheet("T_Usuarios");
  users.addRow(["ID_Usuarios", "Nombre", "Contraseña", "Token"]);
  users.addRow(["synthetic-user", authCanary, "synthetic-password-only", "synthetic-token-only"]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("AppSheet archive staging persists a scoped snapshot atomically and replays it unchanged", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const testDatabase = requireTestDatabase();
  const originalEnvironment = Object.fromEntries([
    "DATABASE_URL", "BACKUP_ENCRYPTION_KEY", "PRIVATE_OBJECT_ROOT", "PRIVATE_OBJECT_PROVIDER",
    "PRIVATE_S3_BUCKET", "PRIVATE_OBJECT_IMMUTABLE_WRITES",
  ].map((name) => [name, process.env[name]])) as Record<string, string | undefined>;
  const schema = `bombo_appsheet_stage_${randomUUID().replaceAll("-", "")}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-appsheet-stage-"));
  const privateObjectRoot = join(temporaryRoot, "private-objects");
  let schemaState: Awaited<ReturnType<typeof createSchema>> | undefined;

  try {
    await chmod(temporaryRoot, 0o700);
    await mkdir(privateObjectRoot, { mode: 0o700 });
    await chmod(privateObjectRoot, 0o700);
    schemaState = await createSchema(testDatabase, schema);
    const { base, db, scopedUrl } = schemaState;
    // The migration defines sourceTable as TEXT. Pin only this disposable schema's sort order so the replay regression is independent of the database's default locale.
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacySourceRecord"
      ALTER COLUMN "sourceTable" TYPE TEXT COLLATE "C" USING "sourceTable"::text`);
    const backupDirectory = join(temporaryRoot, "encrypted-backup");
    assert.equal((globalThis as typeof globalThis & { bomboPrisma?: unknown }).bomboPrisma, undefined,
      "the AppSheet archive test must not inherit an application Prisma singleton");
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.BACKUP_ENCRYPTION_KEY = backupEncryptionKey;
    process.env.PRIVATE_OBJECT_ROOT = privateObjectRoot;
    process.env.PRIVATE_OBJECT_PROVIDER = "local";
    process.env.PRIVATE_S3_BUCKET = "";
    process.env.PRIVATE_OBJECT_IMMUTABLE_WRITES = "false";
    appSheetArchiveStage = await import("../server/operations/appsheet-archive-stage.js");
    const { APPSHEET_ARCHIVE_ACTOR, APPSHEET_ARCHIVE_IMPORTER_VERSION, APPSHEET_ARCHIVE_SHEETS,
      APPSHEET_ARCHIVE_SOURCE_SYSTEM, APPSHEET_COORDINATE_ONLY_SHEETS,
      AppSheetArchiveStageError, prepareAppSheetArchiveStage, previewAppSheetArchive, stageAppSheetArchive } = appSheetStage();
    assert.equal(APPSHEET_ARCHIVE_SHEETS.length, 32, "the staged archive contains the 32 business sheets");
    assert.equal(APPSHEET_COORDINATE_ONLY_SHEETS.length, 6, "coordinate-only metadata stays separate from extracted business sheets");

    const backup = await createEncryptedBackup(backupDirectory, {
      DATABASE_URL: scopedUrl.toString(),
      BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
      PRIVATE_OBJECT_ROOT: privateObjectRoot,
      PRIVATE_OBJECT_PROVIDER: "local",
      PRIVATE_S3_BUCKET: "",
      PRIVATE_OBJECT_IMMUTABLE_WRITES: "false",
    });
    assert.equal(backup.code, 0, `the real backup CLI must create the isolated PostgreSQL 18 package: ${safeCliOutput(backup)}`);
    const manifestBytes = await readFile(join(backupDirectory, "manifest.json"));
    const backupManifest = JSON.parse(manifestBytes.toString("utf8")) as {
      databaseMajor: number; databaseVersion: string; encrypted: boolean; schema: string; scope: string; snapshotAt: string;
    };
    const backupManifestHash = createHash("sha256").update(manifestBytes).digest("hex");
    assert.equal(backupManifest.databaseMajor, 18);
    assert.match(backupManifest.databaseVersion, /^18(?:\.|$)/);
    assert.equal(backupManifest.encrypted, true, "the test backup uses only a synthetic ephemeral encryption key");
    assert.equal(backupManifest.schema, schema);
    assert.equal(backupManifest.scope, "confirmed-server-state-only");
    assert.equal((await readFile(join(backupDirectory, "manifest.sha256"), "utf8")).trim(), backupManifestHash);

    const sourceFile = join(temporaryRoot, "fixture-appsheet-archive.xlsx");
    const bytes = await syntheticWorkbook("first", { formulaOnlyRow: true, collationOrderRows: true });
    await writeFile(sourceFile, bytes, { mode: 0o600 });
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const manifest = fixtureManifest(fileHash, true, true);
    const coordinateCoverage = fixtureCoordinateCoverage(fileHash);
    const prepared = await prepareAppSheetArchiveStage({
      filePath: sourceFile,
      manifestValue: manifest,
      coordinateCoverageValue: coordinateCoverage,
    });

    assert.equal(prepared.snapshot.fileHash, fileHash);
    assert.equal(prepared.snapshot.sourceSystem, APPSHEET_ARCHIVE_SOURCE_SYSTEM);
    assert.equal(prepared.snapshot.importerVersion, APPSHEET_ARCHIVE_IMPORTER_VERSION);
    assert.equal(prepared.snapshot.sheets.length, 32);
    assert.equal(prepared.records.length, 5);
    assert.deepEqual(prepared.records.map((record) => [record.sourceTable, record.sourceKey, record.treatment]), [
      ["C_Cliente", "0", "archive_only"],
      ["D_Catalogo_Mercaderia", "synthetic:D_Catalogo_Mercaderia!A2", "archive_only"],
      ["Movimiento_Nueva", "movimiento-sintético-first", "archive_only"],
      ["C_gastos_operacion", "gasto-sintético-first", "archive_only"],
      ["C_Mercaderia", "mercadería-sintética-first", "archive_only"],
    ]);
    const zeroCustomer = prepared.records.find((record) => record.sourceTable === "C_Cliente")!;
    assert.equal(zeroCustomer.normalized.columns.find((column) => column.header === "Monto")?.value, "0");
    assert.equal(zeroCustomer.normalized.columns.find((column) => column.header === "Monto")?.moneyMinorUnits, "0");
    const formulaOnlyRecord = prepared.records.find((record) => record.sourceTable === "D_Catalogo_Mercaderia")!;
    const formulaSource = formulaOnlyRecord.original.columns.find((column) => column.coordinate === "B2")?.value as {
      kind?: string; value?: { kind?: string; formula?: string | null; cachedResult?: unknown }; xml?: { formula?: unknown; valuePresent?: boolean };
    };
    assert.equal(formulaOnlyRecord.sourceRow, 2, "the source formula-only row follows the header at raw row 2");
    assert.equal(formulaSource.kind, "source_xml_cell");
    assert.equal(formulaSource.xml?.formula !== null && formulaSource.xml?.formula !== undefined, true);
    assert.equal(formulaSource.xml?.valuePresent, false, "the source XML has a formula definition without a cached <v>");
    assert.equal(formulaSource.value?.kind, "formula");
    assert.equal(formulaSource.value?.formula, "1+1");
    assert.equal(formulaSource.value?.cachedResult, null);
    assert.equal(formulaOnlyRecord.normalized.columns.find((column) => column.coordinate === "B2")?.value, null,
      "an uncached formula is preserved as source evidence without inferring a canonical value");
    assert.equal(formulaOnlyRecord.exceptions.some((exception) => exception.kind === "missing_source_key"), true);
    assert.equal(formulaOnlyRecord.exceptions.some((exception) => exception.kind === "formula_without_cached_result"), true);
    assert.deepEqual(prepared.snapshot.summary.recordsByTreatment, { fact_candidate: 0, archive_only: 5, overlap_evidence: 0 });
    assert.equal(prepared.snapshot.summary.keyedRecordCount, 4);
    assert.equal(JSON.stringify(prepared).includes(authCanary), false, "the excluded T_Usuarios auth canary must not enter prepared data");
    assert.equal(prepared.metrics.recordCount, 5);
    assert.equal(prepared.metrics.exceptionCount, 2);
    assert.equal(prepared.metrics.quarantinedRecordCount, 0);
    assert.equal(prepared.metrics.unlabeledRowsOmitted, 0);
    assert.equal(prepared.metrics.formulaOnlyRows, 1);
    assert.equal(prepared.metrics.formulaWithoutCachedResultCells, 1);
    const preview = previewAppSheetArchive(prepared);
    assert.equal(preview.status, "preview");
    assert.equal(preview.recordCount, 5);
    assert.equal(preview.formulaOnlyRows, 1, "preview counts formula definitions even when the cached result is absent");
    assert.equal(preview.formulaWithoutCachedResultCells, 1);
    assert.deepEqual(prepared.coordinateCoverage.sheets.map((sheet) => [sheet.name, sheet.extracted]),
      APPSHEET_COORDINATE_ONLY_SHEETS.map((name) => [name, false]));
    const selectedSheets = (prepared.coverage as { selectedSheets: Array<{ name: string }> }).selectedSheets;
    assert.equal(selectedSheets.some((sheet) => sheet.name === "T_Usuarios"), false);

    const credentialFile = join(temporaryRoot, "fixture-appsheet-archive-credential-header.xlsx");
    const credentialBytes = await syntheticWorkbook("credential-header", { credentialHeaderOnBusinessSheet: true });
    await writeFile(credentialFile, credentialBytes, { mode: 0o600 });
    const credentialHash = createHash("sha256").update(credentialBytes).digest("hex");
    const beforeCredentialHeader = await operationState(db);
    await assert.rejects(
      prepareAppSheetArchiveStage({
        filePath: credentialFile,
        manifestValue: fixtureManifest(credentialHash),
        coordinateCoverageValue: fixtureCoordinateCoverage(credentialHash),
      }),
      (error: unknown) => error instanceof AppSheetArchiveStageError && error.code === "credential_header_detected",
      "an included business sheet with a credential-bearing header must fail closed",
    );
    assert.deepEqual(await operationState(db), beforeCredentialHeader, "a rejected credential header must not write any database state");

    const beforeMismatch = await operationState(db);
    const mismatchedManifest = structuredClone(manifest);
    mismatchedManifest.sheets.find((sheet) => sheet.name === "C_Cliente")!.recordCount++;
    await assert.rejects(
      prepareAppSheetArchiveStage({ filePath: sourceFile, manifestValue: mismatchedManifest, coordinateCoverageValue: coordinateCoverage }),
      (error: unknown) => error instanceof AppSheetArchiveStageError && error.code === "control_record_count_mismatch",
      "independent count mismatch must fail before staging",
    );
    assert.deepEqual(await operationState(db), beforeMismatch, "a rejected control manifest must not write any database state");

    const beforeStage = await operationState(db);
    const staged = await stageAppSheetArchive(prepared, { backupReference: backupDirectory });
    assert.deepEqual({
      snapshotId: staged.snapshotId,
      sourceSystem: staged.sourceSystem,
      importerVersion: staged.importerVersion,
      sheetCount: staged.sheetCount,
      recordCount: staged.recordCount,
      exceptionCount: staged.exceptionCount,
      quarantinedRecordCount: staged.quarantinedRecordCount,
      unlabeledRowsOmitted: staged.unlabeledRowsOmitted,
      formulaOnlyRows: staged.formulaOnlyRows,
      formulaWithoutCachedResultCells: staged.formulaWithoutCachedResultCells,
      status: staged.status,
      backupManifestHash: staged.backupManifestHash,
    }, {
      snapshotId: prepared.snapshotId,
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
      sheetCount: 32,
      recordCount: 5,
      exceptionCount: 2,
      quarantinedRecordCount: 0,
      unlabeledRowsOmitted: 0,
      formulaOnlyRows: 1,
      formulaWithoutCachedResultCells: 1,
      status: "staged",
      backupManifestHash,
    });

    const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: staged.snapshotId } });
    assert.ok(snapshot);
    assert.equal(JSON.stringify(snapshot).includes(authCanary), false);
    assert.equal(snapshot.status, "staged");
    assert.equal(snapshot.sourceSystem, APPSHEET_ARCHIVE_SOURCE_SYSTEM);
    assert.equal(snapshot.importerVersion, APPSHEET_ARCHIVE_IMPORTER_VERSION);
    assert.equal(snapshot.createdBy, APPSHEET_ARCHIVE_ACTOR);
    assert.equal(snapshot.reviewedBy, null);
    assert.equal(snapshot.reviewedAt, null);
    const stageControls = (snapshot.controls as { appSheetBusinessArchive?: Record<string, unknown> }).appSheetBusinessArchive;
    assert.ok(stageControls);
    assert.equal(stageControls.sourceSystem, APPSHEET_ARCHIVE_SOURCE_SYSTEM);
    assert.equal(stageControls.importerVersion, APPSHEET_ARCHIVE_IMPORTER_VERSION);
    assert.equal(stageControls.actor, APPSHEET_ARCHIVE_ACTOR);
    assert.equal(stageControls.status, "staged");
    assert.equal(stageControls.reviewedBy, null);
    assert.equal(stageControls.reviewedAt, null);
    assert.equal(stageControls.recordCount, 5);
    assert.equal(stageControls.exceptionCount, 2);
    assert.equal(stageControls.formulaOnlyRows, 1);
    assert.equal(stageControls.formulaWithoutCachedResultCells, 1);
    assert.equal(stageControls.backupManifestHash, backupManifestHash);

    const persistedRecords = await db.legacySourceRecord.findMany({
      where: { snapshotId: staged.snapshotId },
      orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }],
    });
    assert.equal(persistedRecords.length, 5);
    assert.deepEqual(persistedRecords.map((record) => [record.sourceTable, record.sourceKey, record.treatment]), [
      ["C_Cliente", "0", "archive_only"],
      ["C_Mercaderia", "mercadería-sintética-first", "archive_only"],
      ["C_gastos_operacion", "gasto-sintético-first", "archive_only"],
      ["D_Catalogo_Mercaderia", "synthetic:D_Catalogo_Mercaderia!A2", "archive_only"],
      ["Movimiento_Nueva", "movimiento-sintético-first", "archive_only"],
    ]);
    const persistedFormulaOnly = persistedRecords.find((record) => record.sourceTable === "D_Catalogo_Mercaderia")!;
    assert.equal(persistedFormulaOnly.treatment, "archive_only");
    assert.equal((persistedFormulaOnly.original as { columns: Array<{ coordinate: string; value: unknown }> }).columns
      .find((column) => column.coordinate === "B2")?.value !== undefined, true);
    assert.equal((persistedFormulaOnly.normalized as { columns: Array<{ coordinate: string; value: unknown }> }).columns
      .find((column) => column.coordinate === "B2")?.value, null);
    assert.equal(persistedRecords[0]?.sourceRow, 2);
    assert.equal(persistedRecords[1]?.sourceRow, 2);
    assert.equal(JSON.stringify(persistedRecords).includes(authCanary), false);
    assert.equal(await db.legacyException.count({ where: { snapshotId: staged.snapshotId } }), 2);
    const operationObject = await db.operationObject.findUnique({ where: { id: staged.snapshotId } });
    assert.ok(operationObject, "a staged archive must be a real reviewable OperationObject");
    assert.deepEqual({ id: operationObject.id, kind: operationObject.kind, version: operationObject.version, createdBy: operationObject.createdBy }, {
      id: staged.snapshotId,
      kind: "legacyImport",
      version: 0,
      createdBy: APPSHEET_ARCHIVE_ACTOR,
    });
    const audits = await db.operationAudit.findMany({ where: { objectId: staged.snapshotId } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, "legacy.appsheet_business_archive_staged");
    assert.equal(audits[0]?.actorId, APPSHEET_ARCHIVE_ACTOR);
    const auditDetails = audits[0]?.details as Record<string, unknown>;
    assert.deepEqual(auditDetails, {
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
      fileHash,
      controlManifestHash: prepared.controlManifestHash,
      coordinateCoverageHash: prepared.coordinateCoverageHash,
      rowManifestHash: prepared.rowManifestHash,
      backupManifestHash,
      backupSnapshotAt: backupManifest.snapshotAt,
      recordCount: 5,
      exceptionCount: 2,
      quarantinedRecordCount: 0,
      unlabeledRowsOmitted: 0,
      formulaOnlyRows: 1,
      formulaWithoutCachedResultCells: 1,
      status: "staged",
      reviewedBy: null,
    });
    assert.equal(await db.commandReceipt.count({ where: { targetId: staged.snapshotId } }), 0);
    assert.equal(await db.legacyHistoricalFact.count({ where: { snapshotId: staged.snapshotId } }), 0);
    assert.equal(await db.legacyHistoryPublication.count({ where: { snapshotId: staged.snapshotId } }), 0);
    const afterStage = await operationState(db);
    assert.equal(afterStage.snapshots, beforeStage.snapshots + 1);
    assert.equal(afterStage.records, beforeStage.records + 5);
    assert.equal(afterStage.exceptions, beforeStage.exceptions + 2);
    assert.equal(afterStage.operationObjects, beforeStage.operationObjects + 1);
    assert.equal(afterStage.audits, beforeStage.audits + 1);
    assert.equal(afterStage.commandReceipts, beforeStage.commandReceipts);
    assert.equal(afterStage.ledgerEvents, beforeStage.ledgerEvents);
    assert.equal(afterStage.ledgerLegs, beforeStage.ledgerLegs);
    assert.equal(afterStage.historicalFacts, beforeStage.historicalFacts);
    assert.equal(afterStage.historyPublications, beforeStage.historyPublications);

    const beforeRepeat = await operationState(db);
    const repeated = await stageAppSheetArchive(prepared, { backupReference: backupDirectory });
    assert.equal(repeated.status, "already-staged");
    assert.equal(repeated.snapshotId, staged.snapshotId);
    assert.equal(repeated.rowManifestHash, staged.rowManifestHash);
    assert.equal(repeated.backupManifestHash, staged.backupManifestHash);
    assert.deepEqual(await operationState(db), beforeRepeat, "an idempotent replay must not append or rewrite staged state");

    const snapshotBeforeControlTamper = await db.legacyImportSnapshot.findUnique({
      where: { id: staged.snapshotId },
      select: { controls: true },
    });
    assert.ok(snapshotBeforeControlTamper);
    const originalControls = structuredClone(snapshotBeforeControlTamper.controls);
    const tamperedControls = structuredClone(originalControls) as unknown as {
      appSheetBusinessArchive?: {
        controlManifestHash?: unknown;
        controlManifest?: { sheets?: Array<{ name?: string; recordCount?: number }> };
      };
    };
    const tamperedArchiveControls = tamperedControls.appSheetBusinessArchive;
    assert.ok(tamperedArchiveControls);
    assert.equal(tamperedArchiveControls.controlManifestHash, prepared.controlManifestHash);
    const firstControlSheet = tamperedArchiveControls.controlManifest?.sheets?.[0];
    assert.ok(firstControlSheet);
    assert.equal(firstControlSheet.name, "C_Cliente");
    const originalControlCount = firstControlSheet.recordCount;
    assert.equal(originalControlCount, 1);
    assert.ok(typeof originalControlCount === "number");
    firstControlSheet.recordCount = originalControlCount + 1;
    assert.equal(tamperedArchiveControls.controlManifestHash, prepared.controlManifestHash,
      "the scalar manifest hash stays unchanged while its stored semantic content is altered");
    const beforeImmutableControlsUpdate = await operationState(db);
    await assert.rejects(
      db.legacyImportSnapshot.update({
        where: { id: staged.snapshotId },
        data: { controls: tamperedControls as Prisma.InputJsonValue },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("23514") &&
        error.message.includes("Snapshot source and capture linkage are immutable"),
      "the database must reject changes to captured snapshot controls",
    );
    const snapshotAfterBlockedControlUpdate = await db.legacyImportSnapshot.findUnique({
      where: { id: staged.snapshotId },
      select: { controls: true },
    });
    assert.deepEqual(snapshotAfterBlockedControlUpdate?.controls, originalControls,
      "the rejected mutation must leave the snapshot controls unchanged");
    assert.deepEqual(await operationState(db), beforeImmutableControlsUpdate,
      "rejecting a control mutation must not change staged state");

    const writeSnapshotControlsWithTestBypass = async (controls: Prisma.InputJsonValue) => {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacyImportSnapshot" DISABLE TRIGGER "LegacyImportSnapshot_source_capture_immutable"`);
        try {
          await tx.legacyImportSnapshot.update({ where: { id: staged.snapshotId }, data: { controls } });
        } finally {
          await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacyImportSnapshot" ENABLE TRIGGER "LegacyImportSnapshot_source_capture_immutable"`);
        }
      });
      const triggerState = await db.$queryRaw<Array<{ tgenabled: string }>>`
        SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'LegacyImportSnapshot_source_capture_immutable'
          AND tgrelid = to_regclass(quote_ident(${schema}) || '.' || quote_ident('LegacyImportSnapshot'))
          AND NOT tgisinternal
      `;
      assert.deepEqual(triggerState.map(({ tgenabled }) => tgenabled), ["O"],
        "the test-only bypass must leave the immutable trigger enabled");
    };
    await writeSnapshotControlsWithTestBypass(tamperedControls as Prisma.InputJsonValue);
    const persistedTamperedSnapshot = await db.legacyImportSnapshot.findUnique({
      where: { id: staged.snapshotId },
      select: { controls: true },
    });
    assert.deepEqual(persistedTamperedSnapshot?.controls, tamperedControls,
      "the replay test must start from the altered persisted control JSON");
    const beforeTamperedReplay = await operationState(db);
    await assert.rejects(
      stageAppSheetArchive(prepared, { backupReference: backupDirectory }),
      (error: unknown) => error instanceof AppSheetArchiveStageError && error.code === "existing_snapshot_mismatch",
      "replay must reject altered control manifest content even when its stored scalar hash is unchanged",
    );
    assert.deepEqual(await operationState(db), beforeTamperedReplay,
      "rejecting altered replay controls must not create or append staged state");
    const controlsAfterRejectedReplay = await db.legacyImportSnapshot.findUnique({
      where: { id: staged.snapshotId },
      select: { controls: true },
    });
    assert.deepEqual(controlsAfterRejectedReplay?.controls, tamperedControls,
      "the rejected replay must leave the pre-existing altered snapshot untouched");

    await writeSnapshotControlsWithTestBypass(originalControls as Prisma.InputJsonValue);
    const restoredSnapshot = await db.legacyImportSnapshot.findUnique({
      where: { id: staged.snapshotId },
      select: { controls: true },
    });
    assert.deepEqual(restoredSnapshot?.controls, originalControls,
      "the disposable fixture must be restored before the remaining replay assertions");
    const afterControlRestore = await operationState(db);
    assert.deepEqual(afterControlRestore, beforeTamperedReplay,
      "restoring the fixture controls must not create staged state");
    const replayAfterControlRestore = await stageAppSheetArchive(prepared, { backupReference: backupDirectory });
    assert.equal(replayAfterControlRestore.status, "already-staged");
    assert.deepEqual(await operationState(db), afterControlRestore);

    const beforeImmutableUpdate = await operationState(db);
    const originalContentHash = persistedRecords[0]!.contentHash;
    await assert.rejects(
      db.legacySourceRecord.update({
        where: { id: persistedRecords[0]!.id },
        data: { contentHash: "0".repeat(64) },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("23514") &&
        error.message.includes("Source evidence is immutable; resolutions are separate"),
      "the database must reject an update to immutable source evidence",
    );
    const recordAfterBlockedUpdate = await db.legacySourceRecord.findUnique({
      where: { id: persistedRecords[0]!.id },
      select: { contentHash: true },
    });
    assert.equal(recordAfterBlockedUpdate?.contentHash, originalContentHash);
    assert.deepEqual(await operationState(db), beforeImmutableUpdate);
    const replayAfterBlockedUpdate = await stageAppSheetArchive(prepared, { backupReference: backupDirectory });
    assert.equal(replayAfterBlockedUpdate.status, "already-staged");
    assert.deepEqual(await operationState(db), beforeImmutableUpdate);

    const rollbackBytes = await syntheticWorkbook("rollback");
    const rollbackFile = join(temporaryRoot, "fixture-appsheet-archive-rollback.xlsx");
    await writeFile(rollbackFile, rollbackBytes, { mode: 0o600 });
    const rollbackHash = createHash("sha256").update(rollbackBytes).digest("hex");
    const rollbackPrepared = await prepareAppSheetArchiveStage({
      filePath: rollbackFile,
      manifestValue: fixtureManifest(rollbackHash),
      coordinateCoverageValue: fixtureCoordinateCoverage(rollbackHash),
    });
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_archive_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'synthetic late audit rejection'; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_archive_audit BEFORE INSERT ON "${schema}"."OperationAudit"
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_archive_audit()`);
    const beforeRollback = await operationState(db);
    await assert.rejects(
      stageAppSheetArchive(rollbackPrepared, { backupReference: backupDirectory }),
      (error: unknown) => error instanceof AppSheetArchiveStageError && error.code === "stage_transaction_failed",
      "a late database trigger rejection must fail the staging transaction",
    );
    assert.deepEqual(await operationState(db), beforeRollback, "a late database trigger rejection must roll back all archive state");
    assert.equal(await db.legacyImportSnapshot.count({ where: { id: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.legacySourceRecord.count({ where: { snapshotId: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.legacyException.count({ where: { snapshotId: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.operationObject.count({ where: { id: rollbackPrepared.snapshotId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { objectId: rollbackPrepared.snapshotId } }), 0);
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) restoreEnvironment(name, value);
    if (schemaState) {
      try { await schemaState.base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally {
        await schemaState.db.$disconnect();
        await schemaState.base.$disconnect();
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
