import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Only material shipped sources; never traverse environments, local data, Git or credentials.
const root = resolve(process.cwd());
const directories = ["api", "server", "shared", "src", "public", "prisma", "scripts", "landing"];
const configuration = ["package.json", "package-lock.json", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.node.json", "tsconfig.server.json", "vercel.json", "Dockerfile", "docker-compose.operations.yml", ".node-version", ".nvmrc"];
const files = [];
// Investigation artifacts contain private legacy evidence and are not runtime inputs.
const privateEvidence = new Set([
  "shared/operations/legacy-coverage.json", "shared/operations/legacy-measures.json", "shared/operations/legacy-model-metadata.json",
  "scripts/audit-legacy-sources.py", "scripts/legacy-coverage.py", "scripts/legacy-reader-source-audit.ts",
]);
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const path = join(directory, entry.name);
    if (privateEvidence.has(relative(root, path))) continue;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name !== "release.json" && !entry.name.endsWith(".pyc")) files.push(path);
  }
}
for (const directory of directories) await collect(join(root, directory));
for (const file of configuration) { try { await readFile(join(root,file)); files.push(join(root,file)); } catch (error) { if(error.code!=="ENOENT")throw error; } }
const records = [];
let deploymentConfigBytes;
for (const file of files.sort((a,b)=>relative(root,a)<relative(root,b)?-1:1)) {
  const path = relative(root,file), bytes = await readFile(file);
  records.push([path,createHash("sha256").update(bytes).digest("hex")]);
  if (path === "vercel.json") deploymentConfigBytes = bytes;
}
const sourceHash = createHash("sha256").update(JSON.stringify(records)).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digestValue = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
if (process.argv.includes("--source-only")) process.stdout.write(sourceHash+"\n");
else {
  await mkdir(join(root,"dist"),{recursive:true});
  await writeFile(join(root,"dist/release.json"),JSON.stringify({schemaVersion:1,sourceHash,buildNode:process.version,files:records.length})+"\n");
  // Content digests identify build-time source changes without exposing file contents.
  const deploymentConfig = deploymentConfigBytes ? JSON.parse(deploymentConfigBytes.toString("utf8")) : null;
  const deploymentConfiguration = deploymentConfig ? { canonicalHash: digestValue(deploymentConfig), fields: Object.keys(deploymentConfig).sort().map(key => [key, digestValue(deploymentConfig[key])]) } : null;
  await writeFile(join(root,"dist/release-sources.json"),JSON.stringify({schemaVersion:1,sourceHash,sources:records,deploymentConfiguration})+"\n");
  process.stdout.write(`Release source fingerprint: ${sourceHash}\n`);
}
