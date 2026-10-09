import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
  AppSheetCanonicalError,
  appSheetAppliedDefinitionHash,
  appSheetCanonicalProjectionReport,
  prepareAppSheetDefinitionInventory,
  prepareAppSheetMasterProjection,
  stageAppSheetCanonicalMasters,
} from "../server/operations/appsheet-canonical.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION } from "../shared/operations/appsheet-canonical.js";
import { AppSheetHistoryStageError, loadAppSheetHistoryCapture } from "../server/operations/appsheet-history.js";
import { requireAppSheetTechnicalReview } from "../shared/operations/appsheet-review.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { verifyBackupReference } from "../server/operations/financial-source-stage.js";

const PRIVATE_DIR = ".local/appsheet-real-20261009";
const DEFAULT_DEFINITION = "appsheet-definition-inventory-1.001739-v2.json";
const MAX_DEFINITION_BYTES = 32 * 1024 * 1024;

interface CliOptions {
  captureDirectory: string;
  definitionPath: string;
  expectedAppId: string;
  reviewPath: string | null;
  actorId: string | null;
  backupReference: string | null;
  target: "isolated-test" | "production";
  allowStagedDelta: boolean;
  refreshPreliminary: boolean;
  apply: boolean;
}

function usage(): string {
  return [
    "Uso: tsx scripts/appsheet-canonical.ts [--capture-dir <directorio>] --definition <inventory privado>",
    "       [--expected-app-id <id>] [--allow-staged-delta] [--refresh-preliminary] [--apply --target isolated-test|production --actor-id <id> --review <JSON privado>]",
    "       [--backup-reference <respaldo verificado>] sólo junto a --target production.",
    "Preview es el comportamiento predeterminado. --allow-staged-delta crea sólo una derivación bloqueada para cutover.",
    "Apply exige revisión técnica independiente ligada a target y fingerprint no secreto de base/schema; v1 sólo vale en isolated-test.",
    "El fingerprint omite credenciales y opciones TLS; isolated-test usa TEST_DATABASE_URL loopback bombo_ui_* y production exige DATABASE_URL y respaldo verificado.",
    "--refresh-preliminary sólo permite actualizar maestros con identidad sin aprobar y última proyección staged sin revisión ni cambios manuales.",
  ].join("\n");
}

function parseArgs(args: string[], workingDirectory: string): CliOptions | "help" {
  const options: CliOptions = {
    captureDirectory: resolve(workingDirectory, PRIVATE_DIR),
    definitionPath: resolve(workingDirectory, PRIVATE_DIR, DEFAULT_DEFINITION),
    expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID,
    reviewPath: null,
    actorId: null,
    backupReference: null,
    target: "isolated-test",
    allowStagedDelta: false,
    refreshPreliminary: false,
    apply: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--allow-staged-delta" || argument === "--refresh-preliminary" || argument === "--apply") {
      if (seen.has(argument)) throw new AppSheetCanonicalError("duplicate_argument");
      seen.add(argument);
      if (argument === "--allow-staged-delta") options.allowStagedDelta = true;
      else if (argument === "--refresh-preliminary") options.refreshPreliminary = true;
      else options.apply = true;
      continue;
    }
    if (!["--capture-dir", "--definition", "--expected-app-id", "--review", "--actor-id", "--target", "--backup-reference"].includes(argument))
      throw new AppSheetCanonicalError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetCanonicalError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetCanonicalError("argument_value_required");
    if (argument === "--capture-dir") options.captureDirectory = resolve(workingDirectory, value);
    else if (argument === "--definition") options.definitionPath = resolve(workingDirectory, value);
    else if (argument === "--expected-app-id") options.expectedAppId = value;
    else if (argument === "--review") options.reviewPath = resolve(workingDirectory, value);
    else if (argument === "--actor-id") options.actorId = value;
    else if (argument === "--target") {
      if (value !== "isolated-test" && value !== "production") throw new AppSheetCanonicalError("target_invalid");
      options.target = value;
    } else options.backupReference = value;
  }
  const expectedCaptureDirectory = resolve(workingDirectory, PRIVATE_DIR);
  if (options.captureDirectory !== expectedCaptureDirectory) throw new AppSheetCanonicalError("private_capture_directory_required");
  if (options.expectedAppId !== APPSHEET_EXPECTED_LIVE_APP_ID) throw new AppSheetCanonicalError("expected_live_app_id_mismatch");
  if (options.apply && (!options.reviewPath || !options.actorId)) throw new AppSheetCanonicalError("apply_review_and_actor_required");
  if (!options.apply && (options.reviewPath || options.actorId)) throw new AppSheetCanonicalError("review_and_actor_require_apply");
  if (options.refreshPreliminary && !options.apply) throw new AppSheetCanonicalError("refresh_preliminary_requires_apply");
  if (options.target === "production" && (!options.apply || !options.backupReference)) throw new AppSheetCanonicalError("production_apply_and_backup_required");
  if (options.target === "isolated-test" && options.backupReference) throw new AppSheetCanonicalError("backup_reference_requires_production_target");
  return options;
}

