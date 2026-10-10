#!/usr/bin/env node
// Portable one-shot scheduler target. It only uses local, private object storage.
import { open, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const SCRIPT = fileURLToPath(new URL("./operations-backup.mjs", import.meta.url));

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function overlaps(left, right) {
  return within(left, right) || within(right, left);
}

async function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try { return resolve(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

async function validatePrivateDirectory(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} no puede ser un enlace simbólico`);
    if (!info.isDirectory()) throw new Error(`${label} debe ser un directorio`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} debe tener permisos privados (0700)`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function validateConfig(env = process.env) {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("El worker requiere Node.js 24");
  if (typeof env.DATABASE_URL !== "string" || !env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
  try {
    const databaseUrl = new URL(env.DATABASE_URL);
    if (!new Set(["postgres:", "postgresql:"]).has(databaseUrl.protocol)) throw new Error();
  } catch {
    throw new Error("DATABASE_URL debe ser una URL PostgreSQL válida");
  }
  if (typeof env.BACKUP_ENCRYPTION_KEY !== "string" || !/^[a-f0-9]{64}$/i.test(env.BACKUP_ENCRYPTION_KEY)) {
    throw new Error("BACKUP_ENCRYPTION_KEY debe contener 32 bytes hexadecimales");
  }
  if (typeof env.BACKUP_ROOT !== "string" || !isAbsolute(env.BACKUP_ROOT)) throw new Error("BACKUP_ROOT debe ser una ruta absoluta");
  if (typeof env.PRIVATE_OBJECT_ROOT !== "string" || !isAbsolute(env.PRIVATE_OBJECT_ROOT)) {
    throw new Error("PRIVATE_OBJECT_ROOT debe ser una ruta absoluta local");
  }
  const provider = env.PRIVATE_OBJECT_PROVIDER;
  if (provider && provider !== "local") throw new Error("El worker sólo admite almacenamiento privado local");
  if (env.PRIVATE_S3_BUCKET || env.PRIVATE_S3_ENDPOINT || env.BLOB_READ_WRITE_TOKEN ||
      Object.keys(env).some(name => name.startsWith("AWS_") && Boolean(env[name]))) {
    throw new Error("El worker rechaza configuración de almacenamiento remoto; no se enviaron solicitudes externas");
  }

  const backupRoot = resolve(env.BACKUP_ROOT);
  const objectRoot = resolve(env.PRIVATE_OBJECT_ROOT);
  await Promise.all([
    validatePrivateDirectory(backupRoot, "BACKUP_ROOT"),
    validatePrivateDirectory(objectRoot, "PRIVATE_OBJECT_ROOT"),
  ]);
  const [canonicalBackup, canonicalObjects] = await Promise.all([canonicalPath(backupRoot), canonicalPath(objectRoot)]);
  if (overlaps(backupRoot, objectRoot) || overlaps(canonicalBackup, canonicalObjects)) {
    throw new Error("BACKUP_ROOT y PRIVATE_OBJECT_ROOT deben ser directorios separados");
  }
  return { backupRoot, objectRoot };
}

function runStep(step, directory, env) {
  return new Promise((resolveResult, reject) => {
    const childEnv = { ...env, PRIVATE_OBJECT_PROVIDER: "local", PRIVATE_OBJECT_ROOT: env.PRIVATE_OBJECT_ROOT };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("AWS_") || key.startsWith("PRIVATE_S3_") || key === "BLOB_READ_WRITE_TOKEN") delete childEnv[key];
    }
    const child = spawn(process.execPath, [SCRIPT, step, directory], {
      cwd: process.cwd(), env: childEnv, stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {
      if (stdout.length < 16_384) stdout += chunk.slice(0, 16_384 - stdout.length);
    });
    child.once("error", () => reject(new Error(`${step} no pudo iniciar el CLI de backup`)));
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`${step} falló (código ${code ?? "desconocido"})`));
      if (step !== "backup") return resolveResult(undefined);
      try { resolveResult(JSON.parse(stdout.trim())); }
      catch { reject(new Error("El CLI de backup no devolvió un resumen válido")); }
    });
  });
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function runOnce(env = process.env) {
  const { backupRoot } = await validateConfig(env);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(backupRoot, "BACKUP_ROOT");
  const lockPath = resolve(backupRoot, ".operations-backup-worker.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Ya hay una ejecución activa o un lock requiere revisión manual");
    throw error;
  }
  const lockStat = await lock.stat();
  const runId = randomUUID();
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const pendingName = `.pending-${stamp}-${runId}`;
  const finalName = `backup-${stamp}-${runId}`;
  const pending = resolve(backupRoot, pendingName);
  const published = resolve(backupRoot, finalName);
  let moved = false;
  let step = "backup";
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }));
    await lock.sync();
    await fsyncDirectory(backupRoot);
    const summary = await runStep("backup", pending, env);
    if (!summary || summary.mode !== "backup" || summary.encrypted !== true || !summary.counts) {
      throw new Error("El CLI no confirmó un paquete cifrado completo");
    }
    step = "verify";
    await runStep("verify", pending, env);
    step = "publish";
    await rename(pending, published);
    moved = true;
    await fsyncDirectory(backupRoot);
    return { mode: "backup-worker", ok: true, encrypted: true, backupId: finalName, counts: summary.counts };
  } catch (error) {
    if (!moved) await rm(pending, { recursive: true, force: true }).catch(() => {});
    const result = new Error(error instanceof Error ? error.message : `${step} falló`);
    result.step = step;
    throw result;
  } finally {
    await lock.close();
    try {
      const current = await lstat(lockPath);
      if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
        await rm(lockPath);
        await fsyncDirectory(backupRoot);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if ((argv.length !== 1) || !["--once", "--dry-run"].includes(mode)) {
    throw new Error("Uso: operations-backup-worker.mjs --once|--dry-run");
  }
  if (mode === "--dry-run") {
    await validateConfig();
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", ok: true, encrypted: true, objectStorage: "local-only", scheduler: "external" })}\n`);
    return;
  }
  const result = await runOnce();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const result = { mode: "backup-worker", ok: false, step: error?.step ?? "configuration", error: error instanceof Error ? error.message : "Fallo no identificado" };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
}
