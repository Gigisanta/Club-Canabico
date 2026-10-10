#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import {
  authorizeRestoreDestination, authorizeRestoreObjectBucket, safeRestoreAllowlist, safeRestoreObjectKmsKeyArn,
} from "./backup-restore-policy.mjs";
import {
  backupKeyId, getVersionedObject, latestReusableObjectIndex, publishBackupPackage, readSmallBody,
  requireEmptyVersionedBucket, requireVersionedBucket, streamVersionToFile, verifyCloudCommit,
} from "./backup-cloud-store.mjs";

const CLI = fileURLToPath(new URL("./operations-backup.mjs", import.meta.url));
const HEX_32 = /^[a-f0-9]{64}$/i;
const tiers = new Set(["frequent", "daily", "monthly"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hmac = (bytes, key) => createHmac("sha256", key).update(bytes).digest("hex");

function directDatabaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("DATABASE_URL debe ser una URL PostgreSQL directa válida"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname.split(".").some(label => label.toLowerCase().endsWith("-pooler")) ||
      !["require", "verify-full"].includes(parsed.searchParams.get("sslmode"))) {
    throw new Error("DATABASE_URL debe ser la URL PostgreSQL directa, con TLS y sslmode=require o verify-full");
  }
  return parsed;
}

function required(env, name) {
  if (typeof env[name] !== "string" || !env[name]) throw new Error(`Falta la configuración ${name}`);
  return env[name];
}

function validateConfig(env, mode) {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("El worker cloud requiere Node.js 24");
  const keyText = required(env, "BACKUP_ENCRYPTION_KEY");
  if (!HEX_32.test(keyText)) throw new Error("BACKUP_ENCRYPTION_KEY debe contener 32 bytes hexadecimales; no se inició ninguna conexión");
  const bucket = required(env, "BACKUP_S3_BUCKET");
  const region = required(env, "BACKUP_S3_REGION");
  const kmsKeyArn = required(env, "BACKUP_S3_KMS_KEY_ARN");
  const prefix = (env.BACKUP_S3_PREFIX ?? "bombo").replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9.-]{3,63}$/.test(bucket) || bucket.includes("..")) throw new Error("BACKUP_S3_BUCKET inválido");
  if (!/^[a-z0-9][a-z0-9/_-]{0,180}$/.test(prefix) || prefix.includes("..")) throw new Error("BACKUP_S3_PREFIX inválido");
  if (!/^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/i.test(kmsKeyArn)) throw new Error("BACKUP_S3_KMS_KEY_ARN debe ser el ARN de una clave KMS");
  if (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3", "AWS_S3_ENDPOINT"].some(name => env[name])) {
    throw new Error("El worker sólo admite credenciales ECS task-role y el endpoint regional estándar de S3");
  }
  if (mode === "backup") {
    directDatabaseUrl(required(env, "DATABASE_URL"));
    if (env.PRIVATE_OBJECT_PROVIDER !== "vercel-blob") throw new Error("PRIVATE_OBJECT_PROVIDER debe ser vercel-blob para copiar el almacén actual");
    required(env, "BLOB_READ_WRITE_TOKEN");
    if (!tiers.has(env.BACKUP_TIER ?? "frequent")) throw new Error("BACKUP_TIER debe ser frequent, daily o monthly");
  } else {
    const database = required(env, "RESTORE_DATABASE_URL");
    safeRestoreAllowlist(env.RESTORE_DATABASE_ALLOWLIST ?? "");
    const target = authorizeRestoreDestination(database, env);
    if (target.kind !== "allowlisted-remote") throw new Error("La restauración cloud sólo admite destinos remotos incluidos explícitamente en la allowlist");
    const restoreObjectBucket = authorizeRestoreObjectBucket(required(env, "RESTORE_OBJECT_BUCKET"), env);
    if (restoreObjectBucket === bucket) throw new Error("El destino de objetos debe ser distinto del bucket de backups");
    const restoreObjectRegion = required(env, "RESTORE_OBJECT_REGION");
    if (!/^[a-z0-9-]{3,32}$/.test(restoreObjectRegion)) throw new Error("RESTORE_OBJECT_REGION inválida");
    const restoreObjectKmsKeyArn = safeRestoreObjectKmsKeyArn(required(env, "RESTORE_OBJECT_KMS_KEY_ARN"), restoreObjectRegion);
    required(env, "BACKUP_RESTORE_COMMIT_KEY");
    required(env, "BACKUP_RESTORE_COMMIT_VERSION_ID");
    return {
      key: Buffer.from(keyText, "hex"), bucket, region, kmsKeyArn, prefix,
      keyId: backupKeyId(Buffer.from(keyText, "hex")), restoreObjectBucket, restoreObjectRegion, restoreObjectKmsKeyArn,
    };
  }
  return { key: Buffer.from(keyText, "hex"), bucket, region, kmsKeyArn, prefix, keyId: backupKeyId(Buffer.from(keyText, "hex")) };
}

