import { isAbsolute, resolve } from "node:path";
import {
  AppSheetPendingPreviewError,
  prepareAppSheetPendingPreview,
  writeAppSheetPendingPreviewPrivate,
} from "../server/operations/appsheet-pending.js";
import { AppSheetHistoryStageError } from "../server/operations/appsheet-history.js";

interface Options {
  capturePath: string | null;
  outputPath: string | null;
  allowStagedDelta: boolean;
}

function usage(): string {
  return [
    "Uso: tsx scripts/appsheet-pending.ts --capture <directorio-privado> [--output <archivo-en-el-directorio>] [--allow-staged-delta]",
    "Genera sólo un preview DB-free; nunca ejecuta operaciones ni efectos históricos.",
    "El preview privado no contiene claves ni celdas originales; puede guardar importes derivados con su moneda explícita.",
    "Una captura preliminar requiere --allow-staged-delta y siempre queda marcada provisional.",
  ].join("\n");
}

function parseArgs(args: string[]): Options | "help" {
  const options: Options = { capturePath: null, outputPath: null, allowStagedDelta: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--allow-staged-delta") {
      if (seen.has(argument)) throw new AppSheetPendingPreviewError("duplicate_argument");
      seen.add(argument);
      options.allowStagedDelta = true;
      continue;
    }
    if (argument !== "--capture" && argument !== "--output") throw new AppSheetPendingPreviewError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetPendingPreviewError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetPendingPreviewError("argument_value_required");
    if (argument === "--capture") options.capturePath = value;
    else options.outputPath = value;
  }
  if (!options.capturePath) throw new AppSheetPendingPreviewError("capture_directory_required");
  if (options.outputPath && isAbsolute(options.outputPath) === false && options.outputPath.includes("/"))
    throw new AppSheetPendingPreviewError("output_must_be_a_filename_or_absolute_path");
  return options;
}

async function main(): Promise<void> {
  let options: Options | "help";
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof AppSheetPendingPreviewError ? error.code : "invalid_arguments";
    console.error(JSON.stringify({ error: code }));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options === "help") {
    console.log(usage());
    return;
  }
  const captureDirectory = resolve(options.capturePath!);
  try {
    const preview = await prepareAppSheetPendingPreview(captureDirectory, { allowStagedDelta: options.allowStagedDelta });
    const outputPath = options.outputPath
      ? (isAbsolute(options.outputPath) ? resolve(options.outputPath) : resolve(captureDirectory, options.outputPath))
      : resolve(captureDirectory, "pending-preview.json");
    await writeAppSheetPendingPreviewPrivate(preview, outputPath, captureDirectory);
    console.log(JSON.stringify({ ...preview.summary, outputStored: true }));
  } catch (error) {
    const code = error instanceof AppSheetPendingPreviewError || error instanceof AppSheetHistoryStageError
      ? error.code : "pending_preview_failed";
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}

void main();
