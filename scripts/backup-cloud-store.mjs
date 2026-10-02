import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand,
  ListObjectsV2Command, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { objectReuseIdentity, signObjectReuseIndex, verifyObjectReuseIndex } from "./backup-object-reuse.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const noSignature = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hmacSha256"));
const sameCanonical = (left, right) => canonical(left) === canonical(right);

function retentionSlot(tier, snapshotAt) {
  const parsed = new Date(snapshotAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== snapshotAt) throw new Error("La instantánea no tiene fecha UTC canónica");
  return tier === "monthly" ? snapshotAt.slice(0, 7) : snapshotAt.slice(0, 10);
}

export const backupKeyId = key => digest(key).slice(0, 24);

export function signCloudCommit(commit, key) {
  return { ...commit, hmacSha256: createHmac("sha256", key).update(canonical(noSignature(commit))).digest("hex") };
}

export function verifyCloudCommit(commit, key) {
  if (!commit || typeof commit !== "object" || typeof commit.hmacSha256 !== "string" || !/^[a-f0-9]{64}$/.test(commit.hmacSha256)) return false;
  const expected = createHmac("sha256", key).update(canonical(noSignature(commit))).digest();
  const actual = Buffer.from(commit.hmacSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function requireVersionedBucket(client, bucket) {
  const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (result.Status !== "Enabled") throw new Error("El bucket de backup debe tener versionado habilitado");
}

export async function requireEmptyVersionedBucket(client, bucket) {
  await requireVersionedBucket(client, bucket);
  let KeyMarker, VersionIdMarker;
  const seenMarkers = new Set();
  for (;;) {
    const result = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}), MaxKeys: 1000,
    }));
    if ((result.Versions?.length ?? 0) > 0 || (result.DeleteMarkers?.length ?? 0) > 0) {
      throw new Error("El destino de objetos de restauración debe estar vacío, incluidas las versiones y marcadores de borrado");
    }
    if (result.IsTruncated !== true) return;
    const nextKey = result.NextKeyMarker, nextVersion = result.NextVersionIdMarker;
    if (typeof nextKey !== "string" || !nextKey || (nextVersion !== undefined && typeof nextVersion !== "string")) {
      throw new Error("S3 devolvió una página de versiones sin marcadores de continuación válidos");
    }
    const marker = `${nextKey}\0${nextVersion ?? ""}`;
    if (seenMarkers.has(marker) || (nextKey === KeyMarker && nextVersion === VersionIdMarker)) {
      throw new Error("S3 repitió los marcadores al revisar el destino de objetos");
    }
    seenMarkers.add(marker);
    KeyMarker = nextKey;
    VersionIdMarker = nextVersion;
  }
}

function versionId(result) {
  if (typeof result.VersionId !== "string" || !result.VersionId || result.VersionId === "null") {
    throw new Error("S3 no devolvió VersionId; el bucket debe conservar versiones inmutables");
  }
  return result.VersionId;
}

function notFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey";
}

function conflict(error) {
  return error?.$metadata?.httpStatusCode === 412 || error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 409 || error?.name === "ConditionalRequestConflict";
}

function retryableConditionalConflict(error) {
  return error?.$metadata?.httpStatusCode === 409 || error?.name === "ConditionalRequestConflict";
}

function parseEntry(metadata) {
  try { return JSON.parse(Buffer.from(metadata?.["package-entry"] ?? "", "base64url").toString("utf8")); }
  catch { return null; }
}

