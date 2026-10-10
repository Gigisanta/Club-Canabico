#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, isIP } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
dotenv.config({ path: resolve(projectRoot, ".env") });

const activeChildren = new Set();
let requestedSignal;
let ephemeralDemoPassword;

function redact(value) {
  const sanitized = String(value)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "[PostgreSQL URL redacted]")
    .replace(/\b(password|passwd|pwd)(\s*[=:]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  return ephemeralDemoPassword
    ? sanitized.split(ephemeralDemoPassword).join("[redacted]")
    : sanitized;
}

function onSignal(signal) {
  if (requestedSignal) return;
  requestedSignal = signal;
  for (const state of activeChildren) state.child.kill("SIGTERM");
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

function throwIfInterrupted() {
  if (requestedSignal) throw new Error(`E2E interrumpido (${requestedSignal}).`);
}

function parsePostgresURL(raw, variableName) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variableName} no contiene una URL PostgreSQL válida.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error(`${variableName} debe usar PostgreSQL.`);
  if (!url.hostname || url.hash)
    throw new Error(`${variableName} debe incluir un host y una base PostgreSQL válidos.`);
  if (!decodeURIComponent(url.pathname.slice(1)))
    throw new Error(`${variableName} debe indicar el nombre de una base PostgreSQL.`);
  return url;
}

function normalizedHost(host) {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value.startsWith("127.") || value === "::1"
    ? "loopback"
    : value;
}

function databaseTarget(url) {
  return [
    normalizedHost(url.hostname),
    url.port || "5432",
    decodeURIComponent(url.pathname.slice(1)),
  ].join("\u0000");
}

async function validateTestDatabase() {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw)
    throw new Error("Falta TEST_DATABASE_URL. Configurá una conexión PostgreSQL local de pruebas; DATABASE_URL del demo no se usa como fallback.");

  const url = parsePostgresURL(raw, "TEST_DATABASE_URL");
  if (!/^bombo_ui_[a-z0-9_-]+$/i.test(decodeURIComponent(url.pathname.slice(1))))
    throw new Error("TEST_DATABASE_URL debe usar una base dedicada cuyo nombre empiece por bombo_ui_.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let addresses;
  if (host === "localhost") {
    try {
      addresses = (await lookup(host, { all: true })).map(({ address }) => address);
    } catch {
      throw new Error("TEST_DATABASE_URL debe resolver a una dirección local de loopback.");
    }
  } else if (isIP(host)) {
    addresses = [host];
  } else {
    throw new Error("TEST_DATABASE_URL sólo admite localhost o una dirección IP loopback.");
  }

  const loopback = addresses.length > 0 && addresses.every((address) => {
    if (isIP(address) === 4) return address.startsWith("127.");
    return address === "::1";
  });
  if (!loopback)
    throw new Error("TEST_DATABASE_URL apunta fuera de loopback; se rechazó antes de abrir una conexión.");

  const appDatabase = process.env.DATABASE_URL?.trim();
  if (appDatabase) {
    try {
      const appURL = parsePostgresURL(appDatabase, "DATABASE_URL");
      if (databaseTarget(url) === databaseTarget(appURL))
        throw new Error("TEST_DATABASE_URL apunta a la misma base PostgreSQL configurada para el demo. Usá una base local de pruebas separada.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("misma base PostgreSQL")) throw error;
    }
  }

  url.searchParams.set("schema", "public");
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "5");
  return url;
}

function withSchema(url, schema) {
  const scoped = new URL(url);
  scoped.searchParams.set("schema", schema);
  if (!scoped.searchParams.has("connect_timeout")) scoped.searchParams.set("connect_timeout", "5");
  return scoped.toString();
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

function startChild(label, executable, args, env) {
  const state = {
    label,
    output: "",
    partial: { stdout: "", stderr: "" },
    finished: false,
  };
  const child = spawn(executable, args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  state.spawnError = undefined;
  child.once("error", (error) => { state.spawnError = error; });

  const consume = (streamName, chunk) => {
    const text = state.partial[streamName] + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    state.partial[streamName] = lines.pop() || "";
    for (const line of lines) {
      const safeLine = redact(line);
      state.output = `${state.output}${safeLine}\n`.slice(-30000);
      if (safeLine) process.stdout.write(`[${label}] ${safeLine}\n`);
    }
  };
  child.stdout.on("data", (chunk) => consume("stdout", chunk));
  child.stderr.on("data", (chunk) => consume("stderr", chunk));

  state.closed = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => {
      for (const streamName of ["stdout", "stderr"]) {
        const tail = state.partial[streamName];
        if (tail) {
          const safeLine = redact(tail);
          state.output = `${state.output}${safeLine}\n`.slice(-30000);
          process.stdout.write(`[${label}] ${safeLine}\n`);
        }
      }
      state.finished = true;
      state.exitStatus = { code, signal };
      activeChildren.delete(state);
      resolvePromise(state.exitStatus);
    });
  });
  activeChildren.add(state);
  return state;
}

