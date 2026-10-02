import { chromium, defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.OFFLINE_PWA_PORT ?? 4179);
const baseURL = `http://127.0.0.1:${port}`;
const previewOutDir = resolve(process.env.OFFLINE_PWA_OUT_DIR ?? "dist");
const systemChrome = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find(existsSync);
const bundledBrowser = chromium.executablePath();
const browserPath = process.env.BROWSER_PATH
  ? (existsSync(process.env.BROWSER_PATH) ? process.env.BROWSER_PATH : undefined)
  : existsSync(bundledBrowser) ? undefined : systemChrome;

if (process.env.BROWSER_PATH && !browserPath) throw new Error("BROWSER_PATH no apunta a un navegador existente.");

export default defineConfig({
  testDir: "./tests/offline-browser",
  ...(process.env.OFFLINE_PWA_RESULTS_DIR ? { outputDir: resolve(process.env.OFFLINE_PWA_RESULTS_DIR) } : {}),
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL,
    viewport: { width: 412, height: 915 },
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(browserPath ? { launchOptions: { executablePath: browserPath } } : {}),
  },
  webServer: {
    command: `${process.execPath} node_modules/vite/bin/vite.js preview --outDir ${previewOutDir} --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: "list",
});
