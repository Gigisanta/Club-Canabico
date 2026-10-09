import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
  AppSheetCanonicalError,
  appSheetAppliedDefinitionHash,
  prepareAppSheetDefinitionInventory,
} from "../server/operations/appsheet-canonical.js";
import {
  AppSheetHistoryStageError,
  appSheetHistoryProjectionReport,
  loadAppSheetHistoryCapture,
  loadAppSheetHistoryDefinition,
  prepareAppSheetHistoryProjection,
  stageAppSheetHistoryProjection,
} from "../server/operations/appsheet-history.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION } from "../shared/operations/appsheet-history.js";
import { requireAppSheetTechnicalReview } from "../shared/operations/appsheet-review.js";
import { verifyBackupReference } from "../server/operations/financial-source-stage.js";

const PRIVATE_DIR = ".local/appsheet-real-20261009";
const DEFAULT_DEFINITION = "appsheet-definition-inventory-1.001739-v2.json";
const MAX_REVIEW_BYTES = 1_000_000;

export interface AppSheetHistoryCliOptions {
  captureDirectory: string;
  definitionPath: string;
  reviewPath: string | null;
  actorId: string | null;
  backupReference: string | null;
  target: "isolated" | "production";
  allowStagedDelta: boolean;
  apply: boolean;
}

export function appSheetHistoryCliUsage(): string {
  return [
    "Uso: tsx scripts/appsheet-history.ts [--capture-dir <directorio privado>] [--definition <inventario privado>] [--allow-staged-delta]",
    "       [--apply --target isolated|production --actor-id <admin existente> --review <JSON privado> --backup-reference <respaldo verificado>]",
    "Preview es el modo predeterminado y no requiere ni abre una base de datos.",
    "La captura actual es preliminar: requiere --allow-staged-delta y nunca habilita corte ni publicación.",
    "Apply requiere una revisión técnica independiente vinculada al commit limpio y un respaldo verificado del destino.",
  ].join("\n");
}

export function parseAppSheetHistoryCliArgs(args: string[], workingDirectory = process.cwd()): AppSheetHistoryCliOptions | "help" {
  const options: AppSheetHistoryCliOptions = {
    captureDirectory: resolve(workingDirectory, PRIVATE_DIR),
    definitionPath: resolve(workingDirectory, PRIVATE_DIR, DEFAULT_DEFINITION),
    reviewPath: null,
    actorId: null,
    backupReference: null,
    target: "isolated",
    allowStagedDelta: false,
    apply: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--allow-staged-delta" || argument === "--apply") {
      if (seen.has(argument)) throw new AppSheetHistoryStageError("duplicate_argument");
      seen.add(argument);
      if (argument === "--allow-staged-delta") options.allowStagedDelta = true;
      else options.apply = true;
      continue;
    }
    if (!["--capture-dir", "--definition", "--review", "--actor-id", "--target", "--backup-reference"].includes(argument))
      throw new AppSheetHistoryStageError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetHistoryStageError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetHistoryStageError("argument_value_required");
    if (argument === "--capture-dir") options.captureDirectory = resolve(workingDirectory, value);
    else if (argument === "--definition") options.definitionPath = resolve(workingDirectory, value);
    else if (argument === "--review") options.reviewPath = resolve(workingDirectory, value);
    else if (argument === "--actor-id") options.actorId = value;
    else if (argument === "--target") {
      if (value !== "isolated" && value !== "production") throw new AppSheetHistoryStageError("target_invalid");
      options.target = value;
    } else options.backupReference = value;
  }
  if (options.captureDirectory !== resolve(workingDirectory, PRIVATE_DIR))
    throw new AppSheetHistoryStageError("private_capture_directory_required");
  if (options.apply && (!options.reviewPath || !options.actorId || !options.backupReference))
    throw new AppSheetHistoryStageError("apply_review_actor_and_backup_required");
  if (!options.apply && (options.reviewPath || options.actorId || options.backupReference))
    throw new AppSheetHistoryStageError("review_actor_and_backup_require_apply");
  return options;
}

