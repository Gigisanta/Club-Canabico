import { createHash } from "node:crypto";
import type { AppSheetReviewTarget } from "../../shared/operations/appsheet-review.js";

export type AppSheetDatabaseTarget = AppSheetReviewTarget;

const TLS_PARAMETERS = new Set([
  "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "sslidentity", "sslaccept",
]);

const NON_ROUTING_PARAMETERS = new Set([
  "application_name", "connect_timeout", "connection_limit", "pool_timeout", "pgbouncer",
  "statement_cache_size", "socket_timeout", "keepalives", "keepalives_idle", "keepalives_interval",
  "keepalives_count", "tcp_user_timeout",
]);

/**
 * Return a non-secret fingerprint of the PostgreSQL database/schema destination.
 * Credentials and transport/pool settings are intentionally excluded. Unknown query
 * parameters fail closed so an alternate routing parameter cannot be silently ignored.
 */
export function appSheetDatabaseDestinationIdentity(
  target: AppSheetDatabaseTarget,
  databaseUrl: URL,
): string {
  if (target !== "isolated-test" && target !== "production") throw new Error("appsheet_database_target_invalid");
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:")
    throw new Error("appsheet_database_target_invalid");
  if (databaseUrl.hash) throw new Error("appsheet_database_target_ambiguous");

  const hostname = databaseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname.includes(",") || hostname.includes("%"))
    throw new Error("appsheet_database_target_ambiguous");
  const port = databaseUrl.port || "5432";

  let databaseName: string;
  try {
    const path = databaseUrl.pathname;
    if (!path.startsWith("/") || path.length <= 1 || path.slice(1).includes("/"))
      throw new Error("ambiguous_path");
    databaseName = decodeURIComponent(path.slice(1));
  } catch {
    throw new Error("appsheet_database_target_ambiguous");
  }
  if (!databaseName || databaseName.includes("/") || databaseName.includes("\0"))
    throw new Error("appsheet_database_target_ambiguous");

  const schemaValues = databaseUrl.searchParams.getAll("schema");
  if (schemaValues.length > 1) throw new Error("appsheet_database_target_ambiguous");
  const schema = schemaValues.length === 0 ? "public" : schemaValues[0]!;
  if (!schema || schema.includes("\0")) throw new Error("appsheet_database_target_ambiguous");

  for (const key of databaseUrl.searchParams.keys()) {
    if (key === "schema") continue;
    const normalizedKey = key.toLowerCase();
    if (TLS_PARAMETERS.has(normalizedKey) || NON_ROUTING_PARAMETERS.has(normalizedKey)) continue;
    // In particular, reject host/hostaddr/port/dbname/service/options overrides.
    throw new Error("appsheet_database_target_ambiguous");
  }

  const identityMaterial = JSON.stringify([
    "appsheet-db-v1", target, hostname, port, databaseName, schema,
  ]);
  return `appsheet-db-v1:${createHash("sha256").update(identityMaterial, "utf8").digest("hex")}`;
}
