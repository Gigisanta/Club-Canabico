#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FinancialSourceStageError,
  prepareFinancialSourceStage,
  readReviewManifest,
  stageFinancialSource,
} from "../server/operations/financial-source-stage.js";

const DEFAULT_SOURCE = "/Users/gigi/Downloads/2025_PP_Appsheet_TB (2).xlsx";

interface Arguments {
  apply: boolean;
  help: boolean;
  file?: string;
  manifest?: string;
  backupReference?: string;
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { apply: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--apply") result.apply = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--file" || argument === "--manifest" || argument === "--backup-reference") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new FinancialSourceStageError("invalid_arguments");
      if (argument === "--file") result.file = value;
      else if (argument === "--manifest") result.manifest = value;
      else result.backupReference = value;
    } else throw new FinancialSourceStageError("invalid_arguments");
  }
  return result;
}

function usage(): string {
  return [
    "Uso:",
    "  npx tsx scripts/financial-source-stage.ts [--file <xlsx>]",
    "  npx tsx scripts/financial-source-stage.ts --apply --manifest <review.json> --backup-reference <backup-dir> [--file <xlsx>]",
    "",
    "Sin --apply sólo prepara una vista numérica; no conecta a la base ni escribe estado.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.apply && (!args.manifest || !args.backupReference))
    throw new FinancialSourceStageError("apply_requires_manifest_and_backup");
  if (!args.apply && (args.manifest || args.backupReference))
    throw new FinancialSourceStageError("manifest_and_backup_require_apply");

  const inputPath = resolve(args.file ?? DEFAULT_SOURCE);
  const filename = inputPath.split(/[\\/]/).at(-1) ?? "financial-source.xlsx";
  const prepared = await prepareFinancialSourceStage(await readFile(inputPath), filename);
  if (!args.apply) {
    console.log(JSON.stringify({
      mode: "dry-run",
      sourceTable: "Movimiento_Nueva",
      fileHash: prepared.snapshot.fileHash,
      rowManifestHash: prepared.rowManifestHash,
      cutoffDate: prepared.reconciliationManifest.cutoffDate,
      rawCount: prepared.metrics.rawCount,
      eligibleCount: prepared.metrics.eligibleCount,
      excludedCount: prepared.metrics.excludedCount,
      keyedRecordCount: prepared.metrics.keyedRecordCount,
      duplicateKeyCount: prepared.metrics.duplicateKeyCount,
      exceptionCount: prepared.metrics.exceptionCount,
      readerExceptionCount: prepared.metrics.readerExceptionCount,
      periodCount: prepared.metrics.periodCount,
      exclusionCounts: prepared.metrics.exceptionCounts,
      databaseConnected: false,
      status: "staged-only-preview",
    }));
    return;
  }

  const reviewManifest = await readReviewManifest(resolve(args.manifest!));
  const result = await stageFinancialSource(prepared, {
    filename,
    reviewManifest,
    backupReference: resolve(args.backupReference!),
  });
  console.log(JSON.stringify({
    mode: "apply",
    sourceTable: "Movimiento_Nueva",
    fileHash: result.fileHash,
    snapshotId: result.snapshotId,
    status: result.status,
    alreadyStaged: result.alreadyStaged,
    recordCount: result.recordCount,
    eligibleCount: result.eligibleCount,
    excludedCount: result.excludedCount,
    exceptionCount: result.exceptionCount,
    rowManifestHash: result.rowManifestHash,
    reviewManifestHash: result.reviewManifestHash,
    backupManifestHash: result.backupManifestHash,
  }));
}

main().catch((error: unknown) => {
  const code = error instanceof FinancialSourceStageError ? error.code : "financial_source_stage_failed";
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
