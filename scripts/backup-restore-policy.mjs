const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const restoreCatalogCountQuery = `SELECT (
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
  (SELECT count(*) FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema', 'public')) +
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
)::int AS count`;

export async function restoreCatalogObjectCount(database) {
  const [row] = await database.$queryRawUnsafe(restoreCatalogCountQuery);
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("No se pudo comprobar el catálogo del destino de restauración");
  return count;
}

export async function requireEmptyRestoreDatabase(database) {
  if (await restoreCatalogObjectCount(database) !== 0) throw new Error("El destino contiene objetos; no se reemplazará");
}

function parsedDatabaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname.slice(1)) throw new Error();
    return { url, database: decodeURIComponent(url.pathname.slice(1)) };
  } catch {
    throw new Error("RESTORE_DATABASE_URL debe ser una URL PostgreSQL válida");
  }
}

export function authorizeRestoreDestination(rawUrl, env = process.env) {
  const { url, database } = parsedDatabaseUrl(rawUrl);
  if (LOOPBACK_HOSTS.has(url.hostname) && /^bombo_(?:restore|test|ui_)[a-z0-9_-]*$/i.test(database)) {
    return { kind: "loopback-rehearsal", host: url.hostname, database };
  }

  if (url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Los destinos remotos requieren sslmode=verify-full");
  }
  const host = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  const target = `${host}/${database}`;
  const allowlist = safeRestoreAllowlist(env.RESTORE_DATABASE_ALLOWLIST ?? "");
  if (!allowlist.length || !allowlist.includes(target)) {
    throw new Error("El destino remoto no coincide con RESTORE_DATABASE_ALLOWLIST exacta");
  }
  return { kind: "allowlisted-remote", host, database };
}

export function safeRestoreAllowlist(raw = "") {
  const values = raw.split(",").map(value => value.trim().replace(/^([^/]+)/, host => host.toLowerCase())).filter(Boolean);
  if (values.some(value => /[*?\s]/.test(value) || !/^[a-z0-9.-]+(?::\d+)?\/[a-zA-Z0-9_-]+$/i.test(value))) {
    throw new Error("RESTORE_DATABASE_ALLOWLIST sólo admite pares host[:puerto]/base exactos");
  }
  return values;
}

export function safeRestoreObjectBucketAllowlist(raw = "") {
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (values.some(value => !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..")) ||
      new Set(values).size !== values.length) {
    throw new Error("RESTORE_OBJECT_BUCKET_ALLOWLIST sólo admite nombres de bucket exactos");
  }
  return values;
}

export function authorizeRestoreObjectBucket(bucket, env = process.env) {
  const allowlist = safeRestoreObjectBucketAllowlist(env.RESTORE_OBJECT_BUCKET_ALLOWLIST ?? "");
  if (typeof bucket !== "string" || !allowlist.length || !allowlist.includes(bucket)) {
    throw new Error("RESTORE_OBJECT_BUCKET debe coincidir exactamente con RESTORE_OBJECT_BUCKET_ALLOWLIST");
  }
  return bucket;
}

export function safeRestoreObjectKmsKeyArn(raw, region) {
  const match = typeof raw === "string" && /^arn:[a-z0-9-]+:kms:([a-z0-9-]+):\d{12}:key\/[a-f0-9-]+$/i.exec(raw);
  if (!match || typeof region !== "string" || match[1] !== region) {
    throw new Error("RESTORE_OBJECT_KMS_KEY_ARN debe ser un ARN de clave KMS en RESTORE_OBJECT_REGION");
  }
  return raw;
}
