#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
dotenv.config({ path: resolve(projectRoot, ".env") });

const activeChildren = new Set();
let requestedSignal;

function redact(value) {
  return String(value)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "[PostgreSQL URL redacted]")
    .replace(/\b(password|passwd|pwd)(\s*[=:]\s*)[^\s,;]+/gi, "$1$2[redacted]");
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

async function main() {
  let exitCode = 0;
  let adminClient;
  let schema;
  let schemaCreated = false;
  try {
    if (process.argv.length > 2)
      throw new Error("El runner aislado no acepta overrides de Playwright; ejecutá `npm run test:e2e` sin argumentos.");
    throwIfInterrupted();

    const adminURL = await validateTestDatabase();
    schema = `bombo_e2e_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
    adminClient = new PrismaClient({ datasources: { db: { url: adminURL.toString() } } });
    await adminClient.$connect();
    await adminClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    console.log("[e2e] Conexión PostgreSQL de pruebas local validada; esquema desechable creado.");

    const databaseURL = withSchema(adminURL, schema);
    const childEnv = { ...process.env };
    delete childEnv.TEST_DATABASE_URL;
    delete childEnv.E2E_DATABASE_URL;
    delete childEnv.E2E_URL;
    childEnv.DATABASE_URL = databaseURL;
    childEnv.NODE_ENV = "development";
    childEnv.DEMO_MODE = "true";
    childEnv.HOST = "127.0.0.1";
    childEnv.PUBLIC_SITE_PREVIEW = "true";
    childEnv.JWT_SECRET = randomBytes(48).toString("hex");
    childEnv.COOKIE_SECURE = "false";
    childEnv.PUBLIC_SITE_APPROVED = "false";

    const prismaCLI = resolve(projectRoot, "node_modules/prisma/build/index.js");
    if (!existsSync(prismaCLI)) throw new Error("No se encontró Prisma instalado en node_modules.");
    console.log("[e2e] Aplicando migraciones al esquema desechable.");
    await runCommand("migrate", process.execPath, [prismaCLI, "migrate", "deploy"], childEnv);

    console.log("[e2e] Sembrando datos demo en el esquema desechable.");
    await runCommand("seed", process.execPath, ["--import", "tsx", "prisma/seed.ts"], childEnv);

    const [apiPort, vitePort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()]);
    if (apiPort === vitePort) throw new Error("No se pudieron asignar puertos locales distintos para API y Vite.");
    const baseURL = `http://127.0.0.1:${vitePort}`;
    const appEnv = { ...childEnv };
    appEnv.PORT = String(apiPort);
    appEnv.VITE_PORT = String(vitePort);
    appEnv.ALLOWED_ORIGIN = baseURL;
    appEnv.BOMBO_E2E_ISOLATED = "1";
    appEnv.E2E_BASE_URL = baseURL;

    const api = startChild("api", process.execPath, ["--import", "tsx", "server/index.ts"], appEnv);
    const viteCLI = resolve(projectRoot, "node_modules/vite/bin/vite.js");
    if (!existsSync(viteCLI)) throw new Error("No se encontró Vite instalado en node_modules.");
    const vite = startChild("vite", process.execPath, [viteCLI, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], appEnv);
    console.log("[e2e] Esperando API y Vite en puertos loopback temporales.");
    await Promise.all([
      waitForHTTP(api, `http://127.0.0.1:${apiPort}/api/health`, "API aislada"),
      waitForHTTP(vite, `${baseURL}/`, "Vite aislado"),
    ]);

    const playwrightCLI = resolve(projectRoot, "node_modules/@playwright/test/cli.js");
    if (!existsSync(playwrightCLI)) throw new Error("No se encontró Playwright instalado en node_modules.");
    console.log("[e2e] Ejecutando Playwright contra la instancia aislada.");
    await runCommand("playwright", process.execPath, [playwrightCLI, "test", "--config=playwright.config.ts"], appEnv);
    console.log("[e2e] Suite de navegador completada.");
  } catch (error) {
    exitCode = 1;
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[e2e] ${redact(detail)}`);
  } finally {
    for (const state of [...activeChildren]) await stopChild(state);
    if (schemaCreated && adminClient && schema) {
      try {
        await adminClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        console.log("[e2e] Esquema temporal eliminado.");
      } catch (error) {
        exitCode = 1;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[e2e] No se pudo eliminar el esquema temporal: ${redact(detail)}`);
      }
    }
    if (adminClient) {
      try {
        await adminClient.$disconnect();
      } catch {
        exitCode = 1;
        console.error("[e2e] No se pudo cerrar la conexión local de pruebas.");
      }
    }
  }
  if (requestedSignal) exitCode = 128 + (requestedSignal === "SIGINT" ? 2 : 15);
  process.exitCode = exitCode;
}

await main();