function privateChildPath(value: string, privateDirectory: string, workingDirectory: string): string {
  const absolute = resolve(workingDirectory, value);
  const pathFromPrivate = relative(privateDirectory, absolute);
  if (!pathFromPrivate || pathFromPrivate === ".." || pathFromPrivate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromPrivate))
    throw new AppSheetCanonicalError("private_path_required");
  if (pathFromPrivate.includes("/") || pathFromPrivate.includes("\\")) throw new AppSheetCanonicalError("private_direct_child_required");
  return absolute;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700)
    throw new AppSheetCanonicalError("private_directory_permissions_invalid");
}

async function readPrivateJson<T = unknown>(pathValue: string, privateDirectory: string, workingDirectory: string, maxBytes: number): Promise<T> {
  const path = privateChildPath(pathValue, privateDirectory, workingDirectory);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 || (before.mode & 0o400) === 0 ||
      before.size <= 0 || before.size > maxBytes) throw new AppSheetCanonicalError("private_file_invalid");
  const bytes = await readFile(path);
  const after = await lstat(path).catch(() => null);
  if (bytes.byteLength !== before.size || !after?.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new AppSheetCanonicalError("private_file_changed_during_read");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new AppSheetCanonicalError("private_json_invalid");
  }
}

function requireTestDatabaseUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new AppSheetCanonicalError("isolated_test_database_required");
  let testUrl: URL;
  try { testUrl = new URL(raw); } catch { throw new AppSheetCanonicalError("test_database_url_invalid"); }
  if (!["postgres:", "postgresql:"].includes(testUrl.protocol)) throw new AppSheetCanonicalError("test_database_must_be_postgres");
  const host = testUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!(host === "localhost" || host === "::1" || host.startsWith("127."))) throw new AppSheetCanonicalError("test_database_must_be_loopback");
  if (!/^\/bombo_ui_[a-z0-9_-]+$/i.test(testUrl.pathname)) throw new AppSheetCanonicalError("dedicated_test_database_required");
  const configuredUrl = process.env.DATABASE_URL;
  if (configuredUrl) {
    let appUrl: URL;
    try { appUrl = new URL(configuredUrl); } catch { throw new AppSheetCanonicalError("configured_database_url_invalid"); }
    const target = (url: URL) => {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const normalizedHost = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.") ? "loopback" : hostname;
      return JSON.stringify([normalizedHost, url.port || "5432", decodeURIComponent(url.pathname.slice(1))]);
    };
    if (target(testUrl) === target(appUrl)) throw new AppSheetCanonicalError("test_database_matches_application_database");
  }
  return testUrl;
}

function requireProductionDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new AppSheetCanonicalError("canonical_database_url_required");
  let target: URL;
  try { target = new URL(raw); } catch { throw new AppSheetCanonicalError("canonical_database_url_invalid"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol)) throw new AppSheetCanonicalError("canonical_database_must_be_postgres");
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127."))
    throw new AppSheetCanonicalError("production_database_must_not_be_loopback");
  const testValue = process.env.TEST_DATABASE_URL;
  if (testValue) {
    let test: URL;
    try { test = new URL(testValue); } catch { throw new AppSheetCanonicalError("test_database_url_invalid"); }
    const targetKey = (url: URL) => [url.hostname.toLowerCase(), url.port || "5432", decodeURIComponent(url.pathname.slice(1))].join("\0");
    if (targetKey(target) === targetKey(test)) throw new AppSheetCanonicalError("production_database_matches_test_database");
  }
  return target;
}

function readGitState(workingDirectory: string): { commitSha: string; clean: boolean } {
  try {
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("invalid sha");
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: workingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return { commitSha, clean: status.trim().length === 0 };
  } catch {
    throw new AppSheetCanonicalError("git_commit_state_unavailable");
  }
}

