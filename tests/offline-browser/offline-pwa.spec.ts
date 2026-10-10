import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { aadFor, decryptJson, unlockKeyring } from "../../src/offline/crypto";
import type { DeliveryAssignmentV1, EncryptedBackupPackageV1 } from "../../src/offline/contracts";

const DRIVER_ID = "00000000-0000-4000-8000-000000000011";
const DELIVERY_ID = "00000000-0000-4000-8000-000000000021";
const ORDER_ID = "00000000-0000-4000-8000-000000000031";
const LINE_ID = "00000000-0000-4000-8000-000000000041";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SyncEvent { requestId?: string; targetId?: string; command?: string; data?: Record<string, unknown> }
interface SyncRequest { leaseId?: string; deviceId?: string; events?: SyncEvent[] }
interface SyncReply { status: number; body: unknown }
interface BackupRequest { leaseId?: string; deviceId?: string; package?: { packageId?: string }; sha256?: string }
interface BackupReply { status: number; body: unknown }
interface OfflineDocumentFixture {
  id: string;
  name: string;
  url: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  version: string;
}

interface MockDeliveryApi {
  manifestDeviceIds: string[];
  manifestRequests: number;
  syncRequests: SyncRequest[];
  backupRequests: BackupRequest[];
  documentRequests: string[];
  setManifestExpiry(value: string): void;
  setManifestDocument(document: OfflineDocumentFixture, body: Buffer, responseType?: string): void;
  setManifestAssignment(assignment: DeliveryAssignmentV1): void;
}

function canonicalJsonForChecksumAssertion(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("El fixture de copia no es serializable como JSON.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForChecksumAssertion).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonForChecksumAssertion(record[key])}`,
  );
  return `{${entries.join(",")}}`;
}

async function mockPersistentStorage(target: Page | BrowserContext, persisted: boolean): Promise<void> {
  await target.addInitScript((isPersistent) => {
    const storage = navigator.storage ?? {};
    if (!navigator.storage) Object.defineProperty(navigator, "storage", { configurable: true, value: storage });
    Object.defineProperty(storage, "persist", { configurable: true, value: async () => isPersistent });
    Object.defineProperty(storage, "persisted", { configurable: true, value: async () => isPersistent });
  }, persisted);
}

async function installMockDeliveryApi(
  page: Page,
  userId: string,
  onSync?: (request: SyncRequest) => Promise<SyncReply> | SyncReply,
  onBackup?: (request: BackupRequest) => Promise<BackupReply> | BackupReply,
): Promise<MockDeliveryApi> {
  let manifestExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  let manifestAssignment: DeliveryAssignmentV1 = {
    id: DELIVERY_ID,
    orderId: ORDER_ID,
    version: 0,
    customerName: "Cliente de prueba",
    address: "Calle de prueba 123",
    window: "14:00–15:00",
    route: { date: "2026-10-05", stop: 3, eta: "14:30", etaIsEstimate: true },
    lines: [{ id: LINE_ID, name: "Producto de prueba", requested: "5", prepared: "5", delivered: "2", remaining: "3", quantity: "5", unit: "g" }],
    documents: [],
    totalMinor: "100",
    currency: "ARS",
  };
  const state: MockDeliveryApi = {
    manifestDeviceIds: [],
    manifestRequests: 0,
    syncRequests: [],
    backupRequests: [],
    documentRequests: [],
    setManifestExpiry(value) { manifestExpiresAt = value; },
    setManifestDocument(document, body, responseType = document.mimeType) {
      manifestDocument = document;
      manifestDocumentBody = body;
      manifestDocumentResponseType = responseType;
    },
    setManifestAssignment(assignment) { manifestAssignment = assignment; },
  };
  let manifestDocument: OfflineDocumentFixture | undefined;
  let manifestDocumentBody: Buffer | undefined;
  let manifestDocumentResponseType = "application/octet-stream";

  await page.context().route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === "/api/config") {
      await route.fulfill({ json: { demo: false } });
    } else if (requestUrl.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: userId, email: "driver@example.test", role: "staff" } } });
    } else if (requestUrl.pathname === "/api/operations/context") {
      await route.fulfill({ json: { profile: "driver", authority: { mode: "active" } } });
    } else if (requestUrl.pathname === "/api/delivery/devices/current") {
      await route.fulfill({ json: { deviceId: requestUrl.searchParams.get("deviceId") } });
    } else if (requestUrl.pathname === "/api/delivery/manifests/current") {
      const deviceId = requestUrl.searchParams.get("deviceId") ?? "";
      state.manifestRequests += 1;
      state.manifestDeviceIds.push(deviceId);
      await route.fulfill({ json: {
        version: 1,
        userId,
        deviceId,
        leaseId: `lease-${deviceId}`,
        authorizationEpoch: 1,
        expiresAt: manifestExpiresAt,
        storageCertification: { persistent: true, requested: true, storageCertifiedAt: new Date().toISOString() },
        assignments: [{ ...manifestAssignment, documents: manifestDocument ? [manifestDocument] : [] }],
      } });
    } else if (requestUrl.pathname.startsWith("/api/operations/documents/") && requestUrl.pathname.endsWith("/content")) {
      const segments = requestUrl.pathname.split("/");
      const documentId = decodeURIComponent(segments[4] ?? "");
      state.documentRequests.push(documentId);
      if (!manifestDocument || !manifestDocumentBody || documentId !== manifestDocument.id) {
        await route.fulfill({ status: 404, json: { error: "Documento de fixture no disponible." } });
      } else {
        await route.fulfill({
          status: 200,
          headers: { "content-type": manifestDocumentResponseType, "content-length": String(manifestDocumentBody.byteLength) },
          body: manifestDocumentBody,
        });
      }
    } else if (requestUrl.pathname === "/api/delivery/sync") {
      const request = JSON.parse(route.request().postData() ?? "{}") as SyncRequest;
      state.syncRequests.push(request);
      const reply = await onSync?.(request) ?? { status: 503, body: { error: "Falla transitoria del fixture." } };
      await route.fulfill({ status: reply.status, json: reply.body });
    } else if (requestUrl.pathname === "/api/delivery/backups" && route.request().method() === "POST") {
      const request = JSON.parse(route.request().postData() ?? "{}") as BackupRequest;
      state.backupRequests.push(request);
      const reply = await onBackup?.(request) ?? {
        status: 200,
        body: {
          backupId: `00000000-0000-4000-8000-${String(state.backupRequests.length).padStart(12, "0")}`,
          sha256: request.sha256,
          durable: true,
        },
      };
      await route.fulfill({ status: reply.status, json: reply.body });
    } else {
      await route.fulfill({ status: 404, json: { error: "No definido en este fixture" } });
    }
  });

  return state;
}

