import { lstat, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppSheetDefinitionError,
  parseAppSheetDefinitionHtml,
} from "../server/operations/appsheet-definition.js";
import type { AppSheetDefinitionInventory } from "../shared/operations/appsheet-definition.js";

interface CliOptions {
  filePath: string | null;
  outputPath: string | null;
  expectedAppId: string | null;
}

const PRIVATE_DIR = ".local/appsheet-real-20261009";
const MAX_FILE_BYTES = 24 * 1024 * 1024;

function usage(): string {
  return [
    "Uso: tsx scripts/appsheet-definition.ts --file <HTML> [--output <JSON>] [--expected-app-id <id>]",
    "La entrada y la salida deben estar directamente dentro de .local/appsheet-real-20261009.",
    "Por defecto imprime sólo hashes, cobertura y conteos; no conecta a la base de datos.",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions | "help" {
  const options: CliOptions = { filePath: null, outputPath: null, expectedAppId: null };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (!["--file", "--output", "--expected-app-id"].includes(argument)) throw new AppSheetDefinitionError("unknown_argument");
    if (seen.has(argument)) throw new AppSheetDefinitionError("duplicate_argument");
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new AppSheetDefinitionError("argument_value_required");
    if (argument === "--file") options.filePath = value;
    else if (argument === "--output") options.outputPath = value;
    else options.expectedAppId = value;
  }
  if (!options.filePath) throw new AppSheetDefinitionError("source_file_required");
  return options;
}

function privateChildPath(value: string, privateDir: string, workingDirectory: string): string {
  const candidate = resolve(workingDirectory, value);
  const relativePath = relative(privateDir, candidate);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath))
    throw new AppSheetDefinitionError("private_path_required");
  if (relativePath.includes("/") || relativePath.includes("\\")) throw new AppSheetDefinitionError("private_direct_child_required");
  return candidate;
}

async function checkPrivateDirectory(privateDir: string): Promise<void> {
  const metadata = await lstat(privateDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AppSheetDefinitionError("private_directory_invalid");
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o700) !== 0o700) throw new AppSheetDefinitionError("private_directory_permissions_invalid");
}

async function readPrivateHtml(filePath: string, privateDir: string, workingDirectory: string): Promise<string> {
  const path = privateChildPath(filePath, privateDir, workingDirectory);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AppSheetDefinitionError("source_file_invalid");
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0) throw new AppSheetDefinitionError("source_file_permissions_invalid");
  if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES) throw new AppSheetDefinitionError("source_file_size_invalid");
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_FILE_BYTES) throw new AppSheetDefinitionError("source_file_changed_during_read");
  const afterRead = await lstat(path);
  if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.dev !== metadata.dev || afterRead.ino !== metadata.ino ||
      afterRead.size !== metadata.size || afterRead.mtimeMs !== metadata.mtimeMs || afterRead.ctimeMs !== metadata.ctimeMs)
    throw new AppSheetDefinitionError("source_file_changed_during_read");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function writePrivateInventory(outputPath: string, privateDir: string, inputPath: string, inventory: AppSheetDefinitionInventory, workingDirectory: string): Promise<void> {
  const path = privateChildPath(outputPath, privateDir, workingDirectory);
  if (path === inputPath) throw new AppSheetDefinitionError("output_must_not_replace_source");
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
      throw new AppSheetDefinitionError("output_permissions_invalid");
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    // Exclusive-open failures mean this invocation did not create the path.
    // Never delete an existing inventory when refusing to overwrite it.
    if (created) await unlink(path).catch(() => undefined);
    if (error instanceof AppSheetDefinitionError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
    throw new AppSheetDefinitionError(code === "EEXIST" ? "output_already_exists" : "private_output_write_failed");
  }
}

function summary(inventory: AppSheetDefinitionInventory, inventorySaved: boolean): Record<string, unknown> {
  return {
    schemaVersion: inventory.schemaVersion,
    parserVersion: inventory.parserVersion,
    source: { sha256: inventory.source.sha256, byteLength: inventory.source.byteLength },
    app: inventory.app,
    descriptorSha256: inventory.descriptorSha256,
    declaredCounts: inventory.declaredCounts,
    observedCounts: inventory.observedCounts,
    coverage: inventory.coverage.map(({ category, state, declaredCount, observedCount, missingCount, redactedFieldCount, ambiguousFieldCount }) => ({
      category,
      state,
      declaredCount,
      observedCount,
      missingCount,
      redactedFieldCount,
      ambiguousFieldCount,
    })),
    redactedFieldCount: inventory.redactedFieldCount,
    warnings: inventory.warnings,
    inventorySaved,
  };
}

interface AppSheetDefinitionCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string | null;
  stderr: string | null;
}

async function runAppSheetDefinitionCli(args: string[], workingDirectory = process.cwd()): Promise<AppSheetDefinitionCliResult> {
  let options: CliOptions | "help";
  try {
    options = parseArgs(args);
  } catch (error) {
    const code = error instanceof AppSheetDefinitionError ? error.code : "invalid_arguments";
    return { exitCode: 2, stdout: null, stderr: [JSON.stringify({ error: code }), usage()].join("\n") };
  }
  if (options === "help") {
    return { exitCode: 0, stdout: usage(), stderr: null };
  }

  try {
    const privateDir = resolve(workingDirectory, PRIVATE_DIR);
    await checkPrivateDirectory(privateDir);
    const inputPath = privateChildPath(options.filePath!, privateDir, workingDirectory);
    const html = await readPrivateHtml(inputPath, privateDir, workingDirectory);
    const inventory = parseAppSheetDefinitionHtml(html, options.expectedAppId ? { expectedAppId: options.expectedAppId } : {});
    if (options.outputPath) await writePrivateInventory(options.outputPath, privateDir, inputPath, inventory, workingDirectory);
    return { exitCode: 0, stdout: JSON.stringify(summary(inventory, Boolean(options.outputPath))), stderr: null };
  } catch (error) {
    const code = error instanceof AppSheetDefinitionError ? error.code : "definition_preview_failed";
    return { exitCode: 1, stdout: null, stderr: JSON.stringify({ error: code }) };
  }
}

async function main(): Promise<void> {
  const result = await runAppSheetDefinitionCli(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
