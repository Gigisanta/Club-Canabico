import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appSheetHistoryPreviewDestinationIdentity,
  privateAppSheetChildPath,
  readGitState,
  selectedDatabaseUrl,
} from "./appsheet-history.js";
import { AppSheetHistoryStageError } from "../server/operations/appsheet-history.js";
import { appSheetPendingImportReviewSchema } from "../shared/operations/appsheet-pending-import.js";

const PRIVATE_DIR = ".local/appsheet-real-20261009";
const MAX_INPUT_BYTES = 1_000_000;

export type AppSheetPendingImportAction = "preview" | "map-order" | "resolve-delivery" | "review-plan" | "stage" | "review-destination";
export interface AppSheetPendingImportCliOptions {
  action: AppSheetPendingImportAction;
  snapshotId: string;
  target: "isolated" | "production";
  actorId: string | null;
  requestId: string | null;
  reviewPath: string | null;
  mappingPath: string | null;
  planReviewRequestId: string | null;
  importerId: string | null;
  backupReference: string | null;
}

export function appSheetPendingImportCliUsage(): string {
  return [
    "Uso: tsx scripts/appsheet-pending-import.ts --snapshot <snapshot-id|batch-id> [--action preview|map-order|resolve-delivery|review-plan|stage|review-destination]",
    "Preview es el modo predeterminado y sólo consulta el destino indicado.",
    "Toda escritura exige --actor-id, --request-id UUID, --backup-reference verificado y un checkout Git limpio con commit.",
    "map-order/resolve-delivery y review-plan/review-destination requieren JSON privado directo dentro de .local/appsheet-real-20261009/.",
    "stage consume --plan-review-request-id, un recibo de revisión previo emitido por una persona con imports.review.",
    "El destino y el respaldo se comprueban contra la captura estable; no se imprimen URLs, filas ni valores privados.",
  ].join("\n");
}

export function parseAppSheetPendingImportCliArgs(args: string[]): AppSheetPendingImportCliOptions | "help" {
  const options: AppSheetPendingImportCliOptions = {
    action: "preview", snapshotId: "", target: "isolated", actorId: null, requestId: null,
    reviewPath: null, mappingPath: null, planReviewRequestId: null, importerId: null, backupReference: null,
  };
  const seen = new Set<string>();
  const values = new Map<string, string>();
  const valueArgs = ["--action", "--snapshot", "--target", "--actor-id", "--request-id", "--review", "--mapping", "--plan-review-request-id", "--importer-id", "--backup-reference"];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (!valueArgs.includes(argument)) throw new AppSheetPendingImportCliError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetPendingImportCliError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetPendingImportCliError("argument_value_required");
    values.set(argument, value);
  }
  const action = values.get("--action") ?? "preview";
  if (!["preview", "map-order", "resolve-delivery", "review-plan", "stage", "review-destination"].includes(action))
    throw new AppSheetPendingImportCliError("action_invalid");
  options.action = action as AppSheetPendingImportAction;
  options.snapshotId = values.get("--snapshot") ?? "";
  if (!options.snapshotId.trim() || options.snapshotId.length > 100) throw new AppSheetPendingImportCliError("snapshot_id_required");
  const target = values.get("--target") ?? "isolated";
  if (target !== "isolated" && target !== "production") throw new AppSheetPendingImportCliError("target_invalid");
  options.target = target;
  options.actorId = values.get("--actor-id") ?? null;
  options.requestId = values.get("--request-id") ?? null;
  options.reviewPath = values.get("--review") ?? null;
  options.mappingPath = values.get("--mapping") ?? null;
  options.planReviewRequestId = values.get("--plan-review-request-id") ?? null;
  options.importerId = values.get("--importer-id") ?? null;
  options.backupReference = values.get("--backup-reference") ?? null;
  const mutating = options.action !== "preview";
  if (mutating && (!options.actorId || !options.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.requestId) || !options.backupReference))
    throw new AppSheetPendingImportCliError("write_actor_request_and_backup_required");
  if (!mutating && [options.actorId, options.requestId, options.reviewPath, options.mappingPath,
    options.planReviewRequestId, options.importerId, options.backupReference].some(value => value !== null))
    throw new AppSheetPendingImportCliError("write_arguments_require_mutating_action");
  if (options.action === "map-order" && !options.mappingPath) throw new AppSheetPendingImportCliError("order_mapping_file_required");
  if (options.action === "resolve-delivery" && !options.mappingPath) throw new AppSheetPendingImportCliError("delivery_mapping_file_required");
  if (options.action === "review-plan" && (!options.reviewPath || !options.importerId)) throw new AppSheetPendingImportCliError("plan_review_file_and_importer_required");
  if (options.action === "stage" && !options.planReviewRequestId) throw new AppSheetPendingImportCliError("plan_review_receipt_required");
  if (options.action === "review-destination" && !options.reviewPath) throw new AppSheetPendingImportCliError("destination_review_file_required");
  if (!(["map-order", "resolve-delivery"].includes(options.action)) && options.mappingPath)
    throw new AppSheetPendingImportCliError("mapping_file_action_mismatch");
  if (options.action !== "stage" && options.planReviewRequestId) throw new AppSheetPendingImportCliError("plan_review_receipt_action_mismatch");
  if (options.action !== "review-plan" && options.importerId) throw new AppSheetPendingImportCliError("importer_id_action_mismatch");
  if (!["review-plan", "review-destination"].includes(options.action) && options.reviewPath)
    throw new AppSheetPendingImportCliError("review_file_action_mismatch");
  return options;
}

