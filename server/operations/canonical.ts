import { createHash } from "node:crypto";
import type { CommandEnvelope } from "../../shared/operations/contracts.js";
import { canonicalJson } from "../../shared/operations/exact.js";

/** Only call after validating and normalizing the complete external command. */
export function canonicalCommandBody(command: CommandEnvelope): string {
  return canonicalJson(command);
}

export function canonicalCommandBodyHash(command: CommandEnvelope): string {
  return createHash("sha256").update(canonicalCommandBody(command), "utf8").digest("hex");
}