async function existingContent(client, bucket, key, expected) {
  let result;
  try { result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" })); }
  catch (error) { if (notFound(error)) return null; throw error; }
  const entry = parseEntry(result.Metadata);
  if (!entry || result.Metadata?.["content-sha256"] !== expected.sha256 ||
      result.Metadata?.["key-id"] !== expected.keyId || entry.sha256 !== expected.sha256 ||
      !sameCanonical(entry, expected.packageEntry) || !/^[a-f0-9]{64}$/.test(entry.storedSha256 ?? "") ||
      result.ContentLength !== Number(result.Metadata?.["stored-bytes"]) ||
      result.ChecksumSHA256 !== Buffer.from(entry.storedSha256, "hex").toString("base64")) {
    throw new Error("El objeto content-addressed existente no coincide con su identidad autenticada");
  }
  if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0) throw new Error("S3 no informó tamaño del objeto content-addressed");
  return { key, versionId: versionId(result), packageEntry: entry, storedBytes: result.ContentLength, reused: true };
}

export async function putVersionedFile(client, {
  bucket, key, contentAddressed, keyId, packageEntry, body, contentLength, kmsKeyArn,
}) {
  if (contentAddressed) {
    const existing = await existingContent(client, bucket, key, { sha256: packageEntry.sha256, keyId, packageEntry });
    if (existing) return existing;
  }
  const metadata = {
    "content-sha256": packageEntry.sha256,
    "key-id": keyId,
    "stored-bytes": String(contentLength),
    "package-entry": Buffer.from(JSON.stringify(packageEntry)).toString("base64url"),
  };
  const bodyFactory = typeof body === "function" ? body : () => body;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bodyFactory(), ContentLength: contentLength,
        Metadata: metadata, IfNoneMatch: "*", ChecksumSHA256: Buffer.from(packageEntry.storedSha256, "hex").toString("base64"),
        ServerSideEncryption: "aws:kms", SSEKMSKeyId: kmsKeyArn,
      }));
      return { key, versionId: versionId(result), packageEntry, storedBytes: contentLength, reused: false };
    } catch (error) {
      if (!contentAddressed || !conflict(error)) throw error;
      const existing = await existingContent(client, bucket, key, { sha256: packageEntry.sha256, keyId, packageEntry });
      if (existing) return existing;
      if (!retryableConditionalConflict(error) || attempt + 1 === maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw new Error("S3 conditional object write exceeded its retry limit");
}

async function verifyExactStoredVersion(client, { bucket, key, versionId: expectedVersion, packageEntry, storedBytes, keyId }) {
  const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: expectedVersion, ChecksumMode: "ENABLED" }));
  const entry = parseEntry(result.Metadata);
  if (result.VersionId !== expectedVersion || result.ContentLength !== storedBytes ||
      result.ContentLength !== Number(result.Metadata?.["stored-bytes"]) ||
      result.Metadata?.["key-id"] !== keyId || result.Metadata?.["content-sha256"] !== packageEntry.sha256 ||
      result.ChecksumSHA256 !== Buffer.from(packageEntry.storedSha256, "hex").toString("base64") ||
      !sameCanonical(entry, packageEntry)) {
    throw new Error("La versión S3 reutilizada no coincide con el checksum, tamaño o manifiesto exactos");
  }
  return true;
}

function safeEntryName(name) {
  return name === "database.dump" || /^objects\/\d+\.bin$/.test(name);
}

function safeCommitObjectKey(key, prefix, tier) {
  return typeof key === "string" && key.startsWith(`${prefix}/${tier}/`) && !key.includes("..") && !key.startsWith("/");
}

