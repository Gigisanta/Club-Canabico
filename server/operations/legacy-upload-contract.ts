import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/operations/exact.js";
export const LEGACY_CHUNK_RECORDS = 500;
export const LEGACY_CHUNK_BYTES = 512 * 1024;
export const LEGACY_UPLOAD_BYTES = 128 * 1024 * 1024;
export function legacyPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export interface LegacyChunkManifest { index: number; contentHash: string; recordCount: number }
export interface LegacyUploadManifest { chunks: LegacyChunkManifest[]; recordsByTable: Record<string, number> }
