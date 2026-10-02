import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Follow the real build graph. Other lazy desktop tools stay on demand.
const root = new URL("../dist/", import.meta.url);
const graph = JSON.parse(await readFile(new URL(".vite/manifest.json", root), "utf8"));
const seen = new Set();
const paths = new Set();
const allowed = /^assets\/[^/]+\.(?:js|css|woff2?)$/i;
function add(path) {
  if (typeof path === "string" && allowed.test(path)) paths.add(`/${path}`);
}
function visit(key) {
  if (seen.has(key)) return;
  const chunk = graph[key];
  if (!chunk || !allowed.test(chunk.file ?? "")) throw new Error(`Dependencia del shell ausente: ${key}`);
  seen.add(key);
  add(chunk.file);
  for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) add(file);
  for (const dependency of chunk.imports ?? []) visit(dependency);
}
visit("index.html");
visit("src/DeliveryEntry.tsx");
const assets = [...paths].sort();
const bytes = (await Promise.all(assets.map(path => stat(new URL(path.slice(1), root))))).reduce((sum, file) => sum + file.size, 0);
const workerPath = new URL("bombo-sw.js", root);
const worker = await readFile(workerPath, "utf8");
const cacheMarker = 'const CACHE_NAME = "bombo-delivery-shell-v3";';
const releaseMarker = "const SHELL_RELEASE_ID = null;";
const htmlMarker = "const SHELL_HTML_SHA256 = null;";
if (![cacheMarker, releaseMarker, htmlMarker].every(marker => worker.includes(marker))) throw new Error("Marcadores del service worker ausentes: volver a ejecutar vite build");
const htmlHash = createHash("sha256").update(await readFile(new URL("index.html", root))).digest("hex");
const hash = createHash("sha256").update(worker).update(JSON.stringify(assets));
for (const path of ["index.html", ...assets.map(asset => asset.slice(1)), "manifest.webmanifest", "brand/bombo-symbol.png"]) {
  hash.update(path).update(await readFile(new URL(path, root)));
}
const release = hash.digest("hex");
await writeFile(new URL("bombo-shell-assets.json", root), JSON.stringify({ version: 1, release, assets }));
await writeFile(workerPath, worker.replace(cacheMarker, `const CACHE_NAME = "bombo-delivery-shell-${release}";`).replace(releaseMarker, `const SHELL_RELEASE_ID = "${release}";`).replace(htmlMarker, `const SHELL_HTML_SHA256 = "${htmlHash}";`));
console.log(`Shell PWA de reparto: ${assets.length} archivos, ${bytes} bytes sin compresión`);