function reuseCommitShape(commit, { bucket, region, prefix, tier, keyId, key, commitKey, slot }) {
  let commitSlot;
  try { commitSlot = retentionSlot(tier, commit?.snapshotAt); } catch { return false; }
  if (!verifyCloudCommit(commit, key) || commit.format !== "bombo-cloud-commit-v1" ||
      commit.bucket !== bucket || commit.region !== region || commit.prefix !== prefix ||
      commit.tier !== tier || commit.keyId !== keyId || commit.databaseMajor !== 18 ||
      commitSlot !== slot || commit.packageManifest?.snapshotAt !== commit.snapshotAt ||
      commit.packageManifest?.encrypted !== true || commit.packageManifest?.databaseMajor !== 18 ||
      !Array.isArray(commit.packageManifest.files) || !Array.isArray(commit.packageManifest.objects) ||
      !Array.isArray(commit.files) || commit.files.length !== commit.packageManifest.files.length ||
      typeof commit.backupId !== "string" || !/^[A-Za-z0-9T.-]{1,100}$/.test(commit.backupId) ||
      !commitKey.endsWith(`/${commit.backupId}.json`)) return false;
  const manifestBytes = Buffer.from(JSON.stringify(commit.packageManifest, null, 2));
  if (digest(manifestBytes) !== commit.packageManifestSha256 ||
      createHmac("sha256", key).update(manifestBytes).digest("hex") !== commit.packageManifestHmac) return false;
  const expectedNames = new Set();
  for (let index = 0; index < commit.files.length; index++) {
    const file = commit.files[index], entry = commit.packageManifest.files[index];
    if (!safeEntryName(entry?.name) || expectedNames.has(entry.name) || file.name !== entry.name ||
        !sameCanonical(file.packageEntry, entry) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
        !/^[a-f0-9]{64}$/.test(entry.storedSha256 ?? "") || !Number.isSafeInteger(file.storedBytes) || file.storedBytes < 0 ||
        typeof file.versionId !== "string" || !file.versionId || file.versionId === "null" ||
        !safeCommitObjectKey(file.key, prefix, tier)) return false;
    const expectedObjectKey = entry.name === "database.dump"
      ? `${prefix}/${tier}/snapshots/${commit.backupId}/database.dump`
      : `${prefix}/${tier}/objects/${keyId}/${slot}/${entry.storedSha256}.bin`;
    if (file.key !== expectedObjectKey) return false;
    expectedNames.add(entry.name);
  }
  const fileNames = new Set(commit.packageManifest.files.map(file => file.name));
  if (!fileNames.has("database.dump") || commitKey !== `${prefix}/${tier}/commits/${slot}/${commit.backupId}.json` ||
      commit.packageManifest.objects.some(object => !object || !fileNames.has(object.file))) return false;
  return true;
}

