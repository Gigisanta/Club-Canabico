import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function tally() {
  const digest = createHash("sha256"); let bytes = 0;
  const stream = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; digest.update(chunk); done(null, chunk); } });
  return { stream, result: () => ({ bytes, sha256: digest.digest("hex") }) };
}
/** Bounded-memory dump transport. Encryption metadata is authenticated by the package manifest. */
export async function storeDumpStream(source, destination, name, key) {
  const plain = tally(), stored = tally(), iv = key ? randomBytes(12) : null;
  const cipher = key ? createCipheriv("aes-256-gcm", key, iv) : null;
  cipher?.setAAD(Buffer.from(name));
  // Acquire ownership before installing cleanup. An existing file must survive EEXIST.
  const output = await open(destination, "wx", 0o600);
  try {
    await pipeline(createReadStream(source), plain.stream, ...(cipher ? [cipher] : []), stored.stream, output.createWriteStream());
    const content = plain.result(), ciphertext = stored.result();
    return { name, ...content, storedSha256: ciphertext.sha256, ...(cipher ? { encryption: { algorithm: "AES-256-GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") } } : {}) };
  } catch (error) { await rm(destination, { force: true }); throw error; }
  finally { await output.close(); }
}
/** Verify the whole stream, or restore it into an exclusive temporary file. Never buffers a dump. */
export async function verifyDumpStream(source, entry, key, destination) {
  const stored = tally(), plain = tally(); let decipher;
  if (entry.encryption) {
    if (!key || entry.encryption.algorithm !== "AES-256-GCM") throw new Error("El paquete requiere cifrado y clave válidos");
    const iv = Buffer.from(entry.encryption.iv, "base64"), tag = Buffer.from(entry.encryption.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Metadatos de cifrado inválidos");
    decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(Buffer.from(entry.name)); decipher.setAuthTag(tag);
  }
  const output = destination ? await open(destination, "wx", 0o600) : null;
  const sink = output ? output.createWriteStream() : new Writable({ write(_chunk, _encoding, done) { done(); } });
  try {
    await pipeline(createReadStream(source), stored.stream, ...(decipher ? [decipher] : []), plain.stream, sink);
    const ciphertext = stored.result(), content = plain.result();
    if (ciphertext.sha256 !== entry.storedSha256 || content.sha256 !== entry.sha256 || content.bytes !== entry.bytes) throw new Error("Integridad del dump inválida");
  } catch (error) { if (destination) await rm(destination, { force: true }); throw error; }
  finally { await output?.close(); }
}