async function prepareDevice(page: Page, passphrase: string): Promise<void> {
  await page.goto("/app/delivery");
  await page.getByRole("heading", { name: "Prepará tu turno" }).waitFor();
  await page.getByRole("button", { name: "Obtener turno en línea" }).click();
  await page.getByLabel("Frase de acceso").fill(passphrase);
  await page.getByRole("button", { name: "Preparar dispositivo" }).click();
  await expect(page.getByText("Dispositivo listo.", { exact: false })).toBeVisible();
  await expect(page.getByText("Cliente de prueba")).toBeVisible();
}

async function recordOneDelivery(page: Page, evidence: string): Promise<void> {
  await page.getByText("Registrar entrega", { exact: true }).click();
  await page.getByLabel("Cantidad entregada").fill("1");
  await page.getByLabel("Constancia / observación").fill(evidence);
  await page.getByRole("button", { name: "Guardar entrega" }).click();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();
}

async function readQueueEntryStates(page: Page): Promise<Array<{ requestId: string; status: string; attempted: boolean; dependsOn: string | null; sequence: number }>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("bombo-delivery-offline-v1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const rows = await new Promise<Array<{ requestId: string; status: string; attempted: boolean; dependsOn: string | null; sequence: number }>>((resolve, reject) => {
      const transaction = database.transaction("outbox", "readonly");
      const request = transaction.objectStore("outbox").getAll();
      request.onsuccess = () => {
        resolve((request.result as Array<{ requestId: string; status: string; attempted: boolean; dependsOn: string | null; sequence: number }>)
          .map(({ requestId, status, attempted, dependsOn, sequence }) => ({ requestId, status, attempted, dependsOn, sequence }))
          .sort((left, right) => left.sequence - right.sequence));
      };
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return rows;
  });
}

async function readQueueEntryState(page: Page, requestId: string): Promise<{ requestId: string; status: string; attempted: boolean } | undefined> {
  const rows = await readQueueEntryStates(page);
  const row = rows.find((entry) => entry.requestId === requestId);
  return row && { requestId: row.requestId, status: row.status, attempted: row.attempted };
}

async function readEncryptedQueueRows(page: Page): Promise<Array<{ requestId: string; algorithm: string; iv: string; ciphertext: string }>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("bombo-delivery-offline-v1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const rows = await new Promise<Array<{ requestId: string; encrypted: { algorithm: string; iv: string; ciphertext: string } }>>((resolve, reject) => {
      const transaction = database.transaction("outbox", "readonly");
      const request = transaction.objectStore("outbox").getAll();
      request.onsuccess = () => resolve(request.result as Array<{ requestId: string; encrypted: { algorithm: string; iv: string; ciphertext: string } }>);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return rows.map(({ requestId, encrypted }) => ({ requestId, ...encrypted }));
  });
}

async function readStoredDocumentMetadata(page: Page): Promise<Array<{ id: string; sha256?: string; version?: string; mimeType: string; byteLength: number }>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bombo-delivery-offline-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("documents", "readonly");
    const rows = await new Promise<Array<{ id: string; sha256?: string; version?: string; mimeType: string; byteLength: number }>>((resolve, reject) => {
      const request = transaction.objectStore("documents").getAll();
      request.onsuccess = () => resolve(request.result as Array<{ id: string; sha256?: string; version?: string; mimeType: string; byteLength: number }>);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return rows;
  });
}

async function readBackupAcknowledgements(page: Page): Promise<Array<{ backupId: string; sha256: string; durable: boolean; packageId: string }>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bombo-delivery-offline-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("records", "readonly");
    const rows = await new Promise<Array<{ id: string; value: { backupId: string; sha256: string; durable: boolean; packageId: string } }>>((resolve, reject) => {
      const request = transaction.objectStore("records").getAll();
      request.onsuccess = () => resolve((request.result as Array<{ id: string; value: { backupId: string; sha256: string; durable: boolean; packageId: string } }>)
        .filter((row) => row.id.startsWith("backup-ack:")));
      request.onerror = () => reject(request.error);
    });
    database.close();
    return rows.map((row) => row.value);
  });
}

