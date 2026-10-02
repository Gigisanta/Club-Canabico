import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("startup on an occupied port disconnects the DB and exits with failure without announcing readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bombo-startup-"));
  const occupied = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    assert(address && typeof address !== "string");
    const trace = join(directory, "db-trace");
    const source = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const express = pathToFileURL(createRequire(import.meta.url).resolve("express")).href;
    await mkdir(join(directory, "node_modules", "dotenv"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "index.js"), compiled);
    const startup = await readFile(new URL("../server/startup.ts", import.meta.url), "utf8");
    await writeFile(join(directory, "startup.js"), ts.transpileModule(startup, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    await writeFile(join(directory, "app.js"), `import express from ${JSON.stringify(express)};\nexport const app = express();\n`);
    await writeFile(join(directory, "db.js"), `
      import { appendFile } from "node:fs/promises";
      import { setTimeout } from "node:timers/promises";
      export const db = {
        $connect: () => appendFile(process.env.STARTUP_TRACE, "connected\\n"),
        $disconnect: async () => {
          await setTimeout(25);
          await appendFile(process.env.STARTUP_TRACE, "disconnected\\n");
        },
      };
    `);
    // Prevent dotenv and the real app/DB imports from reading private environment or opening a DB.
    await writeFile(join(directory, "node_modules", "dotenv", "package.json"), JSON.stringify({
      type: "module", exports: { "./config": "./config.js" },
    }));
    await writeFile(join(directory, "node_modules", "dotenv", "config.js"), "export {};\n");
    const result = spawnSync(process.execPath, [join(directory, "index.js")], {
      cwd: directory,
      env: {
        NODE_ENV: "test", DEMO_MODE: "true", HOST: "127.0.0.1",
        PORT: String(address.port), STARTUP_TRACE: trace,
      },
      encoding: "utf8",
      timeout: 8_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EADDRINUSE/);
    assert.doesNotMatch(result.stdout, /API en http:/);
    assert.equal(await readFile(trace, "utf8"), "connected\ndisconnected\n");
  } finally {
    if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
