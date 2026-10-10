const CACHE_NAME = "bombo-delivery-shell-v3";
// Replaced together with CACHE_NAME by the build; null is local development.
const SHELL_RELEASE_ID = null;
const SHELL_HTML_SHA256 = null;
const SHELL_MANIFEST_PATH = "/bombo-shell-assets.json";
const DELIVERY_ENTRY_PATH = "/app/delivery";
const OFFLINE_DB_NAME = "bombo-delivery-offline-v1";
const OFFLINE_QUEUE_STORE = "outbox";
const OPTIONAL_PUBLIC_FILES = ["/manifest.webmanifest", "/brand/bombo-symbol.png"];
const ASSET_PATTERN = /^\/assets\/[^/]+\.(?:js|css|woff2?)$/i;
const EXCLUDED_PATTERN = /^\/api(?:\/|$)|\/(?:documents?|content)(?:\/|$)/i;
let shellAssetsPromise;

function isExcluded(url) {
  return url.origin !== self.location.origin || EXCLUDED_PATTERN.test(url.pathname);
}

function isManifestAssetPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname === value && !isExcluded(url) && ASSET_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function isDevelopmentAssetPath(value) {
  if (!isLocalDevelopmentOrigin() || typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname === value && !isExcluded(url) &&
      (/^\/(?:src|@vite|node_modules\/\.vite)(?:\/|$)/.test(url.pathname));
  } catch {
    return false;
  }
}

function validateManifest(value, allowDevelopmentPaths = false) {
  if (!value || value.version !== 1 || !Array.isArray(value.assets)) throw new Error("Shell asset manifest is invalid");
  if (value.assets.length > 512) throw new Error("Shell asset manifest is too large");
  const assets = [...new Set(value.assets)];
  if (assets.length !== value.assets.length || assets.some((asset) => !isManifestAssetPath(asset) && !(allowDevelopmentPaths && isDevelopmentAssetPath(asset)))) {
    throw new Error("Shell asset manifest contains an unsafe or duplicate path");
  }
  return assets;
}

function isLocalDevelopmentOrigin() {
  return self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1" || self.location.hostname === "[::1]" || self.location.hostname === "::1";
}

function assetsFromHtml(html) {
  const assets = new Set();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin !== self.location.origin || isExcluded(url) || url.search || url.hash) continue;
      if (ASSET_PATTERN.test(url.pathname) || (isLocalDevelopmentOrigin() && (/^\/(?:src|@vite|node_modules\/\.vite)(?:\/|$)/.test(url.pathname)))) {
        assets.add(url.pathname);
      }
    } catch { /* Invalid HTML references are ignored. */ }
  }
  return [...assets];
}

async function readShellAssets(cache) {
  if (shellAssetsPromise) return shellAssetsPromise;
  shellAssetsPromise = (async () => {
    const saved = await cache.match(SHELL_MANIFEST_PATH);
    if (!saved) return [];
    const parsed = await saved.json();
    return validateManifest(parsed, isLocalDevelopmentOrigin());
  })().catch((error) => {
    shellAssetsPromise = undefined;
    throw error;
  });
  return shellAssetsPromise;
}