async function corruptStoredDocumentHash(page: Page, documentId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bombo-delivery-offline-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("documents", "readwrite");
    const store = transaction.objectStore("documents");
    const request = store.getAll();
    request.onsuccess = () => {
      const row = (request.result as Array<{ id: string; sha256?: string }>).find(item => item.id.endsWith(`:${id}`));
      if (!row) { transaction.abort(); return; }
      row.sha256 = "0".repeat(64);
      store.put(row);
    };
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo alterar el fixture local."));
    });
    database.close();
  }, documentId);
}

test("prepara el turno, conserva el shell y bloquea capturas al vencer el lease", async ({ page, context }) => {
  const api = await installMockDeliveryApi(page, "driver-1");
  await mockPersistentStorage(page, true);

  const serviceWorkerAssetResponses: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (!/^\/assets\/.*\.js$/i.test(path)) return;
    if (response.fromServiceWorker()) serviceWorkerAssetResponses.push(path);
  });

  await prepareDevice(page, "clave local de prueba muy segura");
  await expect(page.getByText("Remanente según manifiesto: 3 g", { exact: true })).toBeVisible();
  await expect(page.getByText("Pedido: 5 g · Preparado: 5 g · Entregado: 2 g", { exact: true })).toBeVisible();
  await expect(page.getByText("Ruta · 05/10/2026", { exact: true })).toBeVisible();
  await expect(page.getByText("Parada 3", { exact: true })).toBeVisible();
  await expect(page.getByText("ETA estimada · 14:30", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^(?:remanente|eta|ruta|parada)\b/i)).toHaveCount(0);

  api.setManifestAssignment({
    id: DELIVERY_ID,
    orderId: ORDER_ID,
    version: 0,
    customerName: "Cliente de prueba",
    address: "Calle de prueba 123",
    window: "14:00–15:00",
    lines: [{ id: LINE_ID, name: "Producto de prueba", requested: "5", prepared: "5", delivered: "2", quantity: "5", unit: "g" }],
    documents: [],
    totalMinor: "100",
    currency: "ARS",
  });
  await page.getByRole("button", { name: "Actualizar turno" }).click();
  await expect(page.getByText("Remanente no informado en este manifiesto", { exact: true })).toBeVisible();
  await expect(page.getByText("Pedido: 5 g · Preparado: 5 g · Entregado: 2 g", { exact: true })).toBeVisible();
  await expect(page.getByText("Ruta · 05/10/2026", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Parada 3", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ETA estimada · 14:30", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/^(?:remanente|eta|ruta|parada)\b/i)).toHaveCount(0);

  await recordOneDelivery(page, "Captura local de prueba");
  await expect(page.getByText("El remanente corresponde al último manifiesto", { exact: false })).toBeVisible();

  api.setManifestExpiry(new Date(Date.now() - 60_000).toISOString());
  await page.getByRole("button", { name: "Actualizar turno" }).click();
  const quantity = page.getByLabel("Cantidad entregada");
  await page.getByLabel("Constancia / observación").fill("Intento con lease vencido");
  await page.getByRole("button", { name: "Guardar entrega" }).click();
  await expect(page.getByRole("alert")).toContainText("venció");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();

  api.setManifestExpiry(new Date(Date.now() + 60 * 60_000).toISOString());
  await page.getByRole("button", { name: "Actualizar turno" }).click();

  const cacheAudit = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith("bombo-delivery-shell-"));
    if (names.length !== 1) throw new Error("El shell debe conservar una sola versión activa");
    const cache = await caches.open(names[0]);
    const response = await cache.match("/bombo-shell-assets.json");
    if (!response) throw new Error("Built shell asset manifest was not cached");
    const manifest = await response.json() as { version: number; assets: string[] };
    const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const sizes = await Promise.all(manifest.assets.map(async (asset) => {
      const stored = await cache.match(asset, { ignoreVary: true });
      return stored ? (await stored.arrayBuffer()).byteLength : 0;
    }));
    return {
      version: manifest.version,
      assets: manifest.assets,
      missingAssets: manifest.assets.filter((asset) => !paths.includes(asset)),
      cachedPaths: paths,
      assetBytes: sizes.reduce((total, size) => total + size, 0),
    };
  });
  expect(cacheAudit.version).toBe(1);
  expect(cacheAudit.assets.some((asset) => /DeliveryEntry.*\.js$/i.test(asset))).toBe(true);
  expect(cacheAudit.missingAssets).toEqual([]);
  // Guard the installed courier shell budget, including its actual dependencies.
  expect(cacheAudit.assetBytes).toBeLessThan(1024 * 1024);
  expect(cacheAudit.cachedPaths).toContain("/app/delivery");
  expect(cacheAudit.cachedPaths.some((path) => /^\/api(?:\/|$)|\/(?:documents?|content)(?:\/|$)/i.test(path))).toBe(false);

  await context.unroute("**/api/**");
  await page.addInitScript(() => {
    // Simulate a browser with no persistence-status API after restart.
    Object.defineProperty(navigator.storage, "persisted", { configurable: true, value: undefined });
  });
  await context.setOffline(true);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller?.scriptURL.endsWith("/bombo-sw.js")));
  await page.goto("/app/delivery");
  await expect(page.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  await page.getByLabel("Frase de acceso").fill("clave local de prueba muy segura");
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();
  await expect(page.getByText("Entrega registrada", { exact: true })).toBeVisible();

  await page.getByText("Registrar entrega", { exact: true }).click();
  await quantity.fill("1");
  await page.getByLabel("Constancia / observación").fill("Segundo intento sin autorización vigente");
  await page.getByRole("button", { name: "Guardar entrega" }).click();
  await expect(page.getByRole("alert")).toContainText("almacenamiento persistente");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();
  await expect.poll(() => serviceWorkerAssetResponses.length).toBeGreaterThan(0);
});

