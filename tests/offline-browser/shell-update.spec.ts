import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const run = promisify(execFile);

// Real generated service worker + browser lifecycle. The tiny public shell is
// a transport fixture; it does not simulate Cache Storage or worker updates.
test("actualiza el shell instalado y conserva la última versión si el release es inconsistente", async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), "bombo-shell-update-"));
  let current = "";
  let staleManifest: Buffer | undefined;
  let unavailableHtml = false;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      const path = pathname === "/app/delivery" ? "index.html" : pathname.slice(1);
      if (!resolve(current, path).startsWith(`${resolve(current)}/`)) {
        response.writeHead(400).end(); return;
      }
      const body = pathname === "/app/delivery" && unavailableHtml
        ? Buffer.from("<html><body>Temporalmente no disponible</body></html>")
        : pathname === "/bombo-shell-assets.json" && staleManifest
          ? staleManifest : await readFile(join(current, path));
      const type = extname(path) === ".js" ? "text/javascript" : extname(path) === ".html" ? "text/html" : "application/json";
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const versions: string[] = [];
    for (let version = 1; version <= 4; version++) {
      const directory = join(root, `release-${version}`);
      const dist = join(directory, "dist");
      await mkdir(join(directory, "scripts"), { recursive: true });
      await mkdir(join(dist, ".vite"), { recursive: true });
      await mkdir(join(dist, "assets"), { recursive: true });
      await cp(new URL("../../scripts/pwa-shell.mjs", import.meta.url), join(directory, "scripts/pwa-shell.mjs"));
      await cp(new URL("../../public/bombo-sw.js", import.meta.url), join(dist, "bombo-sw.js"));
      const asset = `assets/shell-${version}.js`;
      await writeFile(join(dist, asset), `window.shellRelease = ${version};`);
      await writeFile(join(dist, "index.html"), `<html><body><script src="/${asset}"></script></body></html>`);
      await writeFile(join(dist, ".vite/manifest.json"), JSON.stringify({ "index.html": { file: asset }, "src/DeliveryEntry.tsx": { file: asset } }));
      await writeFile(join(dist, "manifest.webmanifest"), JSON.stringify({ name: "Public shell fixture" }));
      await mkdir(join(dist, "brand"));
      await writeFile(join(dist, "brand/bombo-symbol.png"), new Uint8Array());
      await run(process.execPath, [join(directory, "scripts/pwa-shell.mjs")]);
      versions.push(dist);
    }
    current = versions[0];
    await page.goto(`${origin}/app/delivery`);
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("bombo-delivery-offline-v1", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("records", { keyPath: "id" });
          const queue = db.createObjectStore("outbox", { keyPath: "requestId" });
          queue.createIndex("byProfile", "profileId", { unique: false });
          queue.createIndex("byProfileSequence", ["profileId", "sequence"], { unique: false });
          const documents = db.createObjectStore("documents", { keyPath: "id" });
          documents.createIndex("byProfile", "profileId", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = database.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put({ requestId: "pending-offline-event", profileId: "driver:device", status: "pending" });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/bombo-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith("bombo-delivery-shell-")))).toHaveLength(1);
    const original = await page.evaluate(async () => (await caches.keys()).find(name => name.startsWith("bombo-delivery-shell-"))!);
    current = versions[1];
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting?.state ?? null), { timeout: 5000 }).toBe("installed");
    const updated = await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith("bombo-delivery-shell-")));
    expect(updated).toHaveLength(2);
    expect(updated).toContain(original);
    await context.setOffline(true);
    await page.reload();
    expect(await page.evaluate(() => (window as Window & { shellRelease: number }).shellRelease)).toBe(1);

    await context.setOffline(false);
    staleManifest = await readFile(join(versions[1], "bombo-shell-assets.json"));
    current = versions[2];
    const tryUpdate = () => page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const failed = new Promise<string>(resolve => registration.addEventListener("updatefound", () => {
        const worker = registration.installing!;
        worker.addEventListener("statechange", () => { if (worker.state === "redundant" || worker.state === "activated") resolve(worker.state); });
      }, { once: true }));
      await registration.update();
      return failed;
    });
    expect(await tryUpdate()).toBe("redundant");
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith("bombo-delivery-shell-")))).toEqual(updated);
    await context.setOffline(true);
    await page.reload();
    expect(await page.evaluate(() => (window as Window & { shellRelease: number }).shellRelease)).toBe(1);
    await context.setOffline(false);
    staleManifest = undefined;
    unavailableHtml = true;
    current = versions[3];
    expect(await tryUpdate()).toBe("redundant");
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith("bombo-delivery-shell-")))).toEqual(updated);
    await context.setOffline(true);
    await page.reload();
    expect(await page.evaluate(() => (window as Window & { shellRelease: number }).shellRelease)).toBe(1);
  } finally {
    await context.setOffline(false);
    await page.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
