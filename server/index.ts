import "dotenv/config";
import { app } from "./app.js";
import { db } from "./db.js";
await db.$connect();
if (process.env.DEMO_MODE !== "true" && /demo/i.test(new URL(process.env.DATABASE_URL || "").pathname))
  throw new Error("La conexión apunta a una base llamada demo. Usá una base real separada.");
if (process.env.DEMO_MODE !== "true" && await db.user.count({ where: { email: { endsWith: "@demo.bombo.local" } } }))
  throw new Error("Base de demostración detectada. Configurá una base real separada antes de iniciar.");
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`Bombo cannabis club API en http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    }),
  );