test("conserva Mercado Pago cifrado al bloquear y recargar, y sincroniza el medio sin convertirlo en tarjeta", async ({ page, context }) => {
  const passphrase = "frase local segura para Mercado Pago";
  const captureApi = await installMockDeliveryApi(page, "driver-mercado-pago");
  await mockPersistentStorage(page, true);
  await prepareDevice(page, passphrase);
  await context.setOffline(true);

  await page.getByText("Informar un cobro", { exact: true }).click();
  await page.getByLabel("Medio").selectOption("mercado_pago");
  await page.getByLabel("Importe").fill("1250,75");
  await page.getByLabel("Comprobante / constancia").fill("Comprobante Mercado Pago de fixture");
  await page.getByRole("button", { name: "Informar cobro" }).click();

  await expect(page.getByText("1 eventos en cola")).toBeVisible();
  await expect(page.getByText("Cobro informado", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Cobro declarado" })).toContainText("pendiente de revisión");
  expect(captureApi.syncRequests).toHaveLength(0);

  const beforeReload = await readEncryptedQueueRows(page);
  expect(beforeReload).toHaveLength(1);
  expect(beforeReload[0]?.algorithm).toBe("AES-256-GCM");
  expect(beforeReload[0]?.ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
  expect(JSON.stringify(beforeReload[0])).not.toContain("mercado_pago");
  expect(JSON.stringify(beforeReload[0])).not.toContain("Comprobante Mercado Pago de fixture");

  await page.getByRole("button", { name: "Bloquear" }).click();
  await expect(page.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  await page.getByLabel("Frase de acceso").fill(passphrase);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();
  await expect(page.getByText("Cobro informado", { exact: true })).toBeVisible();

  await context.unroute("**/api/**");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller?.scriptURL.endsWith("/bombo-sw.js")));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  await page.getByLabel("Frase de acceso").fill(passphrase);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.getByText("1 eventos en cola")).toBeVisible();
  await expect(page.getByText("Cobro informado", { exact: true })).toBeVisible();
  const afterReload = await readEncryptedQueueRows(page);
  expect(afterReload).toEqual(beforeReload);

  const syncApi = await installMockDeliveryApi(page, "driver-mercado-pago", (request) => ({
    status: 200,
    body: { results: (request.events ?? []).map((event) => ({
      requestId: event.requestId,
      targetId: event.targetId,
      version: 1,
      result: {},
      replay: false,
      status: "accepted",
    })) },
  }));
  await context.setOffline(false);
  await expect.poll(() => syncApi.syncRequests.length).toBe(1);
  await expect(page.getByText("Sincronizado: 1")).toBeVisible();

  const sent = syncApi.syncRequests[0]?.events;
  expect(sent).toHaveLength(1);
  expect(sent?.[0]).toMatchObject({
    command: "CollectionReported",
    data: {
      orderId: ORDER_ID,
      deliveryId: DELIVERY_ID,
      method: "mercado_pago",
      currency: "ARS",
      amountMinor: "125075",
      evidence: { note: "Comprobante Mercado Pago de fixture" },
    },
  });
  expect(sent?.[0]?.data?.method).not.toBe("card");
  expect(await readQueueEntryState(page, sent![0]!.requestId!)).toMatchObject({ status: "accepted", attempted: true });
});

test("rechaza una captura cuando el navegador deniega persist()", async ({ page }) => {
  await mockPersistentStorage(page, false);
  await installMockDeliveryApi(page, "driver-denied");

  await page.goto("/app/delivery");
  await page.getByRole("heading", { name: "Prepará tu turno" }).waitFor();
  await page.getByRole("button", { name: "Obtener turno en línea" }).click();
  await page.getByLabel("Frase de acceso").fill("otra clave local de prueba segura");
  await page.getByRole("button", { name: "Preparar dispositivo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "no confirmó almacenamiento persistente" })).toContainText("no confirmó almacenamiento persistente");

  await page.getByText("Registrar entrega", { exact: true }).click();
  await page.getByLabel("Cantidad entregada").fill("1");
  await page.getByLabel("Constancia / observación").fill("Intento sin persistencia");
  await page.getByRole("button", { name: "Guardar entrega" }).click();
  await expect(page.getByRole("alert")).toContainText("Este navegador no confirmó almacenamiento persistente");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByText("0 eventos en cola")).toBeVisible();
});

test("exporta una copia íntegra y restaura el mismo UUID en otro dispositivo", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const passphrase = "frase de respaldo local de prueba";
  const sourceApi = await installMockDeliveryApi(page, DRIVER_ID);
  await mockPersistentStorage(page, true);
  await prepareDevice(page, passphrase);
  await recordOneDelivery(page, "Entrega pendiente para probar copia");

  await page.getByRole("button", { name: "Sincronizar ahora" }).click();
  await expect(page.getByRole("alert")).toContainText("503");
  await expect(page.getByRole("alert")).toBeFocused();
  const sourceRequestId = sourceApi.syncRequests[0]?.events?.[0]?.requestId;
  expect(sourceRequestId).toMatch(UUID_V4);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar copia cifrada" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Playwright no entregó el archivo exportado para verificarlo.");
  const backupPackage = JSON.parse(await readFile(downloadPath, "utf8")) as EncryptedBackupPackageV1;
  expect(backupPackage.schemaVersion).toBe(1);
  expect(backupPackage.packageId).toMatch(UUID_V4);
  expect(backupPackage.userId).toBe(DRIVER_ID);
  expect(backupPackage.sourceDeviceId).toMatch(UUID_V4);
  expect(backupPackage.sourceDeviceId).toBe(sourceApi.manifestDeviceIds[0]);

  const sha256 = createHash("sha256").update(canonicalJsonForChecksumAssertion(backupPackage)).digest("hex");
  await expect(page.getByRole("status").filter({ hasText: `SHA-256: ${sha256}` })).toContainText(`SHA-256: ${sha256}`);
  expect(download.suggestedFilename()).toBe(`bombo-turno-${sha256.slice(0, 12)}.json`);

  const alteredCiphertext = Buffer.from(backupPackage.queuePayload.ciphertext, "base64");
  expect(alteredCiphertext.byteLength).toBeGreaterThan(16);
  alteredCiphertext[0] = alteredCiphertext[0]! ^ 1;
  const tamperedPackage: EncryptedBackupPackageV1 = {
    ...backupPackage,
    queuePayload: { ...backupPackage.queuePayload, ciphertext: alteredCiphertext.toString("base64") },
  };

  const targetContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 412, height: 915 },
    serviceWorkers: "allow",
  });
  try {
    await mockPersistentStorage(targetContext, true);
    const targetPage = await targetContext.newPage();
    const targetApi = await installMockDeliveryApi(targetPage, DRIVER_ID);
    await prepareDevice(targetPage, passphrase);
    const targetDeviceId = targetApi.manifestDeviceIds[0];
    expect(targetDeviceId).toMatch(UUID_V4);
    expect(targetDeviceId).not.toBe(backupPackage.sourceDeviceId);

    const backupInput = targetPage.getByLabel("Restaurar copia");
    await targetPage.getByLabel("Frase de la copia").fill(passphrase);
    await expect(backupInput).toBeEnabled();
    await backupInput.setInputFiles({
      name: "copia-alterada.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(tamperedPackage)),
    });
    const restoreError = targetPage.getByRole("alert");
    await expect(restoreError).toContainText("verificación de integridad");
    await expect(restoreError).toBeFocused();
    await expect(targetPage.getByText("0 eventos en cola")).toBeVisible();
    await expect(backupInput).toBeEnabled();

    await backupInput.setInputFiles({
      name: download.suggestedFilename(),
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backupPackage)),
    });
    await expect(targetPage.getByRole("status").filter({ hasText: "Copia cifrada validada y restaurada" })).toContainText("Copia cifrada validada y restaurada");
    await expect(targetPage.getByText("1 eventos en cola")).toBeVisible();
    await expect(targetPage.getByText("Revisión requerida: 1")).toBeVisible();
    await expect.poll(() => readQueueEntryState(targetPage, sourceRequestId!)).toMatchObject({
      requestId: sourceRequestId,
      status: "quarantined",
    });
    await expect(targetPage.getByRole("button", { name: "Sincronizar ahora" })).toBeDisabled();
    expect(targetApi.syncRequests).toHaveLength(0);
    expect(sourceRequestId).toMatch(UUID_V4);
  } finally {
    await targetContext.close();
  }
});