function runCli(mode, directory, env, parseOutput = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, mode, directory], {
      cwd: dirname(CLI), env, stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {
      if (stdout.length < 256_000) stdout += chunk.slice(0, 256_000 - stdout.length);
    });
    child.once("error", () => reject(new Error(`El CLI ${mode} no pudo iniciar`)));
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`El CLI ${mode} falló con código ${code ?? "desconocido"}; no se publicó un commit`));
      if (!parseOutput) return resolveResult(undefined);
      try { resolveResult(JSON.parse(stdout.trim())); }
      catch { reject(new Error("El CLI no devolvió un resumen válido")); }
    });
  });
}

function safeEntryName(name) {
  return name === "database.dump" || /^objects\/\d+\.bin$/.test(name);
}

function safeObjectKey(key, prefix, tier) {
  return typeof key === "string" && key.startsWith(`${prefix}/${tier}/`) && !key.includes("..") && !key.startsWith("/");
}

function safeCommitKey(key, prefix) {
  if (typeof key !== "string" || !key.startsWith(`${prefix}/`)) return false;
  return /^(?:frequent|daily)\/commits\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9T.-]+\.json$/.test(key.slice(prefix.length + 1)) ||
    /^monthly\/commits\/\d{4}-\d{2}(?:-\d{2})?\/[A-Za-z0-9T.-]+\.json$/.test(key.slice(prefix.length + 1));
}

function retentionSlot(tier, snapshotAt) {
  const parsed = new Date(snapshotAt);
  if (typeof snapshotAt !== "string" || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== snapshotAt) {
    throw new Error("El commit no contiene una fecha UTC canónica");
  }
  return snapshotAt.slice(0, tier === "monthly" ? 7 : 10);
}

function packagePath(root, name) {
  if (!safeEntryName(name)) throw new Error("El paquete contiene una ruta de objeto inválida");
  return join(root, name);
}

function blobChildEnvironment(env) {
  return {
    ...env,
    NODE_ENV: "production",
    PRIVATE_OBJECT_PROVIDER: "vercel-blob",
    PRIVATE_S3_BUCKET: "",
    PRIVATE_S3_ENDPOINT: "",
  };
}

