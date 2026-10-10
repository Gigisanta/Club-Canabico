import { createHash } from "node:crypto";
import type { CommandEnvelope } from "../../shared/operations/contracts.js";
import { canonicalJson, canonicalJsonData } from "../../shared/operations/exact.js";

/** Only call after validating and normalizing the complete external command. */
export function canonicalCommandBody(command: CommandEnvelope): string {
  // These strict command schemas preserve raw source-form values, including
  // absent/null/blank totals. They do not represent evaluated monetary amounts.
  if (command.command === "SourcePreorderSaved" || command.command === "SourcePreorderUpdated")
    return canonicalJsonData(command);
  return canonicalJson(command);
}

export function canonicalCommandBodyHash(command: CommandEnvelope): string {
  return createHash("sha256").update(canonicalCommandBody(command), "utf8").digest("hex");
}