test("al reconectar respalda la cola, sincroniza y confirma otro respaldo antes de cerrar el ciclo", async ({ page, context }) => {
  const api = await installMockDeliveryApi(page, "driver-reconnect", (request) => ({
    status: 200,
    body: { results: [{ requestId: request.events?.[0]?.requestId, targetId: DELIVERY_ID, version: 1, result: {}, replay: false, status: "accepted" }] },
  }));
  await mockPersistentStorage(page, true);
  await prepareDevice(page, "frase local segura para reconectar");

  await context.setOffline(true);
  await recordOneDelivery(page, "Evento que espera la conexión");
  expect(api.syncRequests).toHaveLength(0);

  const previousBackups = api.backupRequests.length;
  await context.setOffline(false);
  await expect.poll(() => api.syncRequests.length).toBe(1);
  await expect.poll(() => api.backupRequests.length).toBe(previousBackups + 2);
  expect(api.syncRequests[0]?.leaseId).toBe(`lease-${api.manifestDeviceIds[0]}`);
  expect(api.backupRequests.slice(previousBackups).map((backup) => backup.sha256)).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.stringMatching(/^[a-f0-9]{64}$/),
  ]);
  await expect(page.getByText("Sincronizado: 1")).toBeVisible();
});

test("el acuse durable de la copia al reconectar no pisa una captura concurrente", async ({ page, context }) => {
  const passphrase = "frase segura para acuse y captura";
  let releaseBackup!: () => void;
  let markBackupStarted!: () => void;
  const backupGate = new Promise<void>((resolve) => { releaseBackup = resolve; });
  const backupStarted = new Promise<void>((resolve) => { markBackupStarted = resolve; });
  let acceptedVersion = 0;
  const api = await installMockDeliveryApi(
    page,
    "driver-backup-ack-capture",
    (request) => ({
      status: 200,
      body: { results: (request.events ?? []).map((event) => ({
        requestId: event.requestId,
        targetId: event.targetId,
        version: ++acceptedVersion,
        result: {},
        replay: false,
        status: "accepted",
      })) },
    }),
    async (request) => {
      if (api.backupRequests.length === 1) {
        markBackupStarted();
        await backupGate;
      }
      return {
        status: 200,
        body: {
          backupId: `00000000-0000-4000-8000-${String(api.backupRequests.length).padStart(12, "0")}`,
          sha256: request.sha256,
          durable: true,
        },
      };
    },
  );
  await mockPersistentStorage(context, true);
  await prepareDevice(page, passphrase);
  await context.setOffline(true);
  await recordOneDelivery(page, "Captura anterior a la reconexión");
  const firstCapture = (await readQueueEntryStates(page))[0]!;

  try {
    await context.setOffline(false);
    await backupStarted;

    const secondPage = await context.newPage();
    await secondPage.goto("/app/delivery");
    await expect(secondPage.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
    await secondPage.getByLabel("Frase de acceso").fill(passphrase);
    await secondPage.getByRole("button", { name: "Desbloquear" }).click();
    await expect(secondPage.getByText("1 eventos en cola")).toBeVisible();
    await secondPage.getByText("Registrar entrega", { exact: true }).click();
    await secondPage.getByLabel("Cantidad entregada").fill("1");
    await secondPage.getByLabel("Constancia / observación").fill("Captura durante la carga de la copia");
    await secondPage.getByRole("button", { name: "Guardar entrega" }).click();
    await expect(secondPage.getByText("2 eventos en cola")).toBeVisible();
  } finally {
    releaseBackup();
  }

  await expect(page.getByRole("status").filter({ hasText: "Ciclo al reconectar completo" })).toContainText("Ciclo al reconectar completo");
  await expect.poll(() => api.syncRequests.length).toBeGreaterThan(0);
  await expect.poll(() => api.backupRequests.length).toBe(2);
  const captured = await readQueueEntryStates(page);
  expect(captured).toHaveLength(2);
  expect(captured.map((entry) => entry.requestId)).toContain(firstCapture.requestId);
  expect(captured.every((entry) => entry.status === "accepted")).toBe(true);
  const sentRequestIds = api.syncRequests.flatMap((request) => request.events?.map((event) => event.requestId) ?? []);
  expect(sentRequestIds).toContain(firstCapture.requestId);
  expect(sentRequestIds).toHaveLength(2);

  const acknowledgements = await readBackupAcknowledgements(page);
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements.every((ack) => ack.durable)).toBe(true);
  expect(acknowledgements.map((ack) => ack.sha256).sort()).toEqual(api.backupRequests.map((backup) => backup.sha256).sort());
});