async function run(args: string[], workingDirectory = process.cwd()): Promise<{ code: number; output: string }> {
  let options: CliOptions | "help";
  try { options = parseArgs(args, workingDirectory); }
  catch (error) {
    return { code: 2, output: JSON.stringify({ status: "error", code: error instanceof AppSheetCanonicalError ? error.code : "invalid_arguments" }) };
  }
  if (options === "help") return { code: 0, output: usage() };

  const privateDirectory = resolve(workingDirectory, PRIVATE_DIR);
  try {
    const initialGitState = readGitState(workingDirectory);
    if (options.apply && !initialGitState.clean) throw new AppSheetCanonicalError("apply_requires_clean_committed_worktree");
    await assertPrivateDirectory(privateDirectory);
    const loaded = await loadAppSheetHistoryCapture(options.captureDirectory, { allowStagedDelta: options.allowStagedDelta });
    const rawDefinition = await readPrivateJson(options.definitionPath, privateDirectory, workingDirectory, MAX_DEFINITION_BYTES);
    const definitionInventory = prepareAppSheetDefinitionInventory(rawDefinition, options.expectedAppId);
    const projection = prepareAppSheetMasterProjection({
      manifest: loaded.manifest,
      headers: loaded.headers,
      pages: loaded.pages,
      definitionInventory,
      mode: loaded.mode,
    }, {
      allowStagedDelta: options.allowStagedDelta,
      expectedAppId: options.expectedAppId,
    });
    const configuredTargetUrl = options.target === "isolated-test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
    let previewDestinationIdentity: string | null = null;
    if (configuredTargetUrl) {
      const previewDatabaseUrl = options.target === "isolated-test" ? requireTestDatabaseUrl() : requireProductionDatabaseUrl();
      try { previewDestinationIdentity = appSheetDatabaseDestinationIdentity(options.target, previewDatabaseUrl); }
      catch { throw new AppSheetCanonicalError("database_target_identity_invalid"); }
    }
    const report = {
      ...appSheetCanonicalProjectionReport(projection),
      commitSha: initialGitState.commitSha,
      target: options.target,
      destinationIdentity: previewDestinationIdentity,
      destinationIdentityState: previewDestinationIdentity ? "derived-from-config" : "target-database-not-configured",
      expectedAppId: projection.expectedAppId,
      definitionIdentityState: projection.definitionIdentityState,
      definition: {
        sourceSha256: definitionInventory.source.sha256,
        descriptorSha256: definitionInventory.descriptorSha256,
        appliedDefinitionHash: appSheetAppliedDefinitionHash(definitionInventory),
        appId: definitionInventory.app.id,
        declaredCounts: definitionInventory.declaredCounts,
        observedCounts: definitionInventory.observedCounts,
      },
      cutoverEligible: projection.capture.stabilityMode === "stable" && projection.definitionIdentityState === "verified" && projection.summary.globalDeltaBlockingCount === 0,
    };
    if (!options.apply) return { code: 0, output: JSON.stringify(report) };

    let databaseUrl: URL;
    let backupEvidence: { manifestHash: string; snapshotAt: string } | undefined;
    if (options.target === "production") {
      databaseUrl = requireProductionDatabaseUrl();
      try { backupEvidence = await verifyBackupReference(options.backupReference!); }
      catch { throw new AppSheetCanonicalError("verified_production_backup_required"); }
    } else databaseUrl = requireTestDatabaseUrl();
    let destinationIdentity: string;
    try { destinationIdentity = appSheetDatabaseDestinationIdentity(options.target, databaseUrl); }
    catch { throw new AppSheetCanonicalError("database_target_identity_invalid"); }
    const reviewValue = await readPrivateJson(options.reviewPath!, privateDirectory, workingDirectory, 1_000_000);
    const review = requireAppSheetTechnicalReview(reviewValue, {
      captureId: projection.capture.captureId,
      manifestHash: projection.capture.manifestHash,
      definitionHash: projection.appliedDefinitionHash,
      projectionKind: "masters",
      projectionHash: projection.projectionHash,
      commitSha: initialGitState.commitSha,
      importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
      target: options.target,
      destinationIdentity,
    });
    const finalGitState = readGitState(workingDirectory);
    if (!finalGitState.clean || finalGitState.commitSha !== initialGitState.commitSha)
      throw new AppSheetCanonicalError("apply_commit_state_changed");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    try {
      const staged = await stageAppSheetCanonicalMasters(projection, {
        actorId: options.actorId!, technicalReview: review, allowStagedDelta: options.allowStagedDelta,
        refreshPreliminary: options.refreshPreliminary,
        commitSha: finalGitState.commitSha,
        target: options.target,
        destinationIdentity,
        backupEvidence,
      }, db);
      return { code: 0, output: JSON.stringify({ ...report, destinationIdentity, status: staged.status, replay: staged.replay, snapshotId: staged.snapshotId }) };
    } finally {
      await db.$disconnect();
    }
  } catch (error) {
    const code = error instanceof AppSheetCanonicalError || error instanceof AppSheetHistoryStageError
      ? error.code : "canonical_stage_failed";
    return { code: 1, output: JSON.stringify({ status: "error", code }) };
  }
}

export {
  parseArgs, privateChildPath, readPrivateJson, requireTestDatabaseUrl, requireProductionDatabaseUrl, readGitState,
  run as runAppSheetCanonicalCli,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.code;
}