async function runCommand(label, executable, args, env) {
  throwIfInterrupted();
  const state = startChild(label, executable, args, env);
  const result = await state.closed;
  if (state.spawnError)
    throw new Error(`${label}: no se pudo iniciar el proceso (${state.spawnError.code || "error de spawn"}).`);
  if (requestedSignal) throw new Error(`E2E interrumpido (${requestedSignal}).`);
  if (result.code !== 0)
    throw new Error(`${label} terminó con código ${result.code ?? result.signal ?? "desconocido"}.\n${state.output}`);
}

async function stopChild(state) {
  if (state.finished) return;
  state.child.kill("SIGTERM");
  let timer;
  const exited = await Promise.race([
    state.closed.then(() => true),
    new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), 5000); }),
  ]);
  clearTimeout(timer);
  if (!exited) {
    state.child.kill("SIGKILL");
    await state.closed;
  }
}

async function waitForHTTP(state, url, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    if (state.finished)
      throw new Error(`${label} terminó antes de quedar disponible.\n${state.output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
    } catch {
      // La instancia puede tardar unos segundos en compilar o conectar la base.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} no respondió en el tiempo esperado.\n${state.output}`);
}

const isolatedMigrationReviewSpec = "tests/browser/appsheet-migration-review.spec.ts";
// Mirrors Playwright 1.63's default **/*.@(spec|test).?(c|m)[jt]s?(x) matcher.
const playwrightDefaultTestMatch = /\.(?:spec|test)\.(?:[cm])?[jt]s(?:x)?$/i;

function discoverDefaultBrowserSpecs() {
  const testRoot = resolve(projectRoot, "tests/browser");
  const files = [];
  const visit = directory => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && playwrightDefaultTestMatch.test(entry.name)) {
        files.push(relative(projectRoot, entryPath).split(sep).join("/"));
      }
    }
  };
  if (existsSync(testRoot) && lstatSync(testRoot).isDirectory()) visit(testRoot);
  // Playwright makes positional file filters case-insensitive on every platform.
  const caseFoldedPaths = new Set();
  for (const file of files) {
    const folded = file.toLowerCase();
    if (caseFoldedPaths.has(folded))
      throw new Error("El inventario contiene rutas de tests que sólo difieren en mayúsculas; no se puede garantizar su aislamiento.");
    caseFoldedPaths.add(folded);
  }
  return files;
}

function partitionBrowserSpecs(selectors) {
  const ordinary = selectors.filter(file => file !== isolatedMigrationReviewSpec);
  const migrationReview = selectors.filter(file => file === isolatedMigrationReviewSpec);
  const groups = [];
  if (ordinary.length) groups.push({ name: "ordinary", selectors: ordinary });
  if (migrationReview.length) groups.push({ name: "appsheet-migration-review", selectors: migrationReview });
  return groups;
}

function canonicalizeBrowserSpecSelectors(selectors, discoveredSpecs) {
  return selectors.map(selector => {
    const exactMatch = discoveredSpecs.find(file => file === selector);
    if (exactMatch) return exactMatch;

    const caseInsensitiveMatches = discoveredSpecs.filter(file => file.toLowerCase() === selector.toLowerCase());
    if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0];
    if (caseInsensitiveMatches.length > 1)
      throw new Error(`El selector ${selector} coincide con varios archivos de navegador al ignorar mayúsculas; usá el nombre exacto.`);
    throw new Error(`El archivo ${selector} existe, pero Playwright no lo descubre con el testMatch configurado.`);
  });
}