test("mantiene una copia consistente mientras otra pestaña captura", async ({ page, context }) => {
  const passphrase = "frase compartida segura para copia concurrente";
  await installMockDeliveryApi(page, "driver-backup-capture");
  await mockPersistentStorage(context, true);
  await prepareDevice(page, passphrase);
  await recordOneDelivery(page, "Evento incluido en la copia");
  const before = await readQueueEntryStates(page);
  expect(before).toHaveLength(1);

  const secondPage = await context.newPage();
  await secondPage.goto("/app/delivery");
  await expect(secondPage.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  await secondPage.getByLabel("Frase de acceso").fill(passphrase);
  await secondPage.getByRole("button", { name: "Desbloquear" }).click();
  await expect(secondPage.getByText("1 eventos en cola")).toBeVisible();

  await page.evaluate(() => {
    const subtle = crypto.subtle;
    const originalEncrypt = subtle.encrypt.bind(subtle);
    let release!: () => void;
    let shouldHold = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    Object.defineProperty(subtle, "encrypt", {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
        if (shouldHold) {
          shouldHold = false;
          (window as Window & { __backupEncryptionStarted?: boolean }).__backupEncryptionStarted = true;
          await gate;
        }
        return originalEncrypt(...args);
      },
    });
    Object.defineProperty(window, "__releaseBackupEncryption", { configurable: true, value: () => release() });
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar copia cifrada" }).click();
  await page.waitForFunction(() => (window as Window & { __backupEncryptionStarted?: boolean }).__backupEncryptionStarted === true);

  const saveButton = secondPage.getByRole("button", { name: "Guardar entrega" });
  await secondPage.getByText("Registrar entrega", { exact: true }).click();
  await secondPage.getByLabel("Cantidad entregada").fill("1");
  await secondPage.getByLabel("Constancia / observación").fill("Evento capturado durante la copia");
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect.poll(() => secondPage.evaluate(async () =>
    (await navigator.locks.query()).pending.filter((lock) => lock.name?.startsWith("bombo-offline-writer:")).length,
  )).toBe(1);
  expect(await readQueueEntryStates(page)).toHaveLength(1);

  await page.evaluate(() => (window as Window & { __releaseBackupEncryption?: () => void }).__releaseBackupEncryption?.());
  const download = await downloadPromise;
  await expect(secondPage.getByText("2 eventos en cola")).toBeVisible();
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Playwright no entregó la copia concurrente para verificarla.");
  const backupPackage = JSON.parse(await readFile(downloadPath, "utf8")) as EncryptedBackupPackageV1;
  const keys = await unlockKeyring(backupPackage.keyring, passphrase);
  const payload = await decryptJson<{ queue: Array<{ requestId: string }> }>(
    backupPackage.queuePayload,
    keys.queue,
    aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "backup-queue", backupPackage.packageId),
  );
  expect(payload.queue.map((entry) => entry.requestId)).toEqual([before[0]!.requestId]);
  expect((await readQueueEntryStates(page)).map((entry) => entry.requestId)).toHaveLength(2);
});

test("serializa dos pestañas durante una sincronización pendiente", async ({ page, context }) => {
  const passphrase = "frase compartida segura para dos pestañas";
  let releaseFirstSync!: () => void;
  let markFirstSyncStarted!: () => void;
  const firstSyncGate = new Promise<void>((resolve) => { releaseFirstSync = resolve; });
  const firstSyncStarted = new Promise<void>((resolve) => { markFirstSyncStarted = resolve; });
  let syncCalls = 0;
  const api = await installMockDeliveryApi(page, "driver-two-tabs", async (request) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      markFirstSyncStarted();
      await firstSyncGate;
    }
    const event = request.events?.[0];
    return {
      status: 200,
      body: { results: [{ requestId: event?.requestId, targetId: event?.targetId, version: 1, result: {}, replay: false, status: "accepted" }] },
    };
  });
  await mockPersistentStorage(context, true);
  await prepareDevice(page, passphrase);
  await recordOneDelivery(page, "Entrega compartida entre pestañas");

  const secondPage = await context.newPage();
  await secondPage.goto("/app/delivery");
  await expect(secondPage.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  await secondPage.getByLabel("Frase de acceso").fill(passphrase);
  await secondPage.getByRole("button", { name: "Desbloquear" }).click();
  await expect(secondPage.getByText("Dispositivo listo.", { exact: false })).toBeVisible();
  await expect(secondPage.getByText("1 eventos en cola")).toBeVisible();

  try {
    await page.getByRole("button", { name: "Sincronizar ahora" }).click();
    await firstSyncStarted;

    const secondSyncButton = secondPage.getByRole("button", { name: "Sincronizar ahora" });
    await secondSyncButton.click();
    await expect(secondSyncButton).toBeDisabled();
    await expect.poll(() => secondPage.evaluate(async () =>
      (await navigator.locks.query()).pending.filter((lock) => lock.name?.startsWith("bombo-offline-writer:")).length,
    )).toBe(1);
    expect(api.syncRequests).toHaveLength(1);
  } finally {
    releaseFirstSync();
  }

  await expect(page.getByRole("status").filter({ hasText: "Sincronización:" })).toContainText("Sincronización:");
  await expect(secondPage.getByRole("status").filter({ hasText: "Sincronización:" })).toContainText("Sincronización:");
  expect(api.syncRequests).toHaveLength(1);
  expect(api.syncRequests[0]?.events?.[0]?.requestId).toMatch(UUID_V4);
  await expect.poll(() => readQueueEntryState(page, api.syncRequests[0]!.events![0]!.requestId!)).toMatchObject({
    status: "accepted",
    attempted: true,
  });
});