/** Return an HMAC-authenticated index containing only exact source rows and verified S3 versions. */
export async function latestReusableObjectIndex(client, {
  bucket, region, prefix, tier, keyId, key, snapshotAt,
}) {
  if (!["frequent", "daily", "monthly"].includes(tier)) throw new Error("Tier de retención inválido");
  const slot = retentionSlot(tier, snapshotAt);
  const partition = tier === "monthly" ? slot : `${slot}/`;
  const listPrefix = `${prefix}/${tier}/commits/${partition}`;
  let ContinuationToken;
  const commits = [];
  for (let page = 0; page < 100; page++) {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: listPrefix, MaxKeys: 1000, ...(ContinuationToken ? { ContinuationToken } : {}),
    }));
    for (const item of result.Contents ?? []) {
      if (typeof item.Key === "string" && item.Key.endsWith(".json")) commits.push(item);
    }
    if (result.IsTruncated !== true) break;
    if (typeof result.NextContinuationToken !== "string" || !result.NextContinuationToken || result.NextContinuationToken === ContinuationToken) {
      throw new Error("S3 devolvió una página de commits sin cursor válido");
    }
    ContinuationToken = result.NextContinuationToken;
    if (page === 99) return undefined;
  }
  commits.sort((left, right) => {
    const byTime = new Date(right.LastModified ?? 0).valueOf() - new Date(left.LastModified ?? 0).valueOf();
    return byTime || String(right.Key).localeCompare(String(left.Key));
  });

  for (const candidate of commits) {
    let head;
    try { head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: candidate.Key, ChecksumMode: "ENABLED" })); }
    catch (error) { if (notFound(error)) continue; throw error; }
    const commitVersionId = head.VersionId;
    if (typeof commitVersionId !== "string" || !commitVersionId || commitVersionId === "null") continue;
    const body = await getVersionedObject(client, bucket, candidate.Key, commitVersionId);
    const commitBytes = await readSmallBody(body);
    let commit;
    try { commit = JSON.parse(commitBytes.toString("utf8")); } catch { continue; }
    if (!reuseCommitShape(commit, { bucket, region, prefix, tier, keyId, key, commitKey: candidate.Key, slot })) continue;

    const commitFiles = new Map(commit.files.map(file => [file.name, file]));
    const reusableByIdentity = new Map();
    for (const source of commit.packageManifest.objects) {
      const file = commitFiles.get(source.file);
      if (!file || source.objectVersion === "null" || !source.objectKey || !source.objectVersion ||
          !/^[a-f0-9]{64}$/.test(source.checksum ?? "") || !Number.isSafeInteger(source.bytes) || source.bytes < 0 ||
          typeof source.mediaType !== "string" || !source.mediaType || file.packageEntry.sha256 !== source.checksum ||
          file.packageEntry.bytes !== source.bytes || file.packageEntry.encryption?.algorithm !== "AES-256-GCM") continue;
      try {
        await verifyExactStoredVersion(client, {
          bucket, key: file.key, versionId: file.versionId, packageEntry: file.packageEntry,
          storedBytes: file.storedBytes, keyId,
        });
      } catch (error) {
        if (notFound(error)) continue;
        throw error;
      }
      const reusable = {
        objectKey: source.objectKey,
        objectVersion: source.objectVersion,
        checksum: source.checksum,
        bytes: source.bytes,
        mediaType: source.mediaType,
        file: source.file,
        packageEntry: file.packageEntry,
        sourceKey: file.key,
        sourceVersionId: file.versionId,
        storedBytes: file.storedBytes,
      };
      const identity = objectReuseIdentity(source);
      const previous = reusableByIdentity.get(identity);
      if (!previous) reusableByIdentity.set(identity, reusable);
    }
    return signObjectReuseIndex({
      format: "bombo-object-reuse-v1", tier, bucket, region, prefix, keyId, slot,
      sourceCommitKey: candidate.Key, sourceCommitVersionId: commitVersionId, objects: [...reusableByIdentity.values()],
    }, key);
  }
  return undefined;
}

export async function putCommitLast(client, { bucket, key, bytes, kmsKeyArn }) {
  const result = await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
    ContentType: "application/json", CacheControl: "no-store", IfNoneMatch: "*",
    ChecksumSHA256: Buffer.from(digest(bytes), "hex").toString("base64"),
    ServerSideEncryption: "aws:kms", SSEKMSKeyId: kmsKeyArn,
  }));
  return versionId(result);
}

