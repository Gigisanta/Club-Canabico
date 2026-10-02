import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planBackupDocumentObjects } from "../scripts/backup-object-reuse.mjs";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function reusable(document: { objectKey: string; objectVersion: string; checksum: string; bytes: number; mediaType: string }, file: string) {
  return {
    ...document,
    file,
    packageEntry: {
      name: file,
      bytes: document.bytes,
      sha256: document.checksum,
      storedSha256: sha256(`ciphertext:${file}`),
      encryption: { algorithm: "AES-256-GCM", iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" },
    },
    sourceKey: `bombo/frequent/objects/key/2026-10-01/${file}.bin`,
    sourceVersionId: `s3-${file}`,
    storedBytes: document.bytes + 28,
  };
}

test("backup object planning reserves later reused paths and skips source reads for unchanged identities", async () => {
  const unchangedA = { objectKey: "docs/a", objectVersion: "version-a", checksum: sha256("a"), bytes: 1, mediaType: "text/plain" };
  const unchangedB = { objectKey: "docs/b", objectVersion: "version-b", checksum: sha256("bb"), bytes: 2, mediaType: "text/plain" };
  const newABytes = Buffer.from("new-a");
  const newBBytes = Buffer.from("new-bb");
  const newA = { objectKey: "docs/new-a", objectVersion: "version-new-a", checksum: sha256(newABytes), bytes: newABytes.length, mediaType: "text/plain" };
  const newB = { objectKey: "docs/new-b", objectVersion: "version-new-b", checksum: sha256(newBBytes), bytes: newBBytes.length, mediaType: "text/plain" };
  const source = new Map([[newA.objectKey, newABytes], [newB.objectKey, newBBytes]]);
  const sourceReads: string[] = [];
  const result = await planBackupDocumentObjects({
    documents: [newA, unchangedA, newB, unchangedB],
    reuseIndex: { objects: [reusable(unchangedA, "objects/0.bin"), reusable(unchangedB, "objects/2.bin")] },
    loadSourceObject: async document => {
      sourceReads.push(document.objectKey);
      return source.get(document.objectKey)!;
    },
    storeSourceObject: async (name, bytes) => ({
      name,
      bytes: bytes.length,
      sha256: sha256(bytes),
      storedSha256: sha256(`stored:${name}`),
      encryption: { algorithm: "AES-256-GCM", iv: "BBBBBBBBBBBBBBBB", tag: "BBBBBBBBBBBBBBBBBBBBBB==" },
    }),
  });

  assert.deepEqual(sourceReads, [newA.objectKey, newB.objectKey]);
  assert.equal(result.sourceObjectReads, 2);
  assert.equal(result.reusedDocuments, 2);
  assert.deepEqual(result.files.map(file => file.name), ["objects/1.bin", "objects/0.bin", "objects/3.bin", "objects/2.bin"]);
  assert.deepEqual(result.objects.map(object => object.file), ["objects/1.bin", "objects/0.bin", "objects/3.bin", "objects/2.bin"]);
});

test("a changed source version is fetched even when its object key and bytes still match", async () => {
  const oldDocument = { objectKey: "docs/a", objectVersion: "version-a", checksum: sha256("same"), bytes: 4, mediaType: "text/plain" };
  const changedDocument = { ...oldDocument, objectVersion: "version-b" };
  const sourceBytes = Buffer.from("same");
  const sourceReads: string[] = [];
  const result = await planBackupDocumentObjects({
    documents: [changedDocument],
    reuseIndex: { objects: [reusable(oldDocument, "objects/0.bin")] },
    loadSourceObject: async document => {
      sourceReads.push(document.objectVersion);
      return sourceBytes;
    },
    storeSourceObject: async (name, bytes) => ({
      name,
      bytes: bytes.length,
      sha256: sha256(bytes),
      storedSha256: sha256(`stored:${name}`),
      encryption: { algorithm: "AES-256-GCM", iv: "CCCCCCCCCCCCCCCC", tag: "CCCCCCCCCCCCCCCCCCCCCC==" },
    }),
  });
  assert.deepEqual(sourceReads, ["version-b"]);
  assert.equal(result.sourceObjectReads, 1);
  assert.equal(result.reusedDocuments, 0);
  assert.deepEqual(result.objects.map(object => object.objectVersion), ["version-b"]);
});
