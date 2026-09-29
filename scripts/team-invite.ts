// Initial access can be prepared before an owner has activated their account.
// TEAM_ENV_FILE must point to the private environment of the real database.
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const envFile = process.env.TEAM_ENV_FILE;
if (!envFile) throw new Error("Definí TEAM_ENV_FILE con la ruta privada del entorno real.");
dotenv.config({ path: envFile, override: true, quiet: true });
if (process.env.DEMO_MODE !== "false") throw new Error("El alta inicial solo funciona con DEMO_MODE=false.");
const dbUrl = new URL(process.env.DATABASE_URL || "");
if (/demo/i.test(dbUrl.pathname)) throw new Error("La base de demostración no puede recibir accesos reales.");
const [memberId, rawEmail] = process.argv.slice(2);
const email = z.email().parse(rawEmail);
if (!memberId || !/^[a-z0-9_-]{1,100}$/.test(memberId)) throw new Error("Indicá el ID del acceso pendiente y su correo.");
const origin = process.env.APP_ORIGIN || "";
const appUrl = new URL(origin);
if (appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(appUrl.hostname)))
  throw new Error("APP_ORIGIN debe usar HTTPS, salvo en loopback local.");
const { prepareSeat } = await import("../server/team-access.js");
const { db } = await import("../server/db.js");
try {
  const { path, expiresAt } = await prepareSeat(memberId, email);
  const outputDir = resolve(".local", "invitaciones");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = resolve(outputDir, `${memberId}.txt`);
  await writeFile(outputPath, `${new URL(path, appUrl).toString()}\n`, { mode: 0o600 });
  console.log(`Acceso ${memberId} preparado hasta ${expiresAt.toISOString()}. Enlace privado: ${outputPath}`);
} finally {
  await db.$disconnect();
}
