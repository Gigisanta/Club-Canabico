import { resolve } from "node:path";
import {
  AppSheetArchiveStageError,
  parseAppSheetArchiveManifest,
  parseAppSheetCoordinateCoverage,
  previewAppSheetArchive,
  prepareAppSheetArchiveStage,
  readPrivateControlFile,
  stageAppSheetArchive,
} from "../server/operations/appsheet-archive-stage.js";

interface CliOptions {
  filePath: string | null;
  manifestPath: string;
  coordinateCoveragePath: string;
  apply: boolean;
  backupReference: string | null;
}

const DEFAULT_MANIFEST = ".local/legacy-business-controls/independent-manifest.json";
const DEFAULT_COORDINATE_COVERAGE = ".local/legacy-business-controls/coordinate-only-coverage.json";

function usage(): string {
  return [
    "Uso: tsx scripts/appsheet-archive-stage.ts --file <XLSX> [--manifest <JSON>] [--coordinate-coverage <JSON>] [--apply --backup-reference <dir>]",
    "Sin --apply sólo prepara un preview local y no conecta a la base de datos.",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions | "help" {
  const options: CliOptions = {
    filePath: null,
    manifestPath: DEFAULT_MANIFEST,
    coordinateCoveragePath: DEFAULT_COORDINATE_COVERAGE,
    apply: false,
    backupReference: null,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--apply") {
      if (seen.has(argument)) throw new AppSheetArchiveStageError("duplicate_argument");
      seen.add(argument);
      options.apply = true;
      continue;
    }
    if (!["--file", "--manifest", "--coordinate-coverage", "--backup-reference"].includes(argument))
      throw new AppSheetArchiveStageError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetArchiveStageError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetArchiveStageError("argument_value_required");
    if (argument === "--file") options.filePath = value;
    else if (argument === "--manifest") options.manifestPath = value;
    else if (argument === "--coordinate-coverage") options.coordinateCoveragePath = value;
    else options.backupReference = value;
  }
  if (!options.filePath) throw new AppSheetArchiveStageError("source_file_required");
  if (options.apply && !options.backupReference) throw new AppSheetArchiveStageError("backup_reference_required");
  if (!options.apply && options.backupReference) throw new AppSheetArchiveStageError("backup_reference_requires_apply");
  return options;
}

async function main(): Promise<void> {
  let options: CliOptions | "help";
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof AppSheetArchiveStageError ? error.code : "invalid_arguments";
    console.error(JSON.stringify({ error: code }));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options === "help") {
    console.log(usage());
    return;
  }

  try {
    const manifestValue = await readPrivateControlFile(resolve(options.manifestPath), "independent-manifest.json");
    const coordinateCoverageValue = await readPrivateControlFile(resolve(options.coordinateCoveragePath), "coordinate-only-coverage.json");
    const prepared = await prepareAppSheetArchiveStage({
      filePath: resolve(options.filePath!),
      manifestValue: parseAppSheetArchiveManifest(manifestValue),
      coordinateCoverageValue: parseAppSheetCoordinateCoverage(coordinateCoverageValue),
    });
    const result = options.apply
      ? await stageAppSheetArchive(prepared, { backupReference: resolve(options.backupReference!) })
      : previewAppSheetArchive(prepared);
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof AppSheetArchiveStageError ? error.code : "stage_failed";
    const metrics = error instanceof AppSheetArchiveStageError ? error.metrics : undefined;
    console.error(JSON.stringify({ error: code, ...(metrics ? { metrics } : {}) }));
    process.exitCode = 1;
  }
}

void main();