test("exige validación en línea después de cinco frases incorrectas", async ({ page, context }) => {
  const passphrase = "frase correcta local para el turno";
  const api = await installMockDeliveryApi(page, "driver-lockout");
  await mockPersistentStorage(page, true);
  await prepareDevice(page, passphrase);
  await page.getByRole("button", { name: "Bloquear" }).click();
  await expect(page.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();

  const manifestRequestsBeforeOffline = api.manifestRequests;
  await context.setOffline(true);
  await expect(page.getByText("Sin conexión", { exact: true })).toBeVisible();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.getByLabel("Frase de acceso").fill(`frase incorrecta de prueba ${attempt}`);
    await page.getByRole("button", { name: "Desbloquear" }).click();
    await expect(page.getByRole("alert")).toContainText(attempt === 5 ? "Se agotaron cinco intentos" : "no coincide");
    await expect(page.getByRole("alert")).toBeFocused();
  }

  await page.getByLabel("Frase de acceso").fill(passphrase);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.getByRole("alert")).toContainText("Se agotaron cinco intentos");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Desbloqueá tu turno" })).toBeVisible();
  expect(api.manifestRequests).toBe(manifestRequestsBeforeOffline);

  await context.setOffline(false);
  await expect(page.getByText("En línea", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Obtener turno en línea" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Turno obtenido" })).toContainText("Turno obtenido");
  await page.getByLabel("Frase de acceso").fill(passphrase);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.getByText("Dispositivo listo.", { exact: false })).toBeVisible();
});

