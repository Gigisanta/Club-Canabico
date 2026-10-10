import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Synthetic pressure measurement. Creates and drops only its own schema on a loopback test database.
const target = new URL(process.env.TEST_DATABASE_URL ?? "");
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/bombo_ui_[a-z0-9_]+$/i.test(target.pathname))
  throw new Error("El benchmark requiere TEST_DATABASE_URL loopback con nombre bombo_ui_*.");
const schema = `bombo_bench_${randomUUID().replaceAll("-", "")}`;
target.searchParams.set("schema", schema); target.searchParams.set("connection_limit", "4");
process.env.DATABASE_URL = target.toString();
process.env.NODE_ENV = "test"; process.env.DEMO_MODE = "true";
process.env.JWT_SECRET = randomUUID() + randomUUID(); process.env.ALLOWED_ORIGIN = "http://benchmark.local";
const admin = new PrismaClient({ datasourceUrl: target.toString() });
let server: import("node:http").Server | undefined, runtime: PrismaClient | undefined;
const result = { environment: { runtime: process.version, databaseMajor: "", location: "loopback", sessions: 10, runtimePoolConnections: 4, synthetic: true, provesProduction: false }, population: { members: 2780, skus: 650, orders: 14600, lines: 29200, stockFacts: 27770, ledgerLegs: 36930, historicalRecords: 259450 }, measurements: [] as Array<{ name: string; samples: number; p95Ms: number; maxMs: number; maxBytes: number }>, maxObservedDatabaseConnections: 0, maxApplicationRssMiB: 0, thresholds: { warmReadP95Ms: 750, commandP95Ms: 1500 }, thresholdsMet: false };
async function migrate() {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes.toString(); });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`Migraciones rechazadas (${code}); ${output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted]").slice(-2000)}`)));
  });
}
try {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); await migrate();
  const { db } = await import("../server/db.js"); runtime = db;
  const [version] = await db.$queryRaw<Array<{ version: string }>>`SELECT current_setting('server_version') AS version`;
  result.environment.databaseMajor = version!.version;
  await db.user.create({ data: { id: "benchmark-owner", name: "Benchmark", email: "benchmark@local.test", role: "owner", password: await bcrypt.hash("Synthetic-benchmark-only-2026", 4) } });
  await db.operationMember.create({ data: { id: "benchmark-member", name: "Socio sintético", address: {}, preferences: {} } });
  await db.catalogSku.create({ data: { id: "benchmark-sku", code: "BENCH", name: "Producto sintético", variety: "Fixture", category: "Fixture", unit: "ud" } });
  await db.$executeRaw`INSERT INTO "OperationMember" (id,name,address,preferences) SELECT 'bench-member-'||n,'Socio sintético '||n,'{}','{}' FROM generate_series(1,2779) n`;
  await db.$executeRaw`INSERT INTO "CatalogSku" (id,code,name,variety,category,unit) SELECT 'bench-sku-'||n,'BENCH-'||n,'Producto sintético '||n,'Fixture','Fixture','ud' FROM generate_series(1,649) n`;
  await db.inventoryLot.create({data:{id:"bench-lot",skuId:"benchmark-sku",label:"Fixture",unit:"ud",unitCost:"1",costCurrency:"ARS",receivedAt:new Date()}});
  await db.stockBalance.create({data:{id:"bench-balance",lotId:"bench-lot",unit:"ud",locationId:"bench-location",custodianId:"benchmark-owner",quantity:"27770"}});
  await db.$executeRaw`INSERT INTO "StockFact" (id,"requestId","lotId",kind,quantity,unit,"toLocationId","toCustodianId","costMinor",currency,reason,"actorId","occurredAt") SELECT gen_random_uuid(),gen_random_uuid(),'bench-lot','receipt',1,'ud','bench-location','benchmark-owner',100,'ARS','Synthetic only','benchmark-owner',now() FROM generate_series(1,27770)`;
  await db.operationAccount.createMany({data:[{id:"bench-club",name:"Club sintético",currency:"ARS",kind:"cash",holder:"Fixture",purpose:"Fixture",verified:true,openingApprovedBy:"synthetic-reviewer"},{id:"bench-bank",name:"Banco sintético",currency:"ARS",kind:"bank",holder:"Fixture",purpose:"Fixture",verified:true,openingApprovedBy:"synthetic-reviewer"}]});
  await db.$executeRaw`INSERT INTO "LedgerEvent" (id,"requestId",kind,"occurredAt","actorId","sourceObjectId",description,metadata) SELECT 'bench-event-'||n,gen_random_uuid(),'transfer',now(),'benchmark-owner','bench-club','Synthetic only','{}' FROM generate_series(1,18465) n`;
  await db.$executeRaw`INSERT INTO "LedgerLeg" (id,"eventId","accountId",currency,"amountMinor") SELECT 'bench-leg-'||n,'bench-event-'||((n+1)/2),CASE WHEN n%2=0 THEN 'bench-club' ELSE 'bench-bank' END,'ARS',CASE WHEN n%2=0 THEN 100 ELSE -100 END FROM generate_series(1,36930) n`;
  await db.$executeRaw`INSERT INTO "OperationOrder" (id,"memberId",channel,currency,"commercialState",quote,"subtotalMinor","totalMinor",address,"createdBy","confirmedAt")
    SELECT 'bench-order-'||n, 'benchmark-member', 'local', 'ARS', 'confirmed', '{}', 20000, 20000, '{}', 'benchmark-owner', now() FROM generate_series(1,14600) n`;
  await db.$executeRaw`INSERT INTO "OperationOrderLine" (id,"orderId","skuId",unit,requested,"unitPrice","referenceMinor","revenueMinor")
    SELECT 'bench-line-'||n, 'bench-order-'||((n+1)/2), 'benchmark-sku', 'ud', 1, 100, 10000, 10000 FROM generate_series(1,29200) n`;
  await db.legacyImportSnapshot.create({ data: { id: "benchmark-history", sourceSystem: "benchmark", filename: "synthetic-only", fileHash: "a".repeat(64), importerVersion: "benchmark", status: "reviewed", createdBy: "synthetic-importer", reviewedBy: "synthetic-reviewer", controls: {}, coverage: [] } });
  await db.legacyHistoryPublication.create({ data: { sourceSystem: "benchmark", snapshotId: "benchmark-history", fileHash: "a".repeat(64), mappingId: "benchmark-mapping", fingerprint: "b".repeat(64), publishedBy: "benchmark-owner", evidence: { synthetic: true } } });
  await db.legacyIdentity.create({ data: { id: "benchmark-member-map", sourceSystem: "benchmark", sourceTable: "C_Cliente", sourceKey: "synthetic-member", destinationType: "member", destinationId: "benchmark-member", approvedBy: "synthetic-reviewer" } });
  await db.$executeRaw`INSERT INTO "LegacySourceRecord" (id,"snapshotId","sourceTable","sourceKey","sourceRow","fileHash","contentHash","importerVersion",original,normalized,treatment)
    SELECT 'bench-history-'||n,'benchmark-history',CASE WHEN n<=14600 THEN 'C_Facturacion' ELSE 'SyntheticArchive' END,'synthetic-'||n,n,repeat('a',64),repeat('c',64),'benchmark','{"columns":[]}',
      '{"columns":[{"header":"Cliente","value":"synthetic-member"}]}','fact_candidate' FROM generate_series(1,259450) n`;
  await db.$executeRaw`INSERT INTO "LegacyHistoricalFact" (id,"snapshotId","sourceRecordId","sourceTable","sourceKey","sourceRow","sourceHash","mappingId",kind,"occurredOn","dateState",currency,"currencyState","unitState","amountMinor","amountState","quantityState",attributes,"createdBy")
    SELECT 'bench-fact-'||n,'benchmark-history','bench-history-'||n,CASE WHEN n<=14600 THEN 'C_Facturacion' ELSE 'SyntheticArchive' END,'synthetic-'||n,n,repeat('c',64),'benchmark-mapping',CASE WHEN n<=14600 THEN 'invoice' ELSE 'archive' END,
      '2026-01-01','known','ARS','known','not-applicable',20000,'known','not-applicable','{"fields":{"amountField":"Total_Facturado"}}','synthetic-reviewer' FROM generate_series(1,259450) n`;
  await db.$executeRawUnsafe(`ANALYZE "${schema}"."LegacyHistoricalFact"`); await db.$executeRawUnsafe(`ANALYZE "${schema}"."LegacySourceRecord"`); await db.$executeRawUnsafe(`ANALYZE "${schema}"."OperationOrder"`);
  const { app } = await import("../server/app.js"); server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const sessions: string[] = [];
  for (let index = 0; index < 10; index++) {
    const response = await fetch(base + "/auth/login", { method: "POST", headers: { Origin: "http://benchmark.local", "Content-Type": "application/json" }, body: JSON.stringify({ email: "benchmark@local.test", password: "Synthetic-benchmark-only-2026" }) });
    if (!response.ok) throw new Error(`Sesión ${index}: ${response.status}`); sessions.push(response.headers.get("set-cookie")!.split(";")[0]!);
  }
  async function measure(name: string, path: string, command = false) {
    const samples: Array<{ ms: number; bytes: number }> = [];
    for (let round = 0; round < 6; round++) {
      const times = await Promise.all(sessions.map(async cookie => {
        const start = performance.now();
        const body = command ? { schemaVersion: 1, requestId: randomUUID(), targetId: randomUUID(), expectedVersion: 0, occurredAt: new Date().toISOString(), command: "OrderCreated", data: { memberId: "benchmark-member", channel: "local", currency: "ARS" } } : undefined;
        const response = await fetch(base + path, { method: command ? "POST" : "GET", headers: { Cookie: cookie, Origin: "http://benchmark.local", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const bytes = (await response.arrayBuffer()).byteLength;
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        return { ms: performance.now() - start, bytes };
      }));
      if (round) samples.push(...times);
      const [connections] = await admin.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name NOT LIKE 'pg_%'`;
      result.maxObservedDatabaseConnections = Math.max(result.maxObservedDatabaseConnections, Number(connections!.n));
      result.maxApplicationRssMiB = Math.max(result.maxApplicationRssMiB, Math.round(process.memoryUsage().rss / 1048576));
    }
    const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
    result.measurements.push({ name, samples: sorted.length, p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]!), maxMs: Math.round(sorted.at(-1)!), maxBytes: Math.max(...samples.map(sample => sample.bytes)) });
  }
  await measure("members", "/operations/members?limit=50");
  await measure("member-history", "/operations/members/benchmark-member/history?limit=50");
  await measure("orders", "/operations/orders?limit=50");
  await measure("catalog", "/operations/catalog?limit=50");
  await measure("accounts", "/operations/accounts");
  await measure("order-draft-command", "/operations/commands", true);
  result.thresholdsMet = result.measurements.every(measurement => measurement.p95Ms <= (measurement.name.endsWith("command") ? result.thresholds.commandP95Ms : result.thresholds.warmReadP95Ms));
  console.log(JSON.stringify(result, null, 2)); if (!result.thresholdsMet) process.exitCode = 2;
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (runtime) await runtime.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect();
}
