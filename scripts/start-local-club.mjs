// Starts the compiled real-club app on loopback with its private environment.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

const envFile = resolve(".local", "real-club.env");
if (!existsSync(envFile)) throw new Error("Falta .local/real-club.env. Ejecutá club:prepare-local primero.");
if (!existsSync(resolve("dist-server", "server", "index.js")) || !existsSync(resolve("dist", "index.html")))
  throw new Error("Falta el build. Ejecutá npm run build primero.");
const env = dotenv.parse(readFileSync(envFile));
const dbUrl = new URL(env.DATABASE_URL || "");
const appUrl = new URL(env.APP_ORIGIN || "");
if (env.DEMO_MODE !== "false" || env.NODE_ENV !== "production" || /demo/i.test(dbUrl.pathname))
  throw new Error("El entorno local real debe usar NODE_ENV=production, DEMO_MODE=false y una base separada de la demo.");
if (!["127.0.0.1", "localhost", "::1"].includes(dbUrl.hostname) ||
    env.HOST !== "127.0.0.1" || appUrl.hostname !== "127.0.0.1" ||
    appUrl.port !== env.PORT || env.ALLOWED_ORIGIN !== appUrl.origin)
  throw new Error("El entorno local real debe permanecer en loopback con un origen y puerto coherentes.");
Object.assign(process.env, env);
await import("../dist-server/server/index.js");
