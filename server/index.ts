import "dotenv/config";
import { app } from "./app.js";
import { db } from "./db.js";
import { ensureServerReady } from "./startup.js";
await ensureServerReady();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host);
let stopOutbox:undefined|(()=>void);
server.once("listening",()=>{if(process.env.OPERATION_OUTBOX_WORKER!=="false")void import("./operations/outbox.js").then(m=>{stopOutbox=m.startOperationOutboxWorker();});});
server.once("listening", () =>
  console.log(`Bombo cannabis club API en http://${host}:${port}`),
);
server.once("error", (error) => {
  console.error("No se pudo iniciar Bombo cannabis club API:", error);
  void db.$disconnect().finally(() => process.exit(1));
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    {stopOutbox?.();server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    });},
  );