function playwrightFileSelector(relativePath) {
  const escapedPath = relativePath
    .split("/")
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[/\\\\]");
  return `(?:^|[/\\\\])${escapedPath}$`;
}

async function runIsolatedGroup(group, adminURL) {
  let adminClient;
  let schema;
  let schemaCreated = false;
  let privateObjectRoot;
  let groupError;
  ephemeralDemoPassword = randomBytes(32).toString("base64url");
  try {
    throwIfInterrupted();

    schema = `bombo_e2e_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
    adminClient = new PrismaClient({ datasources: { db: { url: adminURL.toString() } } });
    await adminClient.$connect();
    await adminClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    console.log(`[e2e:${group.name}] Conexión PostgreSQL de pruebas local validada; esquema desechable creado.`);

    const databaseURL = withSchema(adminURL, schema);
    const childEnv = { ...process.env };
    delete childEnv.TEST_DATABASE_URL;
    delete childEnv.E2E_DATABASE_URL;
    delete childEnv.E2E_URL;
    delete childEnv.BOMBO_E2E_ISOLATED;
    delete childEnv.BOMBO_E2E_PASSWORD;
    childEnv.DATABASE_URL = databaseURL;
    childEnv.NODE_ENV = "development";
    childEnv.DEMO_MODE = "true";
    childEnv.HOST = "127.0.0.1";
    childEnv.PUBLIC_SITE_PREVIEW = "true";
    childEnv.VITE_PUBLIC_SITE_PREVIEW = "true";
    childEnv.JWT_SECRET = randomBytes(48).toString("hex");
    childEnv.COOKIE_SECURE = "false";
    childEnv.PUBLIC_SITE_APPROVED = "false";
    privateObjectRoot = await mkdtemp(resolve(tmpdir(), "bombo-e2e-private-"));
    await chmod(privateObjectRoot, 0o700);
    childEnv.PRIVATE_OBJECT_ROOT = privateObjectRoot;
    childEnv.PRIVATE_OBJECT_PROVIDER = "local";
    childEnv.PRIVATE_S3_BUCKET = "";

    const prismaCLI = resolve(projectRoot, "node_modules/prisma/build/index.js");
    if (!existsSync(prismaCLI)) throw new Error("No se encontró Prisma instalado en node_modules.");
    console.log(`[e2e:${group.name}] Aplicando migraciones al esquema desechable.`);
    await runCommand(`migrate:${group.name}`, process.execPath, [prismaCLI, "migrate", "deploy"], childEnv);

    console.log(`[e2e:${group.name}] Sembrando datos demo en el esquema desechable.`);
    const seedEnv = {
      ...childEnv,
      BOMBO_E2E_ISOLATED: "1",
      BOMBO_E2E_PASSWORD: ephemeralDemoPassword,
    };
    await runCommand(`seed:${group.name}`, process.execPath, ["--import", "tsx", "prisma/seed.ts"], seedEnv);
    await runCommand(`operations-seed:${group.name}`, process.execPath, ["--import", "tsx", "scripts/seed-operations-rehearsal.ts"], childEnv);

    const [apiPort, vitePort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()]);
    if (apiPort === vitePort) throw new Error("No se pudieron asignar puertos locales distintos para API y Vite.");
    const baseURL = `http://127.0.0.1:${vitePort}`;
    const appEnv = { ...childEnv };
    appEnv.PORT = String(apiPort);
    appEnv.VITE_PORT = String(vitePort);
    appEnv.ALLOWED_ORIGIN = baseURL;
    appEnv.BOMBO_E2E_ISOLATED = "1";
    appEnv.BOMBO_E2E_PASSWORD = ephemeralDemoPassword;
    appEnv.E2E_BASE_URL = baseURL;

    const api = startChild(`api:${group.name}`, process.execPath, ["--import", "tsx", "server/index.ts"], appEnv);
    const viteCLI = resolve(projectRoot, "node_modules/vite/bin/vite.js");
    if (!existsSync(viteCLI)) throw new Error("No se encontró Vite instalado en node_modules.");
    const viteEnv = { ...appEnv };
    delete viteEnv.BOMBO_E2E_PASSWORD;
    const vite = startChild(`vite:${group.name}`, process.execPath, [viteCLI, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], viteEnv);
    console.log(`[e2e:${group.name}] Esperando API y Vite en puertos loopback temporales.`);
    await Promise.all([
      waitForHTTP(api, `http://127.0.0.1:${apiPort}/api/health`, `API aislada (${group.name})`),
      waitForHTTP(vite, `${baseURL}/`, `Vite aislado (${group.name})`),
    ]);

    const playwrightCLI = resolve(projectRoot, "node_modules/@playwright/test/cli.js");
    if (!existsSync(playwrightCLI)) throw new Error("No se encontró Playwright instalado en node_modules.");
    console.log(`[e2e:${group.name}] Ejecutando Playwright contra la instancia aislada.`);
    const testFilters = group.selectors.map(playwrightFileSelector);
    await runCommand(`playwright:${group.name}`, process.execPath, [playwrightCLI, "test", "--config=playwright.config.ts", ...testFilters], appEnv);
  } catch (error) {
    groupError = error;
  } finally {
    const cleanupErrors = [];
    for (const state of [...activeChildren]) {
      try {
        await stopChild(state);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`No se pudo detener ${state.label}: ${detail}`);
      }
    }
    if (schemaCreated && adminClient && schema) {
      try {
        await adminClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        console.log(`[e2e:${group.name}] Esquema temporal eliminado.`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`No se pudo eliminar el esquema temporal: ${detail}`);
      }
    }
    if (adminClient) {
      try {
        await adminClient.$disconnect();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`No se pudo cerrar la conexión local de pruebas: ${detail}`);
      }
    }
    if (privateObjectRoot) {
      try {
        await rm(privateObjectRoot, { recursive: true, force: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(`No se pudo eliminar la raíz privada temporal de objetos: ${detail}`);
      }
    }
    if (cleanupErrors.length) {
      const cleanupFailure = cleanupErrors.join("\n");
      if (groupError) {
        const runFailure = groupError instanceof Error ? groupError.message : String(groupError);
        groupError = new Error(`${runFailure}\n${cleanupFailure}`);
      } else {
        groupError = new Error(cleanupFailure);
      }
    }
  }
  if (groupError) throw groupError;
  console.log(`[e2e] Grupo ${group.name} completado.`);
}