export class AppSheetPendingImportCliError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AppSheetPendingImportCliError"; }
}

async function readPrivateJson(pathValue: string, privateDirectory: string, workingDirectory: string): Promise<unknown> {
  const path = privateAppSheetChildPath(pathValue, privateDirectory, workingDirectory);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 ||
      (before.mode & 0o400) === 0 || before.size <= 0 || before.size > MAX_INPUT_BYTES)
    throw new AppSheetPendingImportCliError("private_input_file_invalid");
  const bytes = await readFile(path);
  const after = await lstat(path).catch(() => null);
  if (bytes.length !== before.size || !after?.isFile() || after.isSymbolicLink() || after.dev !== before.dev ||
      after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new AppSheetPendingImportCliError("private_input_changed_during_read");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new AppSheetPendingImportCliError("private_input_json_invalid"); }
}

function randomEnvelope(targetId: string, expectedVersion: number, command: string, data: Record<string, unknown>, requestId: string) {
  return { schemaVersion: 1, requestId, targetId, expectedVersion, occurredAt: new Date().toISOString(), command, data };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof AppSheetPendingImportCliError || error instanceof AppSheetHistoryStageError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code))
    return error.code;
  return "pending_import_cli_failed";
}

/** The entry point is intentionally inert on import so unit tests can inspect its parser safely. */
export async function runAppSheetPendingImportCli(args: string[], workingDirectory = process.cwd()): Promise<{ code: number; output: string }> {
  let options: AppSheetPendingImportCliOptions | "help";
  try { options = parseAppSheetPendingImportCliArgs(args); }
  catch (error) { return { code: 2, output: JSON.stringify({ status: "error", code: safeFailureCode(error) }) }; }
  if (options === "help") return { code: 0, output: appSheetPendingImportCliUsage() };
  const privateDirectory = resolve(workingDirectory, PRIVATE_DIR);
  const initialGit = readGitState(workingDirectory);
  if (options.action !== "preview" && !initialGit.clean)
    return { code: 2, output: JSON.stringify({ status: "error", code: "write_requires_clean_committed_worktree" }) };
  try {
    await import("dotenv/config");
    const databaseUrl = selectedDatabaseUrl(options.target);
    const target = options.target === "isolated" ? "isolated-test" : "production";
    const destinationIdentity = appSheetHistoryPreviewDestinationIdentity(options.target, databaseUrl);
    process.env.DATABASE_URL = databaseUrl.toString();
    await import("../server/operations/routes.js"); // Registers commands; internal HTTP still rejects them.
    const [{ db }, { executeCommand }, { prepareAppSheetPendingImportPlan }, { verifyBackupReference }] = await Promise.all([
      import("../server/db.js"), import("../server/operations/core.js"), import("../server/operations/appsheet-pending-import.js"),
      import("../server/operations/financial-source-stage.js"),
    ]);
    const destinationBatch = options.action === "review-destination"
      ? await db.appSheetPendingImportBatch.findUnique({ where: { id: options.snapshotId }, select: { id: true, snapshotId: true } })
      : null;
    if (options.action === "review-destination" && !destinationBatch)
      throw new AppSheetPendingImportCliError("pending_batch_not_found");
    const planSnapshotId = destinationBatch?.snapshotId ?? options.snapshotId;
    let plan = await prepareAppSheetPendingImportPlan(db, { snapshotId: planSnapshotId });
    const targetMatches = plan.target === target && plan.destinationIdentity === destinationIdentity;
    if (options.action === "preview") {
      const counts = Object.fromEntries(["blocked", "closed", "not_applicable", "materialized"].map(state =>
        [state, plan.dispositions.filter(row => row.state === state).length]));
      return { code: 0, output: JSON.stringify({ status: "preview", snapshotId: options.snapshotId,
        captureId: plan.captureId, manifestHash: plan.manifestHash, dataHash: plan.dataHash, mappingHash: plan.mappingHash,
        sourceSpecHash: plan.sourceSpecHash, sourceCoverageHash: plan.sourceCoverageHash,
        dispositionHash: plan.dispositionHash, destinationHash: plan.destinationHash, projectionHash: plan.projectionHash,
        commitSha: initialGit.commitSha, target, destinationIdentity, sourceTarget: plan.target,
        targetMatches, dispositions: counts, materializedSettlements: plan.materializedSettlements.length,
        cutoverEligible: false }) };
    }

    await (await import("node:fs/promises")).access(privateDirectory);
    const directoryInfo = await lstat(privateDirectory).catch(() => null);
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0 || (directoryInfo.mode & 0o700) !== 0o700)
      throw new AppSheetPendingImportCliError("private_directory_permissions_invalid");
    const actor = await db.user.findUnique({ where: { id: options.actorId! } });
    if (!actor?.active) throw new AppSheetPendingImportCliError("actor_inactive_or_missing");
    let backupEvidence: { manifestHash: string; snapshotAt: string };
    try { backupEvidence = await verifyBackupReference(options.backupReference!); }
    catch { throw new AppSheetPendingImportCliError("verified_target_backup_required"); }
    const finalGit = readGitState(workingDirectory);
    if (!finalGit.clean || finalGit.commitSha !== initialGit.commitSha)
      throw new AppSheetPendingImportCliError("write_commit_state_changed");
    const backupBinding = { target, destinationIdentity, commitSha: finalGit.commitSha,
      backupManifestHash: backupEvidence.manifestHash, backupSnapshotAt: new Date(backupEvidence.snapshotAt) };
    plan = await prepareAppSheetPendingImportPlan(db, { snapshotId: options.snapshotId, binding: backupBinding });
    if (!targetMatches || plan.target !== target || plan.destinationIdentity !== destinationIdentity)
      throw new AppSheetPendingImportCliError("target_does_not_match_reviewed_history_binding");
    const requestId = options.requestId!;
    let targetId = options.snapshotId;
    let command = "";
    let expectedVersion = 0;
    let data: Record<string, unknown> = {};
    if (["map-order", "resolve-delivery"].includes(options.action)) {
      const mapData = await readPrivateJson(options.mappingPath!, privateDirectory, workingDirectory);
      const parsed = mapData && typeof mapData === "object" && !Array.isArray(mapData) ? mapData as Record<string, unknown> : null;
      if (!parsed) throw new AppSheetPendingImportCliError(options.action === "map-order"
        ? "order_mapping_payload_invalid" : "delivery_mapping_payload_invalid");
      const snapshotObject = await db.operationObject.findUnique({ where: { id: options.snapshotId }, select: { kind: true, version: true } });
      if (!snapshotObject || snapshotObject.kind !== "legacyImport") throw new AppSheetPendingImportCliError("snapshot_object_not_found");
      expectedVersion = snapshotObject.version;
      command = options.action === "map-order" ? "AppSheetPendingOrderIdentityReviewed" : "AppSheetPendingDeliveryResolved";
      data = parsed;
    } else if (options.action === "review-plan") {
      const rawReview = await readPrivateJson(options.reviewPath!, privateDirectory, workingDirectory);
      const review = appSheetPendingImportReviewSchema.parse(rawReview);
      command = "AppSheetPendingImportPlanReviewed";
      targetId = `appsheet-pending-plan-review:${plan.batchId}`;
      expectedVersion = 0;
      data = { snapshotId: options.snapshotId, importerId: options.importerId, ...backupBinding, review };
    } else if (options.action === "stage") {
      command = "AppSheetPendingImportStaged";
      targetId = plan.batchId;
      expectedVersion = 0;
      data = { snapshotId: options.snapshotId, ...backupBinding, planReviewRequestId: options.planReviewRequestId };
    } else {
      const batch = destinationBatch!;
      plan = await prepareAppSheetPendingImportPlan(db, { snapshotId: batch.snapshotId, binding: backupBinding });
      const object = await db.operationObject.findUnique({ where: { id: batch.id }, select: { kind: true, version: true } });
      if (!object || object.kind !== "legacyImport") throw new AppSheetPendingImportCliError("pending_batch_object_not_found");
      command = "AppSheetPendingImportDestinationReviewed";
      targetId = batch.id;
      expectedVersion = object.version;
      const rawReview = await readPrivateJson(options.reviewPath!, privateDirectory, workingDirectory);
      data = { review: appSheetPendingImportReviewSchema.parse(rawReview) };
    }
    const response = await executeCommand(actor, randomEnvelope(targetId, expectedVersion, command, data, requestId));
    return { code: 0, output: JSON.stringify({ status: "completed", action: options.action, command,
      requestId, targetId, version: response.version, result: response.result }) };
  } catch (error) {
    return { code: 1, output: JSON.stringify({ status: "error", code: safeFailureCode(error) }) };
  } finally {
    const dbModule = await import("../server/db.js").catch(() => null);
    if (dbModule) await dbModule.db.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runAppSheetPendingImportCli(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.code;
}
