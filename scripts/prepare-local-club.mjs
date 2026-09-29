// Creates an isolated, empty local database for the real club. Never copies
// demo records or reuses the demo database. Run once from the repository root.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

const sourceFile = process.env.BOMBO_DEMO_ENV_FILE;
if (!sourceFile) throw new Error("Definí BOMBO_DEMO_ENV_FILE con la ruta del entorno local actual.");
const outputFile = resolve(".local", "real-club.env");
if (existsSync(outputFile)) throw new Error("Ya existe .local/real-club.env. No se modificó nada.");
const source = dotenv.parse(readFileSync(sourceFile));
if (source.DEMO_MODE !== "true") throw new Error("El origen debe ser una conexión local de demostración.");
const adminUrl = new URL(source.DATABASE_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) throw new Error("La base de origen debe estar en loopback.");
if (!/demo/i.test(adminUrl.pathname)) throw new Error("El origen no está identificado como base demo.");
const dbName = "bombo_real";
const roleName = "bombo_real";
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
try {
  const databases = await admin.$queryRawUnsafe('SELECT datname FROM pg_database WHERE datname = $1', dbName);
  const roles = await admin.$queryRawUnsafe('SELECT rolname FROM pg_roles WHERE rolname = $1', roleName);
  if (databases.length || roles.length) throw new Error("La base o el rol bombo_real ya existen. No se modificó nada.");
} finally { await admin.$disconnect(); }

const dbPassword = randomBytes(32).toString("base64url");
const psqlEnv = { ...process.env, PGPASSWORD: decodeURIComponent(adminUrl.password) };
const psqlArgs = ["-X", "-v", "ON_ERROR_STOP=1", "-h", adminUrl.hostname, "-p", adminUrl.port || "5432", "-U", decodeURIComponent(adminUrl.username), "-d", "postgres", "-q"];
function execute(sql) {
  const done = spawnSync("psql", psqlArgs, { input: sql, encoding: "utf8", env: psqlEnv });
  if (done.status !== 0) throw new Error(`PostgreSQL rechazó la preparación: ${done.stderr?.trim().slice(0, 300) || "error desconocido"}`);
}
execute(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${dbPassword}';\n`);
execute(`CREATE DATABASE "${dbName}" OWNER "${roleName}";\n`);
const appUrl = new URL(adminUrl);
appUrl.username = roleName;
appUrl.password = dbPassword;
appUrl.pathname = `/${dbName}`;
appUrl.searchParams.set("schema", "public");
const lines = [
  "NODE_ENV=production",
  "DEMO_MODE=false",
  "HOST=127.0.0.1",
  "PORT=3003",
  "PUBLIC_SITE_APPROVED=false",
  "PUBLIC_SITE_PREVIEW=false",
  "CLUB_OPERATIONS_APPROVED=false",
  "COOKIE_SECURE=false",
  "ALLOWED_ORIGIN=http://127.0.0.1:3003",
  "APP_ORIGIN=http://127.0.0.1:3003",
  `DATABASE_URL=${appUrl.toString()}`,
  `JWT_SECRET=${randomBytes(48).toString("hex")}`,
  `DATA_IMPORT_PII_SECRET=${randomBytes(48).toString("hex")}`,
];
mkdirSync(resolve(".local"), { recursive: true, mode: 0o700 });
writeFileSync(outputFile, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
console.log(`Base ${dbName} vacía y aislada; configuración privada en ${outputFile}.`);
