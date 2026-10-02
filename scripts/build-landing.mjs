import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-landing");
const assets = [
  "bombo-symbol.png",
  "bombo-olive.webp",
  "home.webp",
  "club.webp",
  "club-mobile.webp",
  "flores.webp",
  "flores-mobile.webp",
  "aceite.webp",
  "aceite-mobile.webp",
  "topicos.webp",
  "topicos-mobile.webp",
  "comestibles.webp",
  "comestibles-mobile.webp",
  "BricolageGrotesque_72pt-Light.woff2",
  "BricolageGrotesque_72pt-SemiBold.woff2",
];

const htmlPath = path.join(root, "landing", "index.html");
const cssPath = path.join(root, "landing", "site.css");
await Promise.all([
  stat(htmlPath),
  stat(cssPath),
  stat(path.join(root, "landing", "vercel.json")),
  ...assets.map((asset) => stat(path.join(root, "public", "brand", asset))),
]);
const html = await readFile(htmlPath, "utf8");
if (!html.includes("https://bombo.maat.work/app") || !html.includes("/site.css")) {
  throw new Error("La landing debe incluir el acceso del equipo y su hoja de estilos local.");
}

await mkdir(path.join(output, "brand"), { recursive: true });
await Promise.all([
  copyFile(htmlPath, path.join(output, "index.html")),
  copyFile(cssPath, path.join(output, "site.css")),
  copyFile(path.join(root, "landing", "vercel.json"), path.join(output, "vercel.json")),
  ...assets.map((asset) =>
    copyFile(path.join(root, "public", "brand", asset), path.join(output, "brand", asset)),
  ),
]);
console.log(
  `Landing estática lista: ${path.relative(root, output)} (${assets.length} recursos de marca, sin runtime de aplicación).`,
);
