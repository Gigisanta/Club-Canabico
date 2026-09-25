import "dotenv/config";
import { app } from "./app.js";
import { db } from "./db.js";
await db.$connect();
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
