import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workerScript = join(repositoryRoot, "scripts/operations-backup-worker.mjs");

function runWorker(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, ...args], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

function baseEnvironment(root: string) {
  return {
    DATABASE_URL: "postgresql://worker-user:worker-password@127.0.0.1:5432/bombo_ui_backup_worker_test",
    BACKUP_ENCRYPTION_KEY: "c".repeat(64),
    BACKUP_ROOT: join(root, "backups"),
    PRIVATE_OBJECT_ROOT: join(root, "private-objects"),
    PRIVATE_OBJECT_PROVIDER: "local",
    PG_BIN: join(root, "no-network-pg-bin"),
  };
}

test("backup worker dry-run validates local configuration without writing or exposing secrets", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-backup-worker-check-"));
  const env = baseEnvironment(temporaryRoot);
  try {
    const dryRun = await runWorker(["--dry-run"], env);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.deepEqual(JSON.parse(dryRun.stdout), {
      mode: "dry-run", ok: true, encrypted: true, objectStorage: "local-only", scheduler: "external",
    });
    assert.equal(dryRun.stdout.includes("worker-password"), false);
    assert.equal(dryRun.stdout.includes(env.BACKUP_ENCRYPTION_KEY), false);
    await assert.rejects(readFile(env.BACKUP_ROOT), { code: "ENOENT" });
    await assert.rejects(readFile(env.PRIVATE_OBJECT_ROOT), { code: "ENOENT" });

    const remote = await runWorker(["--dry-run"], { ...env, PRIVATE_S3_BUCKET: "billing-must-not-be-reached" });
    assert.notEqual(remote.code, 0);
    assert.match(remote.stderr, /local-only|almacenamiento remoto/);
    assert.equal(remote.stderr.includes("billing-must-not-be-reached"), false);
    await assert.rejects(readFile(env.BACKUP_ROOT), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("backup worker refuses an existing lock and leaves its owner marker untouched", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bombo-backup-worker-lock-"));
  const env = baseEnvironment(temporaryRoot);
  const lockPath = join(env.BACKUP_ROOT, ".operations-backup-worker.lock");
  const marker = "active-owner-marker";
  try {
    await mkdir(env.BACKUP_ROOT, { recursive: true, mode: 0o700 });
    await mkdir(env.PRIVATE_OBJECT_ROOT, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, marker, { mode: 0o600 });
    const result = await runWorker(["--once"], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lock|activa/i);
    assert.equal(await readFile(lockPath, "utf8"), marker);
    assert.deepEqual((await readdir(env.BACKUP_ROOT)).sort(), [".operations-backup-worker.lock"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