export function privateAppSheetChildPath(value: string, privateDirectory: string, workingDirectory = process.cwd()): string {
  const absolute = resolve(workingDirectory, value);
  const pathFromPrivate = relative(privateDirectory, absolute);
  if (!pathFromPrivate || pathFromPrivate === ".." ||
      pathFromPrivate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromPrivate) ||
      pathFromPrivate.includes("/") || pathFromPrivate.includes("\\"))
    throw new AppSheetHistoryStageError("private_direct_child_required");
  return absolute;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700)
    throw new AppSheetHistoryStageError("private_directory_permissions_invalid");
}

async function readPrivateJson<T>(pathValue: string, privateDirectory: string, workingDirectory: string, maxBytes: number): Promise<T> {
  const path = privateAppSheetChildPath(pathValue, privateDirectory, workingDirectory);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 ||
      (before.mode & 0o400) === 0 || before.size <= 0 || before.size > maxBytes)
    throw new AppSheetHistoryStageError("private_file_invalid");
  const bytes = await readFile(path);
  const after = await lstat(path).catch(() => null);
  if (bytes.length !== before.size || !after?.isFile() || after.isSymbolicLink() || after.dev !== before.dev ||
      after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new AppSheetHistoryStageError("private_file_changed_during_read");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw new AppSheetHistoryStageError("private_json_invalid"); }
}

function readGitState(workingDirectory: string): { commitSha: string; clean: boolean } {
  try {
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: workingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("invalid");
    return { commitSha, clean: status.trim().length === 0 };
  } catch { throw new AppSheetHistoryStageError("git_commit_state_unavailable"); }
}

function selectedDatabaseUrl(target: "isolated" | "production"): URL {
  const raw = target === "isolated" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!raw) throw new AppSheetHistoryStageError(target === "isolated" ? "isolated_test_database_required" : "canonical_database_url_required");
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppSheetHistoryStageError("database_url_invalid"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new AppSheetHistoryStageError("database_must_be_postgres");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || host.startsWith("127.");
  if (target === "isolated") {
    if (!loopback) throw new AppSheetHistoryStageError("test_database_must_be_loopback");
    if (!/^\/bombo_ui_[a-z0-9_-]+$/i.test(url.pathname)) throw new AppSheetHistoryStageError("dedicated_test_database_required");
    if (process.env.DATABASE_URL) {
      try {
        const main = new URL(process.env.DATABASE_URL);
        const key = (item: URL) => [item.hostname.toLowerCase(), item.port || "5432", decodeURIComponent(item.pathname.slice(1))].join("\0");
        if (key(main) === key(url)) throw new AppSheetHistoryStageError("test_database_matches_application_database");
      } catch (error) {
        if (error instanceof AppSheetHistoryStageError) throw error;
        throw new AppSheetHistoryStageError("configured_database_url_invalid");
      }
    }
  } else {
    if (loopback) throw new AppSheetHistoryStageError("production_database_must_not_be_loopback");
    if (process.env.TEST_DATABASE_URL) {
      try {
        const test = new URL(process.env.TEST_DATABASE_URL);
        const key = (item: URL) => [item.hostname.toLowerCase(), item.port || "5432", decodeURIComponent(item.pathname.slice(1))].join("\0");
        if (key(test) === key(url)) throw new AppSheetHistoryStageError("production_database_matches_test_database");
      } catch (error) {
        if (error instanceof AppSheetHistoryStageError) throw error;
        throw new AppSheetHistoryStageError("test_database_url_invalid");
      }
    }
  }
  return url;
}

