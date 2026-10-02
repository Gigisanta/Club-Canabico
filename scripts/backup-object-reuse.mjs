import { createHmac, timingSafeEqual } from "node:crypto";

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => key !== "hmacSha256").sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

export function objectReuseIdentity(document) {
  return JSON.stringify([
    document.objectKey,
    document.objectVersion,
    document.checksum,
    document.bytes,
    document.mediaType ?? null,
  ]);
}

export function signObjectReuseIndex(index, key) {
  return {
    ...index,
    hmacSha256: createHmac("sha256", key).update(canonical(index)).digest("hex"),
  };
}

export function verifyObjectReuseIndex(index, key, expected = {}) {
  if (!index || typeof index !== "object" || Array.isArray(index) ||
      index.format !== "bombo-object-reuse-v1" || typeof index.hmacSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(index.hmacSha256) || !Array.isArray(index.objects) ||
      typeof index.tier !== "string" || !["frequent", "daily", "monthly"].includes(index.tier) ||
      typeof index.bucket !== "string" || !index.bucket || typeof index.region !== "string" || !index.region ||
      typeof index.prefix !== "string" || !index.prefix || typeof index.keyId !== "string" || !index.keyId ||
      typeof index.slot !== "string" || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(index.slot) ||
      typeof index.sourceCommitKey !== "string" || !index.sourceCommitKey ||
      typeof index.sourceCommitVersionId !== "string" || !index.sourceCommitVersionId || index.sourceCommitVersionId === "null") return false;
  for (const [field, value] of Object.entries(expected)) if (index[field] !== value) return false;
  const expectedMac = createHmac("sha256", key).update(canonical(index)).digest();
  const actualMac = Buffer.from(index.hmacSha256, "hex");
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) return false;

  const identities = new Set();
  const files = new Map();
  for (const object of index.objects) {
    if (!object || typeof object !== "object" ||
        typeof object.objectKey !== "string" || !object.objectKey ||
        typeof object.objectVersion !== "string" || !object.objectVersion || object.objectVersion === "null" ||
        !/^[a-f0-9]{64}$/.test(object.checksum ?? "") || !Number.isSafeInteger(object.bytes) || object.bytes < 0 ||
        typeof object.mediaType !== "string" || !object.mediaType ||
        typeof object.file !== "string" || !/^objects\/\d+\.bin$/.test(object.file) ||
        !object.packageEntry || object.packageEntry.name !== object.file ||
        object.packageEntry.sha256 !== object.checksum || object.packageEntry.bytes !== object.bytes ||
        !/^[a-f0-9]{64}$/.test(object.packageEntry.storedSha256 ?? "") ||
        object.packageEntry.encryption?.algorithm !== "AES-256-GCM" ||
        typeof object.sourceKey !== "string" || !object.sourceKey ||
        typeof object.sourceVersionId !== "string" || !object.sourceVersionId || object.sourceVersionId === "null" ||
        !Number.isSafeInteger(object.storedBytes) || object.storedBytes < 0) return false;
    const identity = objectReuseIdentity(object);
    if (identities.has(identity)) return false;
    identities.add(identity);
    const priorIdentity = files.get(object.file);
    if (priorIdentity && priorIdentity !== identity) return false;
    files.set(object.file, identity);
  }
  return true;
}

export function indexReusableObjects(index) {
  const byIdentity = new Map();
  if (!index || !Array.isArray(index.objects)) return byIdentity;
  for (const object of index.objects) {
    const identity = objectReuseIdentity(object);
    const previous = byIdentity.get(identity);
    if (previous && (previous.file !== object.file ||
        JSON.stringify(previous.packageEntry) !== JSON.stringify(object.packageEntry))) {
      throw new Error("El índice reutiliza una identidad con referencias de paquete distintas");
    }
    byIdentity.set(identity, object);
  }
  return byIdentity;
}

export function findReusableObject(document, index) {
  const byIdentity = index instanceof Map ? index : indexReusableObjects(index);
  return byIdentity.get(objectReuseIdentity(document));
}

export async function planBackupDocumentObjects({ documents, reuseIndex, loadSourceObject, storeSourceObject }) {
  const files = new Map();
  const objects = [];
  let reusedDocuments = 0;
  let sourceObjectReads = 0;
  let nextFile = 0;
  const plannedIdentities = new Map();
  const reservedFiles = new Set();
  const reusableByIdentity = indexReusableObjects(reuseIndex);
  for (const object of reusableByIdentity.values()) {
    reservedFiles.add(object.file);
  }
  const priorReuseIdentities = new Set(reusableByIdentity.keys());
  for (const document of documents) {
    const identity = objectReuseIdentity(document);
    const reused = reusableByIdentity.get(identity);
    const planned = reused ?? plannedIdentities.get(identity);
    if (planned) {
      if (planned.packageEntry.sha256 !== document.checksum || planned.packageEntry.bytes !== document.bytes ||
          planned.packageEntry.name !== planned.file) throw new Error("El índice de reutilización no coincide con el objeto respaldado");
      const previous = files.get(planned.file);
      if (previous && JSON.stringify(previous) !== JSON.stringify(planned.packageEntry)) throw new Error("El índice reutiliza un nombre de archivo con contenido distinto");
      files.set(planned.file, planned.packageEntry);
      objects.push({ ...document, file: planned.file });
      if (reused || priorReuseIdentities.has(identity)) reusedDocuments++;
      continue;
    }

    let file;
    do { file = `objects/${nextFile++}.bin`; } while (reservedFiles.has(file) || files.has(file));
    const bytes = await loadSourceObject(document);
    sourceObjectReads++;
    const entry = await storeSourceObject(file, bytes);
    if (!entry || entry.name !== file || entry.sha256 !== document.checksum || entry.bytes !== document.bytes) {
      throw new Error("El objeto privado no coincide con la instantánea de base de datos");
    }
    files.set(file, entry);
    plannedIdentities.set(identity, { file, packageEntry: entry });
    objects.push({ ...document, file });
  }
  return { files: [...files.values()], objects, reusedDocuments, sourceObjectReads };
}
