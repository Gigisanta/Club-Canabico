import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import {
  backupKeyId, publishBackupPackage, putVersionedFile, requireVersionedBucket, signCloudCommit, verifyCloudCommit,
} from "../scripts/backup-cloud-store.mjs";
import {
  authorizeRestoreDestination, authorizeRestoreObjectBucket, requireEmptyRestoreDatabase,
  safeRestoreAllowlist, safeRestoreObjectBucketAllowlist,
} from "../scripts/backup-restore-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cloudWorker = join(repositoryRoot, "scripts/operations-backup-cloud-worker.mjs");

function runCloudWorker(env: Record<string, string>, mode: "backup" | "restore" = "backup") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [cloudWorker, mode], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolveResult({ code, stdout, stderr }));
  });
}

test("cloud publisher uploads a durable commit last and reuses the exact encrypted object version by content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "bombo-cloud-publisher-"));
  const key = Buffer.from("a".repeat(64), "hex");
  const keyId = backupKeyId(key);
  const kmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
  const filesDir = join(root, "package");
  await mkdir(join(filesDir, "objects"), { recursive: true });
  const storedDump = Buffer.from("encrypted database dump");
  const storedObject = Buffer.from("encrypted document");
  const dump = { name: "database.dump", bytes: 23, sha256: "1".repeat(64), storedSha256: createHash("sha256").update(storedDump).digest("hex"), encryption: { algorithm: "AES-256-GCM", iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" } };
  const object = { name: "objects/0.bin", bytes: 16, sha256: "2".repeat(64), storedSha256: createHash("sha256").update(storedObject).digest("hex"), encryption: { algorithm: "AES-256-GCM", iv: "BBBBBBBBBBBBBBBB", tag: "BBBBBBBBBBBBBBBBBBBBBB==" } };
  const manifest = { schemaVersion: 2, encrypted: true, databaseMajor: 18, snapshotAt: "2026-10-01T00:00:00.000Z", counts: {}, files: [dump, object], objects: [{ file: "objects/0.bin" }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestHmac = createHmac("sha256", key).update(manifestBytes).digest("hex");
  await writeFile(join(filesDir, "manifest.json"), manifestBytes);
  await writeFile(join(filesDir, "database.dump"), storedDump);
  await writeFile(join(filesDir, "objects/0.bin"), storedObject);
  const requests: Array<{ name: string; key?: string; metadata?: Record<string, string> }> = [];
  const objects = new Map<string, { VersionId: string; bytes: Buffer; Metadata: Record<string, string>; ChecksumSHA256: string }>();
  let nextVersion = 0;
  const client = {
    async send(command: any) {
      const name = command.constructor.name;
      const input = command.input;
      requests.push({ name, key: input.Key });
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (name === "HeadObjectCommand") {
        assert.equal(input.ChecksumMode, "ENABLED");
        const current = objects.get(input.Key);
        if (!current) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { VersionId: current.VersionId, ContentLength: current.bytes.length, Metadata: current.Metadata, ChecksumSHA256: current.ChecksumSHA256 };
      }
      if (name === "PutObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        assert.equal(input.ServerSideEncryption, "aws:kms");
        assert.equal(input.SSEKMSKeyId, kmsKeyArn);
        const chunks: Buffer[] = Buffer.isBuffer(input.Body) ? [Buffer.from(input.Body)] : [];
        if (chunks.length === 0) for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, input.ContentLength);
        const VersionId = `version-${++nextVersion}`;
        if (!input.Key.includes("/commits/")) objects.set(input.Key, { VersionId, bytes, Metadata: input.Metadata ?? {}, ChecksumSHA256: input.ChecksumSHA256 });
        return { VersionId };
      }
      throw new Error(`Unexpected S3 request: ${name}`);
    },
  };
  try {
    await requireVersionedBucket(client as any, "bombo-backup-test");
    const input = { packageDir: filesDir, manifest, manifestBytes, manifestHmac, summary: { counts: {} }, bucket: "bombo-backup-test", region: "us-east-1", prefix: "bombo", tier: "frequent", keyId, kmsKeyArn, key };
    const first = await publishBackupPackage(client as any, input);
    const firstCommitIndex = requests.findIndex(request => request.key === first.commitKey);
    assert.equal(firstCommitIndex, requests.length - 1);
    assert.equal(first.files, 2);
    assert.equal(first.reusedObjects, 0);
    const objectKey = `bombo/frequent/objects/${keyId}/2026-10-01/${object.storedSha256}.bin`;
    const firstObjectUpload = requests.find(request => request.key === objectKey);
    assert.ok(firstObjectUpload);

    const beforeSecond = requests.length;
    const second = await publishBackupPackage(client as any, input);
    const secondRequests = requests.slice(beforeSecond);
    assert.equal(second.reusedObjects, 1);
    assert.deepEqual(secondRequests.map(request => request.name), ["PutObjectCommand", "HeadObjectCommand", "PutObjectCommand"]);
    const secondCommit = secondRequests.at(-1)!;
    assert.match(secondCommit.key!, /\/frequent\/commits\//);
    assert.equal(secondRequests.at(-1)?.key, second.commitKey);
    const preserved = objects.get(objectKey)!;
    assert.equal(preserved.VersionId, "version-2");

    preserved.ChecksumSHA256 = Buffer.from("0".repeat(32)).toString("base64");
    const beforeBadChecksum = requests.length;
    await assert.rejects(publishBackupPackage(client as any, input), /content-addressed existente no coincide/);
    assert.deepEqual(requests.slice(beforeBadChecksum).map(request => request.name), ["PutObjectCommand", "HeadObjectCommand"]);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 ConditionalRequestConflict retries with fresh bodies and stops after three attempts", async () => {
  const stored = Buffer.from("immutable encrypted object");
  const packageEntry = {
    name: "objects/7.bin", bytes: stored.length, sha256: "a".repeat(64),
    storedSha256: createHash("sha256").update(stored).digest("hex"),
  };
  let puts = 0;
  let heads = 0;
  let bodies = 0;
  const client = {
    async send(command: any) {
      if (command.constructor.name === "HeadObjectCommand") {
        heads++;
        throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      assert.equal(command.constructor.name, "PutObjectCommand");
      puts++;
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), stored);
      throw Object.assign(new Error("concurrent conditional write"), {
        name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 },
      });
    },
  };

  await assert.rejects(putVersionedFile(client as any, {
    bucket: "bombo-backup-test", key: "bombo/frequent/objects/key/2026-10-01/object.bin",
    contentAddressed: true, keyId: "key-id", packageEntry, body: () => { bodies++; return Readable.from([stored]); },
    contentLength: stored.length, kmsKeyArn: "test-kms-key",
  }), error => (error as Error).name === "ConditionalRequestConflict");
  assert.equal(puts, 3);
  assert.equal(heads, 4, "one initial lookup plus one lookup after each conditional conflict");
  assert.equal(bodies, 3);
});

test("cloud commit HMAC rejects content changes", () => {
  const key = Buffer.from("b".repeat(64), "hex");
  const signed = signCloudCommit({ format: "bombo-cloud-commit-v1", files: [{ key: "x", versionId: "v1" }] }, key);
  assert.equal(verifyCloudCommit(signed, key), true);
  assert.equal(verifyCloudCommit({ ...signed, files: [{ key: "x", versionId: "v2" }] }, key), false);
});

test("remote restore requires TLS hostname verification and an exact host/database allowlist", () => {
  const target = "ep-example.us-east-1.aws.neon.tech/bombo_restore";
  const url = "postgresql://restore:placeholder@ep-example.us-east-1.aws.neon.tech/bombo_restore?sslmode=verify-full";
  assert.deepEqual(safeRestoreAllowlist(target), [target]);
  assert.equal(authorizeRestoreDestination(url, { RESTORE_DATABASE_ALLOWLIST: target }).kind, "allowlisted-remote");
  for (const [candidateUrl, allowlist] of [
    [url, ""],
    [url, "*"],
    [url, "ep-example.us-east-1.aws.neon.tech/other"],
    [url.replace("sslmode=verify-full", "sslmode=require"), target],
  ]) assert.throws(() => authorizeRestoreDestination(candidateUrl, { RESTORE_DATABASE_ALLOWLIST: allowlist }));
  assert.throws(() => safeRestoreAllowlist("*.neon.tech/bombo_restore"));
});

test("restore object bucket is accepted only by exact local allowlist policy", () => {
  const bucket = "bombo-restore-objects";
  assert.deepEqual(safeRestoreObjectBucketAllowlist(bucket), [bucket]);
  assert.equal(authorizeRestoreObjectBucket(bucket, { RESTORE_OBJECT_BUCKET_ALLOWLIST: bucket }), bucket);
  for (const [candidate, allowlist] of [
    [bucket, ""],
    [bucket, "*"],
    ["bombo-other-objects", bucket],
    [bucket, `${bucket},${bucket}`],
  ]) assert.throws(() => authorizeRestoreObjectBucket(candidate, { RESTORE_OBJECT_BUCKET_ALLOWLIST: allowlist }));
  assert.throws(() => safeRestoreObjectBucketAllowlist("bombo..restore"));
});

test("restore emptiness guard accepts zero catalog objects and fails closed on any or invalid count", async () => {
  const databaseWithCount = (count: unknown) => ({ async $queryRawUnsafe() { return [{ count }]; } });
  await assert.doesNotReject(requireEmptyRestoreDatabase(databaseWithCount(0)));
  await assert.rejects(requireEmptyRestoreDatabase(databaseWithCount(1)), /El destino contiene objetos/);
  await assert.rejects(requireEmptyRestoreDatabase(databaseWithCount("unknown")), /No se pudo comprobar el catálogo/);
});

test("cloud restore requires a distinct exact-allowlisted destination bucket and same-region KMS key before AWS access", async () => {
  const restoreEnv = {
    BACKUP_ENCRYPTION_KEY: "a".repeat(64),
    BACKUP_S3_BUCKET: "bombo-backup-source",
    BACKUP_S3_REGION: "us-east-1",
    BACKUP_S3_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
    RESTORE_DATABASE_URL: "postgresql://restore:placeholder@ep-example.us-east-1.aws.neon.tech/bombo_restore?sslmode=verify-full",
    RESTORE_DATABASE_ALLOWLIST: "ep-example.us-east-1.aws.neon.tech/bombo_restore",
    RESTORE_OBJECT_BUCKET: "bombo-restore-target",
    RESTORE_OBJECT_BUCKET_ALLOWLIST: "bombo-restore-target",
    RESTORE_OBJECT_REGION: "us-east-1",
    RESTORE_OBJECT_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/abcdefab-cdef-abcd-efab-cdefabcdefab",
    BACKUP_RESTORE_COMMIT_KEY: "bombo/frequent/commits/backup-20261001T000000Z-abc.json",
    BACKUP_RESTORE_COMMIT_VERSION_ID: "commit-version-1",
  };
  const sharedBucket = await runCloudWorker({
    ...restoreEnv,
    RESTORE_OBJECT_BUCKET: restoreEnv.BACKUP_S3_BUCKET,
    RESTORE_OBJECT_BUCKET_ALLOWLIST: restoreEnv.BACKUP_S3_BUCKET,
  }, "restore");
  assert.match(sharedBucket.stderr, /distinto del bucket de backups/);

  const unallowlisted = await runCloudWorker({
    ...restoreEnv,
    RESTORE_OBJECT_BUCKET_ALLOWLIST: "bombo-other-target",
  }, "restore");
  assert.match(unallowlisted.stderr, /RESTORE_OBJECT_BUCKET debe coincidir exactamente/);

  const wrongKmsRegion = await runCloudWorker({
    ...restoreEnv,
    RESTORE_OBJECT_KMS_KEY_ARN: restoreEnv.RESTORE_OBJECT_KMS_KEY_ARN.replace("us-east-1", "us-west-2"),
  }, "restore");
  assert.match(wrongKmsRegion.stderr, /RESTORE_OBJECT_KMS_KEY_ARN.*RESTORE_OBJECT_REGION/);
});

test("cloud worker rejects the currently invalid key format before network configuration or AWS access", async () => {
  const result = await runCloudWorker({ BACKUP_ENCRYPTION_KEY: "do-not-print" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /BACKUP_ENCRYPTION_KEY.*32 bytes hexadecimales/);
  assert.equal(`${result.stdout}${result.stderr}`.includes("do-not-print"), false);
});

test("cloud backup accepts only a direct TLS PostgreSQL URL before reading source configuration", async () => {
  const base = {
    BACKUP_ENCRYPTION_KEY: "a".repeat(64),
    BACKUP_S3_BUCKET: "bombo-backup-test",
    BACKUP_S3_REGION: "us-east-1",
    BACKUP_S3_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
    PRIVATE_OBJECT_PROVIDER: "local",
  };
  const pooled = await runCloudWorker({
    ...base,
    DATABASE_URL: "postgresql://backup:placeholder@ep-sample-pooler.us-east-1.aws.neon.tech/bombo?sslmode=require",
  });
  assert.match(pooled.stderr, /URL PostgreSQL directa, con TLS/);

  const noTls = await runCloudWorker({
    ...base,
    DATABASE_URL: "postgresql://backup:placeholder@ep-sample.us-east-1.aws.neon.tech/bombo",
  });
  assert.match(noTls.stderr, /URL PostgreSQL directa, con TLS/);

  const directTls = await runCloudWorker({
    ...base,
    DATABASE_URL: "postgresql://backup:placeholder@ep-sample.us-east-1.aws.neon.tech/bombo?sslmode=require",
  });
  assert.match(directTls.stderr, /PRIVATE_OBJECT_PROVIDER debe ser vercel-blob/);
  assert.doesNotMatch(directTls.stderr, /URL PostgreSQL directa, con TLS/);
});