export async function runAppSheetHistoryCli(args: string[], workingDirectory = process.cwd()): Promise<{ code: number; output: string }> {
  let options: AppSheetHistoryCliOptions | "help";
  try { options = parseAppSheetHistoryCliArgs(args, workingDirectory); }
  catch (error) {
    return { code: 2, output: JSON.stringify({ status: "error", code: error instanceof AppSheetHistoryStageError ? error.code : "invalid_arguments" }) };
  }
  if (options === "help") return { code: 0, output: appSheetHistoryCliUsage() };
  const privateDirectory = resolve(workingDirectory, PRIVATE_DIR);
  try {
    const initialGit = readGitState(workingDirectory);
    if (options.apply && !initialGit.clean) throw new AppSheetHistoryStageError("apply_requires_clean_committed_worktree");
    await assertPrivateDirectory(privateDirectory);
    const definitionPath = privateAppSheetChildPath(options.definitionPath, privateDirectory, workingDirectory);
    const capture = await loadAppSheetHistoryCapture(options.captureDirectory, { allowStagedDelta: options.allowStagedDelta });
    const definition = await loadAppSheetHistoryDefinition(definitionPath);
    const prepared = prepareAppSheetHistoryProjection(capture, definition);
    const report = {
      ...appSheetHistoryProjectionReport(prepared),
      commitSha: initialGit.commitSha,
      target: options.target,
      expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID,
      definition: {
        appId: definition.inventory.app.id,
        sourceSha256: definition.sourceSha256,
        descriptorSha256: definition.descriptorSha256,
        appliedDefinitionHash: appSheetAppliedDefinitionHash(definition.inventory),
        identityState: definition.identityState,
        declaredCounts: definition.inventory.declaredCounts,
        observedCounts: definition.inventory.observedCounts,
      },
      cutoverEligible: false,
    };
    if (!options.apply) return { code: 0, output: JSON.stringify(report) };

    const databaseUrl = selectedDatabaseUrl(options.target);
    const reviewPath = privateAppSheetChildPath(options.reviewPath!, privateDirectory, workingDirectory);
    const reviewValue = await readPrivateJson<unknown>(reviewPath, privateDirectory, workingDirectory, MAX_REVIEW_BYTES);
    const review = requireAppSheetTechnicalReview(reviewValue, {
      captureId: prepared.capture.manifest.captureId,
      manifestHash: prepared.capture.manifest.manifestHash,
      definitionHash: prepared.definition.appliedDefinitionHash,
      projectionKind: "history",
      projectionHash: prepared.projectionHash,
      commitSha: initialGit.commitSha,
      importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    });
    if (review.reviewer.trim().toLowerCase() === options.actorId!.trim().toLowerCase())
      throw new AppSheetHistoryStageError("independent_technical_reviewer_required");

    const priorDatabaseUrl = process.env.DATABASE_URL;
    let backupEvidence: { manifestHash: string; snapshotAt: string };
    try {
      process.env.DATABASE_URL = databaseUrl.toString();
      backupEvidence = await verifyBackupReference(options.backupReference!);
    } catch {
      throw new AppSheetHistoryStageError("verified_target_backup_required");
    } finally {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
    }
    const finalGit = readGitState(workingDirectory);
    if (!finalGit.clean || finalGit.commitSha !== initialGit.commitSha)
      throw new AppSheetHistoryStageError("apply_commit_state_changed");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    try {
      const result = await stageAppSheetHistoryProjection(prepared, {
        actorId: options.actorId!,
        technicalReview: review,
        commitSha: finalGit.commitSha,
        allowStagedDelta: options.allowStagedDelta,
        target: options.target === "production" ? "production" : "isolated-test",
        backupEvidence,
      }, db);
      return { code: 0, output: JSON.stringify({ ...report, status: result.status, replay: result.replay, snapshotId: result.snapshotId }) };
    } finally {
      await db.$disconnect();
    }
  } catch (error) {
    const code = error instanceof AppSheetHistoryStageError || error instanceof AppSheetCanonicalError
      ? error.code : "history_stage_failed";
    return { code: 1, output: JSON.stringify({ status: "error", code }) };
  }
}

export { readGitState, selectedDatabaseUrl };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runAppSheetHistoryCli(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.code;
}
