import { businessDate, defaults } from "../shared/domain.js";

const baseline = process.env.BENCH_BASELINE_URL;
const optimized = process.env.BENCH_OPTIMIZED_URL;
if (!baseline || !optimized) throw new Error("Definí BENCH_BASELINE_URL y BENCH_OPTIMIZED_URL");

async function session(base: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: "bench@example.test", password: "bench-only-password" }) });
  if (!response.ok) throw new Error(`Login de benchmark: ${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function measure(base: string, cookie: string, paths: string[]) {
  const samples: { milliseconds: number; bytes: number }[] = [];
  for (let i = 0; i < 4; i++) {
    let bytes = 0;
    const start = performance.now();
    for (const path of paths) {
      const response = await fetch(`${base}/api${path}`, { headers: { cookie } });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      bytes += (await response.arrayBuffer()).byteLength;
    }
    if (i) samples.push({ milliseconds: performance.now() - start, bytes });
  }
  return { ms: Math.round(samples.map((s) => s.milliseconds).sort((a, b) => a - b)[1]),
    bytes: samples[0].bytes };
}
const oldCookie = await session(baseline);
const newCookie = await session(optimized);
const before = await measure(baseline, oldCookie, ["/state"]);
const month = businessDate(defaults).slice(0, 7);
const screens = {
  inicio: ["/views/dashboard", "/dashboard"],
  inventario: ["/views/inventory", "/list/products"],
  socios: ["/views/customers", "/list/customers"],
  ventas: ["/views/sales", "/list/sales"],
  gastos: [`/views/expenses?month=${month}`, `/list/expenses?month=${month}`],
  finanzas: ["/views/finance", "/list/cash-entries"],
  responsables: ["/views/responsibles"],
  reportes: ["/views/reports"],
  configuracion: ["/views/settings"],
};
process.stdout.write(`Base /api/state: ${before.ms} ms, ${before.bytes} bytes\n`);
for (const [name, paths] of Object.entries(screens)) {
  const result = await measure(optimized, newCookie, paths);
  process.stdout.write(`${name}: ${result.ms} ms, ${result.bytes} bytes (${((1 - result.bytes / before.bytes) * 100).toFixed(2)}% menos datos)\n`);
}
