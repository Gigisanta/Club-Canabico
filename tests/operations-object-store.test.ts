import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("S3 private objects require enabled versioning and a concrete version", async () => {
  const requests: string[] = [];
  const putPreconditions: Array<string | undefined> = [];
  const putEncryption: Array<{ algorithm?: string; kmsKeyArn?: string }> = [];
  const body = Buffer.from("synthetic private object");
  let versioningStatus: string | undefined = "Suspended";
  let putVersion: string | undefined = "object-v1";
  let getVersion: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* consume the synthetic request body */ }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.searchParams.has("versioning")) {
        requests.push("GetBucketVersioning");
        const status = versioningStatus ? `<Status>${versioningStatus}</Status>` : "";
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${status}</VersioningConfiguration>`);
        return;
      }
      if (request.method === "PUT") {
        requests.push("PutObject");
        putPreconditions.push(request.headers["if-none-match"] as string | undefined);
        putEncryption.push({
          algorithm: request.headers["x-amz-server-side-encryption"] as string | undefined,
          kmsKeyArn: request.headers["x-amz-server-side-encryption-aws-kms-key-id"] as string | undefined,
        });
        response.writeHead(200, putVersion === undefined ? {} : { "x-amz-version-id": putVersion });
        response.end();
        return;
      }
      if (request.method === "GET") {
        requests.push("GetObject");
        response.writeHead(200, { "Content-Length": String(body.length), ...(getVersion === undefined ? {} : { "x-amz-version-id": getVersion }) });
        response.end(body);
        return;
      }
      response.writeHead(500);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const localRoot = await mkdtemp(join(tmpdir(), "bombo-object-store-test-"));

  process.env.NODE_ENV = "test";
  process.env.PRIVATE_OBJECT_ROOT = localRoot;
  process.env.PRIVATE_S3_BUCKET = "synthetic-private-bucket";
  process.env.PRIVATE_S3_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.PRIVATE_S3_PATH_STYLE = "true";
  process.env.PRIVATE_S3_REGION = "us-east-1";
  delete process.env.PRIVATE_S3_KMS_KEY_ARN;
  process.env.AWS_ACCESS_KEY_ID = "synthetic-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "synthetic-secret-key";
  process.env.AWS_EC2_METADATA_DISABLED = "true";

  try {
    const { putPrivateObject, getPrivateObject } = await import("../server/operations/object-store.js");
    const checksum = createHash("sha256").update(body).digest("hex");

    await assert.rejects(
      putPrivateObject("documents/disabled/item", body, "application/octet-stream"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSIONING_REQUIRED",
    );
    assert.deepEqual(requests, ["GetBucketVersioning"]);

    requests.length = 0;
    versioningStatus = undefined;
    await assert.rejects(
      putPrivateObject("documents/unconfigured/item", body, "application/octet-stream"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSIONING_REQUIRED",
    );
    assert.deepEqual(requests, ["GetBucketVersioning"]);

    requests.length = 0;
    versioningStatus = "Enabled";
    putVersion = undefined;
    await assert.rejects(
      putPrivateObject("documents/missing-version/item", body, "application/octet-stream"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSIONING_REQUIRED",
    );
    assert.deepEqual(requests, ["GetBucketVersioning", "PutObject"]);

    requests.length = 0;
    putVersion = "null";
    await assert.rejects(
      putPrivateObject("documents/null-version/item", body, "application/octet-stream"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSIONING_REQUIRED",
    );
    assert.deepEqual(requests, ["GetBucketVersioning", "PutObject"]);

    requests.length = 0;
    await assert.rejects(
      getPrivateObject("documents/null-version/item", "null", checksum),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSION",
    );
    assert.deepEqual(requests, []);

    requests.length = 0;
    putVersion = "object-v2";
    const stored = await putPrivateObject("documents/enabled/item", body, "application/octet-stream");
    assert.equal(stored.version, "object-v2");
    assert.deepEqual(requests, ["GetBucketVersioning", "PutObject"]);

    requests.length = 0;
    process.env.PRIVATE_OBJECT_IMMUTABLE_WRITES = "true";
    putVersion = "object-v3";
    const immutable = await putPrivateObject("documents/immutable/item", body, "application/octet-stream");
    assert.equal(immutable.version, "object-v3");
    assert.deepEqual(requests, ["GetBucketVersioning", "PutObject"]);
    assert.equal(putPreconditions.at(-1), "*");
    assert.equal(putEncryption.at(-1)?.algorithm, "AES256");

    requests.length = 0;
    const restoreKmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
    process.env.PRIVATE_S3_KMS_KEY_ARN = restoreKmsKeyArn;
    const restored = await putPrivateObject("documents/restored/item", body, "application/octet-stream");
    assert.equal(restored.version, "object-v3");
    assert.deepEqual(requests, ["GetBucketVersioning", "PutObject"]);
    assert.deepEqual(putEncryption.at(-1), { algorithm: "aws:kms", kmsKeyArn: restoreKmsKeyArn });

    requests.length = 0;
    assert.deepEqual(await getPrivateObject(stored.key, stored.version, stored.checksum), body);
    assert.deepEqual(requests, ["GetObject"]);

    requests.length = 0;
    getVersion = "null";
    await assert.rejects(
      getPrivateObject(stored.key, stored.version, stored.checksum),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OBJECT_VERSION",
    );
    assert.deepEqual(requests, ["GetObject"]);
  } finally {
    delete process.env.PRIVATE_S3_KMS_KEY_ARN;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(localRoot, { recursive: true, force: true });
  }
});