async function backup(env = process.env) {
  const config = validateConfig(env, "backup");
  const tier = env.BACKUP_TIER ?? "frequent";
  const client = new S3Client({ region: config.region });
  await requireVersionedBucket(client, config.bucket);
  const workRoot = await mkdtemp(join(env.BACKUP_WORK_ROOT || tmpdir(), "bombo-cloud-backup-"));
  try {
    const packageDir = join(workRoot, "package");
    const reuseIndex = await latestReusableObjectIndex(client, {
      bucket: config.bucket, region: config.region, prefix: config.prefix, tier, keyId: config.keyId,
      key: config.key, snapshotAt: new Date().toISOString(),
    });
    const childEnv = { ...blobChildEnvironment(env), BACKUP_KEY_ID: config.keyId, BACKUP_TIER: tier };
    if (reuseIndex) {
      const indexPath = join(workRoot, "object-reuse-index.json");
      await writeFile(indexPath, JSON.stringify(reuseIndex), { flag: "wx", mode: 0o600 });
      childEnv.BACKUP_OBJECT_REUSE_INDEX = indexPath;
    } else {
      delete childEnv.BACKUP_OBJECT_REUSE_INDEX;
    }
    const summary = await runCli("backup", packageDir, childEnv, true);
    if (summary?.mode !== "backup" || summary.encrypted !== true || !summary.counts ||
        !Number.isSafeInteger(summary.objectReuse?.sourceObjectReads) || summary.objectReuse.sourceObjectReads < 0 ||
        !Number.isSafeInteger(summary.objectReuse?.reusedDocuments) || summary.objectReuse.reusedDocuments < 0) {
      throw new Error("El CLI no confirmó un backup cifrado completo con métricas de lectura de objetos");
    }
    await runCli("verify", packageDir, childEnv);
    const manifestBytes = await readFile(join(packageDir, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.schemaVersion !== 2 || manifest.encrypted !== true || manifest.databaseMajor !== 18 ||
        !Array.isArray(manifest.files) || !Array.isArray(manifest.objects)) throw new Error("El manifiesto local no cumple el contrato cloud");
    const packageManifestHmac = (await readFile(join(packageDir, "manifest.hmac"), "utf8")).trim();
    const publicationReuseIndex = reuseIndex && reuseIndex.slot === retentionSlot(tier, manifest.snapshotAt) ? reuseIndex : undefined;
    const committed = await publishBackupPackage(client, {
      packageDir, manifest, manifestBytes, manifestHmac: packageManifestHmac, summary,
      bucket: config.bucket, region: config.region, prefix: config.prefix, tier,
      keyId: config.keyId, kmsKeyArn: config.kmsKeyArn, key: config.key, reuseIndex: publicationReuseIndex,
    });
    process.stdout.write(`${JSON.stringify({
      mode: "cloud-backup", ok: true, encrypted: true, committed: true, ...committed,
      objectReuse: {
        authenticatedIndex: Boolean(publicationReuseIndex),
        sourceCommitKey: publicationReuseIndex?.sourceCommitKey,
        sourceCommitVersionId: publicationReuseIndex?.sourceCommitVersionId,
        sourceObjectReads: summary.objectReuse.sourceObjectReads,
        reusedSourceDocuments: summary.objectReuse.reusedDocuments,
        incrementalObjectsReused: committed.reusedObjects,
      },
    })}\n`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    client.destroy();
    config.key.fill(0);
  }
}

async function restore(env = process.env) {
  // Allowlist and TLS are checked before constructing a client or issuing any S3 request.
  const config = validateConfig(env, "restore");
  const client = new S3Client({ region: config.region });
  const destinationClient = new S3Client({ region: config.restoreObjectRegion });
  const commitKey = env.BACKUP_RESTORE_COMMIT_KEY;
  const commitVersion = env.BACKUP_RESTORE_COMMIT_VERSION_ID;
  if (!safeCommitKey(commitKey, config.prefix)) {
    client.destroy(); destinationClient.destroy(); config.key.fill(0); throw new Error("BACKUP_RESTORE_COMMIT_KEY debe apuntar a un commit de retención permitido");
  }
  const workRoot = await mkdtemp(join(env.BACKUP_WORK_ROOT || tmpdir(), "bombo-cloud-restore-"));
  let acknowledgement;
  let stagingCleaned = true;
  try {
    await requireEmptyVersionedBucket(destinationClient, config.restoreObjectBucket);
    await requireVersionedBucket(client, config.bucket);
    const body = await getVersionedObject(client, config.bucket, commitKey, commitVersion);
    const commitBytes = await readSmallBody(body);
    let commit;
    try { commit = JSON.parse(commitBytes.toString("utf8")); } catch { throw new Error("Commit cloud inválido"); }
    if (!verifyCloudCommit(commit, config.key)) throw new Error("Autenticación del commit cloud inválida");
    if (commit.format !== "bombo-cloud-commit-v1" || commit.bucket !== config.bucket || commit.region !== config.region ||
        commit.prefix !== config.prefix || !tiers.has(commit.tier) || commit.databaseMajor !== 18 ||
        typeof commit.snapshotAt !== "string" || commit.packageManifest?.snapshotAt !== commit.snapshotAt ||
        commit.keyId !== config.keyId || !Array.isArray(commit.files) || !commit.packageManifest ||
        commit.packageManifest.encrypted !== true || commit.packageManifest.databaseMajor !== 18) {
      throw new Error("El commit no coincide con la configuración o formato autorizado");
    }
    const objectSlot = retentionSlot(commit.tier, commit.snapshotAt);
    const manifestBytes = Buffer.from(JSON.stringify(commit.packageManifest, null, 2));
    if (hash(manifestBytes) !== commit.packageManifestSha256 || hmac(manifestBytes, config.key) !== commit.packageManifestHmac) {
      throw new Error("Autenticación del manifiesto de paquete inválida");
    }
    if (!safeCommitKey(commitKey, config.prefix) || commit.backupId !== commitKey.slice(commitKey.lastIndexOf("/") + 1, -5) ||
        commit.files.length !== commit.packageManifest.files.length || commit.files.some((file, index) => {
      const entry = commit.packageManifest.files[index];
      const expectedKeys = entry.name === "database.dump"
        ? `${config.prefix}/${commit.tier}/snapshots/${commit.backupId}/database.dump`
        : [
          `${config.prefix}/${commit.tier}/objects/${config.keyId}/${objectSlot}/${entry.storedSha256}.bin`,
          `${config.prefix}/${commit.tier}/objects/${config.keyId}/${objectSlot}/${entry.sha256}.bin`,
        ];
      return file.name !== entry.name || file.packageEntry?.sha256 !== entry.sha256 || !safeEntryName(file.name) ||
        !safeObjectKey(file.key, config.prefix, commit.tier) ||
        (Array.isArray(expectedKeys) ? !expectedKeys.includes(file.key) : file.key !== expectedKeys) ||
        typeof file.versionId !== "string" || !file.versionId || file.versionId === "null" ||
        !Number.isSafeInteger(file.storedBytes) || file.storedBytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.packageEntry.storedSha256 ?? "");
    })) throw new Error("El commit contiene referencias de archivo inválidas");
    const packageDir = join(workRoot, "package");
    await mkdir(join(packageDir, "objects"), { recursive: true, mode: 0o700 });
    for (const file of commit.files) {
      const remote = await getVersionedObject(client, config.bucket, file.key, file.versionId);
      const target = packagePath(packageDir, file.name);
      await streamVersionToFile(remote, target, { bytes: file.storedBytes, storedSha256: file.packageEntry.storedSha256 });
    }
    const manifest = { ...commit.packageManifest, files: commit.files.map(file => file.packageEntry) };
    const restoredManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    await writeFile(join(packageDir, "manifest.json"), restoredManifestBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(packageDir, "manifest.sha256"), `${hash(restoredManifestBytes)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(packageDir, "manifest.hmac"), `${hmac(restoredManifestBytes, config.key)}\n`, { flag: "wx", mode: 0o600 });
    const cliEnv = {
      ...env,
      NODE_ENV: "production",
      PRIVATE_OBJECT_PROVIDER: "local",
      PRIVATE_S3_BUCKET: "",
      BLOB_READ_WRITE_TOKEN: "",
      RESTORE_OBJECT_PROVIDER: "s3",
      RESTORE_OBJECT_BUCKET: config.restoreObjectBucket,
      RESTORE_OBJECT_BUCKET_ALLOWLIST: config.restoreObjectBucket,
      RESTORE_OBJECT_REGION: config.restoreObjectRegion,
      RESTORE_OBJECT_KMS_KEY_ARN: config.restoreObjectKmsKeyArn,
      BACKUP_RESTORE_BACKUP_ID: commit.backupId,
    };
    await runCli("verify", packageDir, cliEnv);
    await requireEmptyVersionedBucket(destinationClient, config.restoreObjectBucket);
    const restoreSummary = await runCli("restore", packageDir, cliEnv, true);
    const expectedManifestHash = hash(restoredManifestBytes);
    const expectedObjectCount = commit.packageManifest.objects.length;
    if (restoreSummary?.mode !== "restore" || restoreSummary.scope !== "coordinated-cloud" ||
        restoreSummary.integrity !== true || restoreSummary.migrationsValid !== true ||
        restoreSummary.objectReferencesCommitted !== true || restoreSummary.objectReferenceCount !== expectedObjectCount ||
        restoreSummary.objectsVerified !== expectedObjectCount || restoreSummary.destinationBucket !== config.restoreObjectBucket ||
        restoreSummary.manifestHash !== expectedManifestHash || !/^[a-f0-9]{64}$/.test(restoreSummary.objectMappingsSha256 ?? "") ||
        typeof restoreSummary.auditId !== "string" || !restoreSummary.auditId ||
        !Number.isSafeInteger(restoreSummary.elapsedMilliseconds) || restoreSummary.elapsedMilliseconds < 0) {
      throw new Error("La base u objetos se restauraron, pero el CLI no confirmó el commit transaccional de referencias y auditoría");
    }
    acknowledgement = {
      mode: "cloud-restore", ok: true, integrity: true, committed: true,
      objectReferencesCommitted: true, objectReferenceCount: expectedObjectCount,
      objectsVerified: expectedObjectCount, objectMappingsSha256: restoreSummary.objectMappingsSha256,
      auditId: restoreSummary.auditId, manifestHash: restoreSummary.manifestHash,
      destinationBucket: config.restoreObjectBucket, elapsedMilliseconds: restoreSummary.elapsedMilliseconds,
      backupId: commit.backupId, tier: commit.tier, snapshotAt: commit.snapshotAt, stagingCleaned: true,
      files: commit.files.length, target: "allowlisted-empty-database", scope: "coordinated-cloud",
    };
  } finally {
    try {
      await rm(workRoot, { recursive: true, force: true });
    } catch {
      stagingCleaned = false;
    } finally {
      client.destroy();
      destinationClient.destroy();
      config.key.fill(0);
    }
  }
  if (!acknowledgement) throw new Error("El restore cloud terminó sin acuse durable");
  if (!stagingCleaned) {
    acknowledgement = { ...acknowledgement, ok: false, stagingCleaned: false, error: "RESTORE_STAGING_CLEANUP_FAILED" };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(acknowledgement)}\n`);
}

const mode = process.argv[2];
if (process.argv.length !== 3 || !["backup", "restore"].includes(mode)) throw new Error("Uso: operations-backup-cloud-worker.mjs backup|restore");
const run = mode === "backup" ? backup : restore;
run().catch(error => {
  process.stderr.write(`${JSON.stringify({ mode: `cloud-${mode}`, ok: false, error: error instanceof Error ? error.message : "Fallo no identificado" })}\n`);
  process.exitCode = 1;
});