async function installShell(cache) {
  const manifestResponse = await fetch(SHELL_MANIFEST_PATH, { cache: "reload" });
  let assets;
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.clone().json();
    if (SHELL_RELEASE_ID && manifest.release !== SHELL_RELEASE_ID) throw new Error("Shell release mismatch");
    assets = validateManifest(manifest);
    await cache.put(SHELL_MANIFEST_PATH, manifestResponse);
  } else if (manifestResponse.status === 404 && isLocalDevelopmentOrigin()) {
    const route = await fetch(DELIVERY_ENTRY_PATH, { cache: "reload" });
    if (!route.ok || !route.headers.get("content-type")?.includes("text/html")) throw new Error("Development delivery shell unavailable");
    assets = assetsFromHtml(await route.clone().text());
  } else {
    throw new Error("Built shell asset manifest unavailable");
  }

  for (const path of assets) {
    const asset = await fetch(path, { cache: "reload" });
    if (!asset.ok || isExcluded(new URL(path, self.location.origin))) throw new Error(`Shell asset unavailable: ${path}`);
    await cache.put(path, asset);
  }

  const deliveryRoute = await fetch(DELIVERY_ENTRY_PATH, { cache: "reload" });
  if (!deliveryRoute.ok || !deliveryRoute.headers.get("content-type")?.includes("text/html")) throw new Error("Delivery app route unavailable");
  if (SHELL_HTML_SHA256) {
    const digest = await crypto.subtle.digest("SHA-256", await deliveryRoute.clone().arrayBuffer());
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== SHELL_HTML_SHA256) throw new Error("Delivery HTML belongs to another release");
  }
  await cache.put(DELIVERY_ENTRY_PATH, deliveryRoute);

  for (const path of OPTIONAL_PUBLIC_FILES) {
    try {
      const response = await fetch(path, { cache: "reload" });
      if (response.ok && !isExcluded(new URL(path, self.location.origin))) await cache.put(path, response);
    } catch { /* Optional icon and manifest do not block installation. */ }
  }

  if (!manifestResponse.ok) {
    const devManifest = new Response(JSON.stringify({ version: 1, assets }), { headers: { "content-type": "application/json" } });
    await cache.put(SHELL_MANIFEST_PATH, devManifest);
  }
  shellAssetsPromise = Promise.resolve(assets);
}

async function hasWindowClients() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.length > 0;
}

async function hasOfflineQueueEntries() {
  try {
    if (!self.indexedDB || typeof self.indexedDB.databases !== "function") return true;
    const databases = await self.indexedDB.databases();
    if (!databases.some((database) => database.name === OFFLINE_DB_NAME)) return false;
    const database = await new Promise((resolve, reject) => {
      const request = self.indexedDB.open(OFFLINE_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Offline database unavailable"));
      request.onblocked = () => reject(new Error("Offline database is blocked"));
    });
    try {
      if (!database.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) return true;
      const transaction = database.transaction(OFFLINE_QUEUE_STORE, "readonly");
      const request = transaction.objectStore(OFFLINE_QUEUE_STORE).count();
      const count = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Offline queue unavailable"));
        transaction.onabort = () => reject(transaction.error || new Error("Offline queue transaction aborted"));
      });
      return count > 0;
    } finally {
      database.close();
    }
  } catch {
    // A failed or unsupported inspection must retain the old shell.
    return true;
  }
}

async function pruneOldShellCaches() {
  if (await hasWindowClients()) return;
  if (await hasOfflineQueueEntries()) return;
  for (const name of await caches.keys()) {
    if (name.startsWith("bombo-delivery-shell-") && name !== CACHE_NAME) await caches.delete(name);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await installShell(cache);
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await pruneOldShellCaches();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isExcluded(url)) return;

  if (request.mode === "navigate") {
    if (url.pathname !== DELIVERY_ENTRY_PATH && !url.pathname.startsWith(`${DELIVERY_ENTRY_PATH}/`)) return;
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(url.pathname === DELIVERY_ENTRY_PATH ? DELIVERY_ENTRY_PATH : DELIVERY_ENTRY_PATH)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const assets = await readShellAssets(cache);
    const isListed = assets.includes(url.pathname) && !url.search && !url.hash && !isExcluded(url);
    if (!isListed) return fetch(request);
    // Only same-origin, versioned public shell files reach this branch. Their
    // content is fixed by the asset hash, even when the server varies CORS
    // headers between the install fetch and a module request after restart.
    const cached = await cache.match(request, { ignoreSearch: false, ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque" && !isExcluded(url)) await cache.put(request, response.clone());
    return response;
  })());
});
