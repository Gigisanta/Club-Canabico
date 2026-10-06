import type { Page, Request, Response } from "@playwright/test";
import { expect, test } from "./isolated";

const contextPath = "/api/operations/context";

function isContextRequest(request: Request) {
  return new URL(request.url()).pathname === contextPath && request.method() === "GET";
}

function isContextResponse(response: Response) {
  return isContextRequest(response.request());
}

async function signInOwner(page: Page) {
  await page.goto("/app/operations?section=orders");
  await page.getByLabel("Nombre de usuario").fill("OWNER");
  await page.getByLabel("Contraseña", { exact: true }).fill("Demo-Bombo-2026!");
  const login = page.waitForResponse(response =>
    response.url().endsWith("/api/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
  expect((await login).status()).toBe(200);
}

function trackContextRequests(page: Page) {
  const requests: Request[] = [];
  page.on("request", request => {
    if (isContextRequest(request)) requests.push(request);
  });
  return requests;
}

test("owner loads one live context, refreshes it, and keeps the requested section", async ({ page }) => {
  const requests = trackContextRequests(page);
  const avatarAsset = page.waitForResponse(response => new URL(response.url()).pathname === "/brand/profile-portraits.webp");
  const initialContext = page.waitForResponse(isContextResponse);
  await signInOwner(page);
  const first = await initialContext;
  const avatar = await avatarAsset;
  expect(first.status()).toBe(200);
  expect(avatar.status()).toBe(200);
  expect(await avatar.headerValue("content-type")).toContain("image/webp");
  const context = await first.json();
  expect(context.profile).toBe("owner");
  expect(context.capabilities).toContain("orders.write");

  await expect(page.locator(".ops-console")).toBeVisible();
  await expect(page.locator(".ops-profile-copy strong")).toHaveText("Tiziano");
  await expect(page.locator(".ops-avatar")).toHaveCSS("background-position", "100% 0%");
  await expect(page.locator(".ops-avatar")).toHaveCSS("background-image", /profile-portraits\.webp/);
  await expect(page).toHaveURL(/\/app\/operations\?section=orders$/);
  await expect(page.getByRole("button", { name: "Pedidos", exact: true })).toHaveAttribute("aria-current", "page");
  expect(requests).toHaveLength(1);

  const refreshedContext = page.waitForResponse(isContextResponse);
  await page.getByRole("button", { name: "Actualizar consola", exact: true }).click();
  const refreshed = await refreshedContext;
  expect(refreshed.status()).toBe(200);
  const refreshedBody = await refreshed.json();
  expect(refreshedBody.userId).toBe(context.userId);
  expect(refreshedBody.capabilities).toContain("orders.write");
  await expect(page.getByRole("button", { name: "Actualizar consola", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/app\/operations\?section=orders$/);
  await expect(page.getByRole("button", { name: "Pedidos", exact: true })).toHaveAttribute("aria-current", "page");
  expect(requests).toHaveLength(2);

  let failNextContext = true;
  await page.route(`**${contextPath}`, async route => {
    if (failNextContext) {
      failNextContext = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const failedContext = page.waitForEvent("requestfailed", request => isContextRequest(request));
  await page.getByRole("button", { name: "Actualizar consola", exact: true }).click();
  await failedContext;
  await expect(page.getByRole("alert")).toContainText("No pudimos actualizar el acceso");
  await expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible();
  await expect(page.locator(".ops-console")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pedidos", exact: true })).toHaveAttribute("aria-current", "page");

  const retryContext = page.waitForResponse(isContextResponse);
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  const recovered = await retryContext;
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).capabilities).toContain("orders.write");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/operations\?section=orders$/);
  expect(requests).toHaveLength(4);
});

test("an unavailable initial context keeps the owner out until a real retry succeeds", async ({ page }) => {
  const requests = trackContextRequests(page);
  let attempts = 0;
  await page.route(`**${contextPath}`, async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await signInOwner(page);
  await expect(page.getByRole("alert")).toContainText("No pudimos validar el acceso operativo");
  await expect(page.locator(".ops-console")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pedidos", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(1);

  const recoveredContext = page.waitForResponse(isContextResponse);
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  const recovered = await recoveredContext;
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).capabilities).toContain("orders.write");
  await expect(page.locator(".ops-console")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pedidos", exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("a revoked session's real 401 removes operational context", async ({ page }) => {
  const requests = trackContextRequests(page);
  let commandRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/operations/commands" && request.method() === "POST") commandRequests += 1;
  });
  const initialContext = page.waitForResponse(isContextResponse);
  await signInOwner(page);
  expect((await initialContext).status()).toBe(200);
  await expect(page.locator(".ops-console")).toBeVisible();

  const createOrder = page.getByRole("group", { name: "Pedidos: acciones", exact: true }).getByRole("button", { name: "＋ Nuevo pedido", exact: true });
  await createOrder.click();
  const orderDialog = page.getByRole("dialog");
  const member = orderDialog.getByRole("combobox", { name: "Socio", exact: true });
  await expect(member.locator("option").nth(1)).toBeAttached();
  const memberId = await member.locator("option").nth(1).getAttribute("value");
  expect(memberId).toBeTruthy();
  await member.selectOption(memberId!);
  await orderDialog.getByLabel("Modalidad", { exact: true }).selectOption("local");
  await orderDialog.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  const orderCreated = page.waitForResponse(response =>
    response.url().endsWith("/api/operations/commands") &&
    response.request().method() === "POST" &&
    response.request().postDataJSON()?.command === "OrderCreated",
  );
  await orderDialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const created = await orderCreated;
  expect(created.status()).toBe(200);
  const createdBody = await created.json();
  expect(createdBody.targetId).toBeTruthy();
  const persistedOrder = await page.request.get(`/api/operations/orders/${createdBody.targetId}`);
  expect(persistedOrder.status()).toBe(200);
  expect((await persistedOrder.json()).order.memberId).toBe(memberId);
  await expect(page.locator(".ops-toast")).toBeVisible();
  expect(commandRequests).toBe(1);

  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(logout.status()).toBe(200);
  expect((await logout.json()).ok).toBe(true);

  let rejectedStatus = 403;
  const rejectOperations = (route: import("@playwright/test").Route) => route.fulfill({
    status: rejectedStatus,
    contentType: "application/json",
    body: JSON.stringify({ error: rejectedStatus === 403 ? "El alcance no permite consultar este recurso." : "Iniciá sesión para continuar." }),
  });
  await page.route("**/api/operations/**", rejectOperations);
  const scopedCatalog = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/operations/catalog" && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Catálogo y stock", exact: true }).click();
  expect((await scopedCatalog).status()).toBe(403);
  await expect(page.locator(".ops-console")).toBeVisible();
  await expect(page.locator(".ops-page-body").getByRole("alert")).toContainText("El alcance no permite consultar este recurso.");

  rejectedStatus = 401;
  await page.unroute("**/api/operations/**", rejectOperations);
  const rejectedCatalog = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/operations/catalog" && response.request().method() === "GET",
  );
  await page.locator(".ops-page-body").getByRole("button", { name: "Reintentar", exact: true }).click();
  const rejected = await rejectedCatalog;
  expect(rejected.status()).toBe(401);
  await expect(page.locator(".ops-console")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Iniciá sesión para continuar");
  await expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Volver al panel", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".ops-toast")).toHaveCount(0);
  expect(commandRequests).toBe(1);
  expect(requests).toHaveLength(1);
});