async function main() {
  let exitCode = 0;
  try {
    const requestedSelectors = process.argv.slice(2);
    if (requestedSelectors.some(file => !/^tests\/browser\/[a-zA-Z0-9_-]+\.spec\.ts$/.test(file) || !existsSync(resolve(projectRoot, file))))
      throw new Error("El runner aislado sólo acepta archivos tests/browser/*.spec.ts; no admite overrides de Playwright.");
    const discoveredSpecs = discoverDefaultBrowserSpecs();
    const selectors = requestedSelectors.length
      ? canonicalizeBrowserSpecSelectors(requestedSelectors, discoveredSpecs)
      : discoveredSpecs;
    const groups = partitionBrowserSpecs(selectors);
    if (!groups.length) throw new Error("Playwright no encontró archivos de navegador compatibles con la configuración actual.");

    const adminURL = await validateTestDatabase();
    for (let index = 0; index < groups.length; index += 1) {
      try {
        await runIsolatedGroup(groups[index], adminURL);
      } catch (error) {
        const remainingGroups = groups.slice(index + 1).map(group => group.name);
        if (!requestedSignal && remainingGroups.length)
          console.error(`[e2e] Grupos posteriores no ejecutados por el fallo de ${groups[index].name}: ${remainingGroups.join(", ")}.`);
        throw error;
      }
    }
    console.log("[e2e] Suite de navegador completada.");
  } catch (error) {
    exitCode = 1;
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[e2e] ${redact(detail)}`);
  } finally {
    for (const state of [...activeChildren]) {
      try {
        await stopChild(state);
      } catch (error) {
        exitCode = 1;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[e2e] No se pudo detener un proceso hijo: ${redact(detail)}`);
      }
    }
  }
  if (requestedSignal) exitCode = 128 + (requestedSignal === "SIGINT" ? 2 : 15);
  process.exitCode = exitCode;
}

await main();
