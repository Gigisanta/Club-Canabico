#!/usr/bin/env node
/** Read-only responsive smoke. Screenshots and results stay under .local/. */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const target = new URL(process.env.UI_AUDIT_BASE_URL || "http://127.0.0.1:5173");
if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password)
  throw new Error("La auditoría visual sólo admite un servidor HTTP local.");

const output = resolve(process.env.UI_AUDIT_OUTPUT || ".local/ui-qa/after");
await mkdir(output, { recursive: true });
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = existsSync(chromium.executablePath()) ? {} : existsSync(chrome) ? { executablePath: chrome } : {};
const browser = await chromium.launch({ headless: true, ...launchOptions });

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "zoom-200-equivalent", width: 720, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "small-mobile", width: 320, height: 700 },
];
const publicRoutes = ["/", "/productos", "/productos/ficha-inexistente"];
const appRoutes = [
  "/app", "/app/panorama", "/app/decisiones", "/app/decisiones/stock", "/app/decisiones/comercial", "/app/decisiones/caja", "/app/decisiones/socios",
  "/app/ventas", "/app/inventario", "/app/socios", "/app/gastos",
  "/app/finanzas", "/app/responsables", "/app/reportes", "/app/vidriera",
  "/app/consultas", "/app/configuracion", "/app/configuracion?tab=public", "/app/importar", "/app/preparar",
];
const captureRoutes = new Set(["/", "/productos", "/app", "/app/panorama", "/app/decisiones", "/app/ventas", "/app/inventario", "/app/socios", "/app/importar", "/app/preparar", "/app/vidriera", "/app/consultas"]);
const rows = [];

try {
  for (const size of sizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
      reducedMotion: size.name === "small-mobile" ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === target.origin) return route.continue();
      return route.abort("blockedbyclient");
    });

    async function inspect(path, area) {
      await page.goto(new URL(path, target).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (area === "app") {
        await page.locator(".app-shell").waitFor({ timeout: 20_000 });
        await page.locator(".page-loading").first().waitFor({ state: "hidden", timeout: 20_000 });
      } else {
        await page.locator("main, .public-hold, .login-page").first().waitFor({ timeout: 12_000 });
      }
      await page.evaluate(async () => { await document.fonts.ready; });
      if (captureRoutes.has(path)) await page.waitForTimeout(400);
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        title: document.title,
        heading: document.querySelector("main h1, .public-hold h1, .login-page h1")?.textContent?.trim() || "",
        robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
        appReady: Boolean(document.querySelector(".app-shell")),
        publicReady: Boolean(document.querySelector(".public-site")),
      }));
      const row = { size: size.name, path, area, ...layout, overflow: layout.document > layout.viewport + 1 || layout.body > layout.viewport + 1, unexpectedState: area === "app" ? !layout.appReady : !layout.publicReady, missingNoindex: area === "public" && !layout.robots.includes("noindex") };
      rows.push(row);
      if (captureRoutes.has(path)) {
        await page.evaluate(async () => {
          const images = [...document.images];
          for (const img of images) if (img.loading === "lazy") img.loading = "eager";
          await Promise.race([
            Promise.all(images.map(img => img.decode().catch(() => {}))),
            new Promise(resolve => setTimeout(resolve, 3500)),
          ]);
        });
        for (const chart of await page.locator(".main-chart, .donut-wrap").all()) {
          await chart.scrollIntoViewIfNeeded();
          await page.waitForTimeout(120);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(100);
        const name = `${size.name}-${path === "/" ? "landing" : path.slice(1).replaceAll("/", "-")}`;
        await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
      }
    }

    for (const path of publicRoutes) await inspect(path, "public");

    await page.emulateMedia({ media: "print" });
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    const publicPrint = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      menuHidden: getComputedStyle(document.querySelector(".public-menu-button")).display === "none",
    }));
    rows.push({ size: size.name, path: "/", area: "public-print", ...publicPrint, overflow: publicPrint.document > publicPrint.viewport + 1 });
    await page.emulateMedia({ media: "screen" });

    await page.goto(new URL("/app", target).href, { waitUntil: "domcontentloaded" });
    const demo = page.getByRole("button", { name: "Explorar club de demostración" });
    const available = await demo.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    if (available) {
      await demo.click();
      await page.locator(".app-shell").waitFor({ timeout: 12_000 });
      for (const path of appRoutes) await inspect(path, "app");
      await page.emulateMedia({ media: "print" });
      rows.push({ size: size.name, path: "/app", area: "print", sidebarHidden: await page.locator(".sidebar").evaluate(element => getComputedStyle(element).display === "none"), tabbarHidden: await page.locator(".mobile-tabbar").evaluate(element => getComputedStyle(element).display === "none") });
    } else {
      rows.push({ size: size.name, path: "/app", area: "app", skipped: "El demo no está habilitado; no se usarán credenciales reales." });
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const errors = rows.filter(row => row.overflow || row.unexpectedState || row.missingNoindex || row.area === "print" && (!row.sidebarHidden || !row.tabbarHidden) || row.area === "public-print" && !row.menuHidden);
await writeFile(resolve(output, "audit.json"), JSON.stringify({ target: target.origin, recordedAt: new Date().toISOString(), rows, errors }, null, 2));
console.log(JSON.stringify({ routes: rows.length, errors: errors.length, output }, null, 2));
if (errors.length) process.exitCode = 1;