export async function publishBackupPackage(client, {
  packageDir, manifest, manifestBytes, manifestHmac, summary, bucket, region, prefix,
  tier, keyId, kmsKeyArn, key, reuseIndex,
}) {
  if (!["frequent", "daily", "monthly"].includes(tier)) throw new Error("Tier de retención inválido");
  if (digest(await readFile(join(packageDir, "manifest.json"))) !== digest(manifestBytes) ||
      createHmac("sha256", key).update(manifestBytes).digest("hex") !== manifestHmac) {
    throw new Error("El paquete local cambió antes de subirlo al bucket cloud");
  }
  if (reuseIndex && !verifyObjectReuseIndex(reuseIndex, key, { tier, bucket, region, prefix, keyId })) {
    throw new Error("El índice de reutilización dejó de estar autenticado o no coincide con esta publicación");
  }
  const backupId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const objectSlot = retentionSlot(tier, manifest.snapshotAt);
  const uploads = [];
  let reusedObjects = 0;
  const reuseByFile = new Map((reuseIndex?.objects ?? []).map(object => [object.file, object]));
  for (const entry of manifest.files) {
    if (entry.name !== "database.dump" && !/^objects\/\d+\.bin$/.test(entry.name)) throw new Error("Nombre de archivo de paquete inválido");
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(entry.storedSha256 ?? "")) throw new Error("Checksum del paquete inválido");
    const isObject = entry.name.startsWith("objects/");
    const previous = isObject ? reuseByFile.get(entry.name) : undefined;
    if (previous) {
      const expectedObjectKey = `${prefix}/${tier}/objects/${keyId}/${objectSlot}/${entry.storedSha256}.bin`;
      if (!sameCanonical(entry, previous.packageEntry) || previous.sourceKey !== expectedObjectKey) {
        throw new Error("La referencia incremental no coincide con el mismo objeto cifrado y el slot de retención");
      }
      await verifyExactStoredVersion(client, {
        bucket, key: previous.sourceKey, versionId: previous.sourceVersionId,
        packageEntry: entry, storedBytes: previous.storedBytes, keyId,
      });
      uploads.push({ name: entry.name, key: previous.sourceKey, versionId: previous.sourceVersionId, storedBytes: previous.storedBytes, packageEntry: entry });
      reusedObjects++;
      continue;
    }
    const localPath = join(packageDir, entry.name);
    const fileInfo = await lstat(localPath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("El paquete incluye un archivo no regular");
    const objectKey = isObject
      ? `${prefix}/${tier}/objects/${keyId}/${objectSlot}/${entry.storedSha256}.bin`
      : `${prefix}/${tier}/snapshots/${backupId}/database.dump`;
    const uploaded = await putVersionedFile(client, {
      bucket, key: objectKey, contentAddressed: isObject, keyId, packageEntry: entry,
      body: () => createReadStream(localPath), contentLength: fileInfo.size, kmsKeyArn,
    });
    if (uploaded.reused) reusedObjects++;
    uploads.push({ name: entry.name, key: uploaded.key, versionId: uploaded.versionId, storedBytes: uploaded.storedBytes, packageEntry: uploaded.packageEntry });
  }
  const names = new Set(uploads.map(file => file.name));
  if (uploads.length !== names.size || manifest.objects.some(object => !names.has(object.file)) ||
      uploads.some(file => !sameCanonical(file.packageEntry, manifest.files.find(entry => entry.name === file.name)))) {
    throw new Error("El paquete tiene referencias de objeto incompletas o diferentes del manifiesto autenticado");
  }
  const committedAt = new Date().toISOString();
  const commitKey = `${prefix}/${tier}/commits/${objectSlot}/${backupId}.json`;
  const commit = signCloudCommit({
    format: "bombo-cloud-commit-v1", committedAt, backupId, tier, bucket, region, prefix, keyId,
    databaseMajor: manifest.databaseMajor, snapshotAt: manifest.snapshotAt,
    packageManifestSha256: digest(manifestBytes), packageManifestHmac: manifestHmac,
    packageManifest: manifest, counts: summary.counts, files: uploads,
  }, key);
  const version = await putCommitLast(client, { bucket, key: commitKey, bytes: Buffer.from(`${JSON.stringify(commit, null, 2)}\n`), kmsKeyArn });
  return { backupId, tier, commitKey, commitVersionId: version, files: uploads.length, reusedObjects, snapshotAt: manifest.snapshotAt };
}

export async function getVersionedObject(client, bucket, key, version) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
  if (!result.Body || versionId(result) !== version) throw new Error("S3 no devolvió la versión exacta solicitada");
  return result.Body;
}

export async function streamVersionToFile(body, destination, expected) {
  const file = await open(destination, "wx", 0o600);
  const hasher = createHash("sha256");
  let bytes = 0;
  const tally = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; hasher.update(chunk); done(null, chunk); } });
  try {
    await pipeline(body, tally, file.createWriteStream());
    if (bytes !== expected.bytes || hasher.digest("hex") !== expected.storedSha256) throw new Error("Checksum o tamaño del objeto S3 inválido");
  } catch (error) { await rm(destination, { force: true }); throw error; }
  finally { await file.close(); }
}

export async function readSmallBody(body, maximumBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("El manifiesto cloud supera el tamaño máximo permitido");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
