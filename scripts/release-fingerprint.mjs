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
for (const file of files.sort((a,b)=>relative(root,a)<relative(root,b)?-1:1)) records.push([relative(root,file),createHash("sha256").update(await readFile(file)).digest("hex")]);
const sourceHash = createHash("sha256").update(JSON.stringify(records)).digest("hex");
if (process.argv.includes("--source-only")) process.stdout.write(sourceHash+"\n");
else {
  await mkdir(join(root,"dist"),{recursive:true});
  await writeFile(join(root,"dist/release.json"),JSON.stringify({schemaVersion:1,sourceHash,buildNode:process.version,files:records.length})+"\n");
  process.stdout.write(`Release source fingerprint: ${sourceHash}\n`);
}