test("mantiene el UUID pendiente ante un ACK parcial y acepta el mismo evento al reintentar", async ({ page }) => {
  const userId = "driver-partial-ack";
  let syncRound = 0;
  const api = await installMockDeliveryApi(page, userId, (request) => {
    syncRound += 1;
    const requestId = request.events?.[0]?.requestId;
    if (syncRound === 1) return { status: 200, body: { results: [] } };
    return {
      status: 200,
      body: { results: [{ requestId, targetId: DELIVERY_ID, version: 1, result: {}, replay: false, status: "accepted" }] },
    };
  });
  await mockPersistentStorage(page, true);
  await prepareDevice(page, "frase local segura para sync parcial");
  await recordOneDelivery(page, "Entrega que espera confirmación completa");

  const deviceId = api.manifestDeviceIds[0];
  expect(deviceId).toMatch(UUID_V4);
  await page.getByRole("button", { name: "Sincronizar ahora" }).click();
  await expect(page.getByRole("alert")).toContainText("no confirmó el UUID enviado");
  await expect(page.getByRole("alert")).toBeFocused();
  expect(api.syncRequests).toHaveLength(1);
  const requestId = api.syncRequests[0]?.events?.[0]?.requestId;
  expect(requestId).toMatch(UUID_V4);

  const pendingState = await readQueueEntryState(page, requestId!);
  expect(pendingState).toEqual({ requestId, status: "pending", attempted: true });

  await page.getByRole("button", { name: "Sincronizar ahora" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 aceptados" })).toContainText("1 aceptados");
  await expect(page.getByText("Sincronizado: 1")).toBeVisible();
  expect(api.syncRequests).toHaveLength(2);
  expect(api.syncRequests.map((request) => request.events?.[0]?.requestId)).toEqual([requestId, requestId]);

  const acceptedState = await readQueueEntryState(page, requestId!);
  expect(acceptedState).toEqual({ requestId, status: "accepted", attempted: true });
});

test("un conflicto bloquea las capturas que dependen de esa versión", async ({ page }) => {
  const userId = "driver-conflict-dependency";
  const api = await installMockDeliveryApi(page, userId, (request) => ({
    status: 200,
    body: { results: [{ requestId: request.events?.[0]?.requestId, status: "conflict", code: "VERSION_CONFLICT" }] },
  }));
  await mockPersistentStorage(page, true);
  await prepareDevice(page, "frase local segura para conflicto");
  await recordOneDelivery(page, "Captura cuya versión será rechazada");

  const deliveryDetails = page.locator("details").filter({ has: page.getByText("Registrar entrega", { exact: true }) });
  await deliveryDetails.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByLabel("Cantidad entregada").fill("1");
  await page.getByLabel("Constancia / observación").fill("Captura dependiente del primer evento");
  await page.getByRole("button", { name: "Guardar entrega" }).click();
  await expect(page.getByText("2 eventos en cola")).toBeVisible();

  await page.getByRole("button", { name: "Sincronizar ahora" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 conflictos" })).toContainText("1 conflictos");
  await expect(page.getByText("Conflicto: 1")).toBeVisible();
  await expect(page.getByText("Hay una entrega de esta parada que puede no estar reflejada", { exact: false })).toBeVisible();
  await expect(page.getByText("Remanente del último manifiesto: 3 g", { exact: true })).toBeVisible();
  await expect(page.getByText("En espera: 1")).toBeVisible();
  expect(api.syncRequests).toHaveLength(1);

  const [first, dependent] = await readQueueEntryStates(page);
  expect(first).toMatchObject({ status: "conflict", attempted: true, dependsOn: null, sequence: 1 });
  expect(dependent).toMatchObject({ status: "blocked", attempted: false, dependsOn: first?.requestId, sequence: 2 });
});

test("borra documentos locales y conserva la cola aunque falle el cierre remoto", async ({ page }) => {
  const userId = "driver-logout-failure";
  const api = await installMockDeliveryApi(page, userId);
  await mockPersistentStorage(page, true);
  await prepareDevice(page, "frase local segura para cerrar turno");
  await recordOneDelivery(page, "La captura pendiente debe sobrevivir al cierre");

  const deviceId = api.manifestDeviceIds[0];
  expect(deviceId).toMatch(UUID_V4);
  const profileId = `${userId}:${deviceId}`;
  await page.evaluate(async (activeProfileId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bombo-delivery-offline-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("documents", "readwrite", { durability: "strict" });
    transaction.objectStore("documents").put({
      id: `${activeProfileId}:test-document`,
      profileId: activeProfileId,
      encrypted: { algorithm: "AES-256-GCM", iv: "AA==", ciphertext: "AA==" },
      mimeType: "application/pdf",
      byteLength: 0,
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, profileId);

  const readLocalState = () => page.evaluate(async (activeProfileId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bombo-delivery-offline-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<{ documents: number; queued: number; hasManifest: boolean }>((resolve, reject) => {
      const transaction = database.transaction(["documents", "outbox", "records"], "readonly");
      const documents = transaction.objectStore("documents").index("byProfile").getAll(IDBKeyRange.only(activeProfileId));
      const queued = transaction.objectStore("outbox").index("byProfile").getAll(IDBKeyRange.only(activeProfileId));
      const manifest = transaction.objectStore("records").get(`manifest:${activeProfileId}`);
      transaction.oncomplete = () => {
        database.close();
        resolve({ documents: documents.result.length, queued: queued.result.length, hasManifest: Boolean(manifest.result) });
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    });
  }, profileId);

  expect(await readLocalState()).toEqual({ documents: 1, queued: 1, hasManifest: true });
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 503, json: { error: "Cierre remoto no disponible" } }));
  const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/logout");
  await page.getByRole("button", { name: "Salir y borrar documentos" }).click();
  expect((await logoutResponse).status()).toBe(503);
  await expect.poll(readLocalState).toEqual({ documents: 0, queued: 1, hasManifest: false });
});
