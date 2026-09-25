import { chromium, defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isolatedRun = process.env.BOMBO_E2E_ISOLATED === "1";
const baseURL = process.env.E2E_BASE_URL;
const localHost = process.env.HOST;

if (
  !isolatedRun ||
  process.env.NODE_ENV !== "development" ||
  process.env.DEMO_MODE !== "true" ||
  process.env.PUBLIC_SITE_PREVIEW !== "true" ||
  process.env.PUBLIC_SITE_APPROVED === "true" ||
  !localHost ||
  !localHosts.has(localHost.toLowerCase()) ||
  !baseURL
)
  throw new Error("Ejecutá E2E con `npm run test:e2e` para usar la instancia aislada.");

let parsedBaseURL: URL;
try {
  parsedBaseURL = new URL(baseURL);
} catch {
  throw new Error("E2E_BASE_URL debe ser una URL local HTTP válida.");
}
if (
  parsedBaseURL.protocol !== "http:" ||
  !localHosts.has(parsedBaseURL.hostname) ||
  parsedBaseURL.username ||
  parsedBaseURL.password
)
  throw new Error("Playwright sólo puede apuntar al origen HTTP local de la instancia aislada.");

const dynamicPort = (name: string): number => {
  const value = process.env[name];
  const port = Number(value);
  if (!value || !/^\d+$/.test(value) || port < 32768 || port > 65535)
    throw new Error(`${name} debe ser un puerto loopback efímero de la instancia aislada.`);
  return port;
};

const apiPort = dynamicPort("PORT");
const vitePort = dynamicPort("VITE_PORT");
if (apiPort === vitePort || Number(parsedBaseURL.port) !== vitePort)
  throw new Error("E2E_BASE_URL debe usar VITE_PORT y API/Vite deben tener puertos efímeros distintos.");

let databaseURL: URL;
try {
  databaseURL = new URL(process.env.DATABASE_URL || "");
} catch {
  throw new Error("DATABASE_URL debe apuntar al esquema PostgreSQL desechable de E2E.");
}
if (
  !["postgres:", "postgresql:"].includes(databaseURL.protocol) ||
  !localHosts.has(databaseURL.hostname) ||
  !/^bombo_e2e_[a-z0-9_]+$/i.test(databaseURL.searchParams.get("schema") || "")
)
  throw new Error("DATABASE_URL debe apuntar a PostgreSQL loopback con un esquema aislado bombo_e2e_*.");

function systemChromePath(): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/opt/google/chrome/chrome",
          ];
  return candidates.find(existsSync);
}

const configuredBrowser = process.env.BROWSER_PATH;
const bundledBrowser = chromium.executablePath();
const browserPath = configuredBrowser
  ? existsSync(configuredBrowser)
    ? configuredBrowser
    : undefined
  : existsSync(bundledBrowser)
    ? undefined
    : systemChromePath();

if (configuredBrowser && !browserPath)
  throw new Error("BROWSER_PATH no apunta a un ejecutable de navegador existente.");
if (!configuredBrowser && !existsSync(bundledBrowser) && !browserPath)
  throw new Error("Playwright no tiene Chromium instalado y no se encontró Chrome del sistema; instalá el navegador o definí BROWSER_PATH.");

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: parsedBaseURL.origin,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(browserPath ? { launchOptions: { executablePath: browserPath } } : {}),
  },
  reporter: "list",
});
