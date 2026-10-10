import assert from "node:assert/strict";
import test from "node:test";
import {
  appSheetPendingImportCommandEnvelope,
  AppSheetPendingImportCliError,
  parseAppSheetPendingImportCliArgs,
} from "../scripts/appsheet-pending-import.js";

const requestId = "30000000-0000-4000-8000-000000000001";

function sourceReviewArgs(extra: string[] = []): string[] {
  return ["--snapshot", "history-snapshot-1", "--action", "review-source", "--actor-id", "reviewer-1",
    "--request-id", requestId, "--backup-reference", "verified-backup-reference", "--review", "source-review.json", ...extra];
}

test("review-source parsing requires the private review file and rejects unrelated action inputs", () => {
  const parsed = parseAppSheetPendingImportCliArgs(sourceReviewArgs());
  assert.notEqual(parsed, "help");
  if (parsed === "help") throw new Error("expected parsed action");
  assert.equal(parsed.action, "review-source");
  assert.equal(parsed.snapshotId, "history-snapshot-1");
  assert.equal(parsed.reviewPath, "source-review.json");

  assert.throws(() => parseAppSheetPendingImportCliArgs(sourceReviewArgs().filter((_, index, args) =>
    args[index] !== "--review" && args[index - 1] !== "--review")),
  (error: unknown) => error instanceof AppSheetPendingImportCliError && error.code === "source_review_file_required");
  assert.throws(() => parseAppSheetPendingImportCliArgs(sourceReviewArgs(["--mapping", "mapping.json"])),
    (error: unknown) => error instanceof AppSheetPendingImportCliError && error.code === "mapping_file_action_mismatch");
  assert.throws(() => parseAppSheetPendingImportCliArgs(sourceReviewArgs(["--importer-id", "importer-1"])),
    (error: unknown) => error instanceof AppSheetPendingImportCliError && error.code === "importer_id_action_mismatch");
});

function actionArgs(action: string, target: "isolated" | "production"): string[] {
  if (action === "preview") return ["--snapshot", "history-snapshot-1", "--action", action, "--target", target];
  const args = ["--snapshot", "history-snapshot-1", "--action", action, "--target", target,
    "--actor-id", "reviewer-1", "--request-id", requestId, "--backup-reference", "verified-backup-reference"];
  if (["review-source", "review-destination", "review-plan"].includes(action)) args.push("--review", "review.json");
  if (action === "review-plan") args.push("--importer-id", "importer-1");
  if (action === "map-order" || action === "resolve-delivery") args.push("--mapping", "mapping.json");
  if (action === "stage") args.push("--plan-review-request-id", requestId);
  return args;
}

test("production requires authenticated API for human review while preview and technical staging remain available", () => {
  const reviewActions = ["review-source", "map-order", "resolve-delivery", "review-plan", "review-destination"];
  for (const action of reviewActions) {
    assert.throws(() => parseAppSheetPendingImportCliArgs(actionArgs(action, "production")),
      (error: unknown) => error instanceof AppSheetPendingImportCliError &&
        error.code === "human_review_requires_authenticated_api",
      `${action} must reject production CLI review`);
    const isolated = parseAppSheetPendingImportCliArgs(actionArgs(action, "isolated"));
    assert.notEqual(isolated, "help", `${action} isolated rehearsal should remain available`);
  }
  assert.notEqual(parseAppSheetPendingImportCliArgs(actionArgs("preview", "production")), "help");
  assert.notEqual(parseAppSheetPendingImportCliArgs(actionArgs("stage", "production")), "help");
});

test("same actor, command, target and request UUID reconstruct the receipt envelope", () => {
  const initial = appSheetPendingImportCommandEnvelope({
    actorId: "reviewer-1", targetId: "history-snapshot-1", expectedVersion: 0,
    command: "AppSheetHistorySourceReviewed", requestId,
    data: { fileHash: "a".repeat(64), captureId: "appsreal-0123456789abcdef", dataHash: "b".repeat(64),
      projectionHash: "c".repeat(64), evidenceReference: "reviewed source capture" },
  });
  const receipt = {
    actorId: "reviewer-1", targetId: "history-snapshot-1", command: "AppSheetHistorySourceReviewed",
    occurredAt: new Date(initial.occurredAt), resultingVersion: 1,
  };
  const retry = appSheetPendingImportCommandEnvelope({
    actorId: "reviewer-1", targetId: "history-snapshot-1", expectedVersion: 1,
    command: "AppSheetHistorySourceReviewed", requestId, priorReceipt: receipt,
    data: { fileHash: "a".repeat(64), captureId: "appsreal-0123456789abcdef", dataHash: "b".repeat(64),
      projectionHash: "c".repeat(64), evidenceReference: "reviewed source capture" },
  });

  assert.deepEqual(retry, initial);
});

test("a receipt for another actor, command or target cannot replace the current envelope version", () => {
  const occurredAt = new Date("2026-10-01T00:00:00.000Z");
  for (const priorReceipt of [
    { actorId: "another-reviewer", targetId: "snapshot-1", command: "Review", occurredAt, resultingVersion: 8 },
    { actorId: "reviewer-1", targetId: "another-snapshot", command: "Review", occurredAt, resultingVersion: 8 },
    { actorId: "reviewer-1", targetId: "snapshot-1", command: "AnotherCommand", occurredAt, resultingVersion: 8 },
  ]) {
    const envelope = appSheetPendingImportCommandEnvelope({ actorId: "reviewer-1", targetId: "snapshot-1",
      expectedVersion: 4, command: "Review", data: {}, requestId, priorReceipt });
    assert.equal(envelope.expectedVersion, 4);
    assert.notEqual(envelope.occurredAt, occurredAt.toISOString());
  }
});
