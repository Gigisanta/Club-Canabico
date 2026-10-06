import type { Page } from "@playwright/test";
import { expect, test } from "./isolated";

type CommandEnvelope = {
  command: string;
  requestId: string;
  targetId: string;
  data: Record<string, unknown>;
};

async function login(page: Page) {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
}

async function get(page: Page, path: string) {
  const response = await page.request.get(`/api/operations/${path}`);
  expect(response.status()).toBe(200);
  return response.json();
}

function commandRequest(page: Page, command: string, method = "POST") {
  return page.waitForRequest(request => {
    if (request.method() !== method || !request.url().endsWith("/api/operations/commands")) return false;
    try { return request.postDataJSON().command === command; } catch { return false; }
  });
}

test("account setup replays the same bootstrap after a fresh read says it is no longer eligible", async ({ page }) => {
  await login(page);

  let serveEligibleSnapshot = false;
  let eligibleSnapshotServed = false;
  await page.route("**/api/operations/accounts*", async route => {
    if (route.request().method() !== "GET") return route.continue();
    if (serveEligibleSnapshot && !eligibleSnapshotServed) {
      eligibleSnapshotServed = true;
      // A valid older snapshot: an empty club-account list is eligible for setup.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], versions: {}, currenciesCombined: false, accountBootstrapEligible: true }),
      });
      return;
    }
    // Reads outside that one older snapshot use the real E2E fixture.
    await route.continue();
  });

  const bootstrapRequests: CommandEnvelope[] = [];
  await page.route("**/api/operations/commands", async route => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    let envelope: CommandEnvelope;
    try { envelope = request.postDataJSON() as CommandEnvelope; } catch { return route.continue(); }
    if (envelope.command !== "AccountsInitialized") return route.continue();
    bootstrapRequests.push(envelope);
    if (bootstrapRequests.length === 1) {
      // Lose the first acknowledgement at the transport boundary; do not fake a successful write.
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Cuentas y saldos", exact: true }).click();
  await expect(page.locator(".ops-list-sheet tbody tr").first()).toBeVisible();
  const setupButton = page.getByRole("button", { name: "Configurar seis cuentas", exact: true });
  await expect(setupButton).toHaveCount(0);

  serveEligibleSnapshot = true;
  const eligibleRead = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/accounts");
  await page.locator(".ops-header-actions").getByRole("button", { name: "↻ Actualizar", exact: true }).click();
  const eligible = await eligibleRead;
  expect((await eligible.json()).accountBootstrapEligible).toBe(true);

  await expect(setupButton).toBeVisible();

  await setupButton.click();
  await expect(page.getByRole("heading", { name: "Prepará las seis cuentas del club" })).toBeVisible();
  const setup = page.locator(".ops-account-setup");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavClose = page.locator(".ops-sidebar.is-open .ops-mobile-close");
  if (await mobileNavClose.isVisible()) await mobileNavClose.click();
  await expect(page.locator(".ops-sidebar.is-open")).toHaveCount(0);
  await expect.poll(() => page.locator(".ops-sidebar").evaluate(sidebar => sidebar.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobileWidth = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  console.info("AccountSetup mobile width", mobileWidth);
  expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
  await page.screenshot({ path: ".local/ui-qa/after/account-setup-mobile.png" });
  await setup.locator(".ops-sheet-head").getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Prepará las seis cuentas del club" })).toHaveCount(0);
  expect(bootstrapRequests).toHaveLength(0);

  await setupButton.click();
  const rows = setup.locator(".ops-repeat-row");
  await expect(rows).toHaveCount(6);
  const kinds = ["cash", "bank", "reserve", "cash", "bank", "reserve"];
  for (let index = 0; index < 6; index++) {
    const row = rows.nth(index);
    await row.getByLabel("Nombre").fill(`Cuenta de ensayo ${index + 1}`);
    await row.getByLabel("Tipo").selectOption(kinds[index]!);
    await row.getByLabel("Titular").fill("Club de ensayo");
    await row.getByLabel("Uso de la cuenta").fill(`Uso sintético ${index + 1}`);
  }

  const firstRequest = commandRequest(page, "AccountsInitialized");
  await page.getByRole("button", { name: "Crear seis cuentas", exact: true }).click();
  const firstEnvelope = await firstRequest;
  const first = firstEnvelope.postDataJSON() as CommandEnvelope;
  await expect(setup.getByRole("alert")).toContainText("confirmación quedó pendiente");
  const retryButton = page.getByRole("button", { name: "Reintentar confirmación", exact: true });
  await expect(retryButton).toBeEnabled();

  const freshRead = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/operations/accounts");
  await page.locator(".ops-header-actions").getByRole("button", { name: "↻ Actualizar", exact: true }).click();
  const refreshed = await freshRead;
  const currentSnapshot = await refreshed.json();
  expect(currentSnapshot.accountBootstrapEligible).toBe(false);
  await expect(retryButton).toBeEnabled();

  const retryResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") && response.request().postDataJSON().command === "AccountsInitialized");
  await retryButton.click();
  const rejected = await retryResponse;
  expect(rejected.status()).toBe(409);
  const rejectionBody = await rejected.json();
  expect(rejectionBody).toMatchObject({
    code: "ACCOUNTS_ALREADY_INITIALIZED",
    error: "La inicialización ya tiene cuentas",
  });
  await expect(setup.getByRole("alert")).toHaveText(rejectionBody.error);
  const cancelButton = setup.locator(".ops-sheet-head").getByRole("button", { name: "Cancelar", exact: true });
  await expect(cancelButton).toBeEnabled();

  expect(bootstrapRequests).toHaveLength(2);
  const retry = bootstrapRequests[1]!;
  expect(retry.command).toBe(first.command);
  expect(retry.targetId).toBe(first.targetId);
  expect(retry.requestId).toBe(first.requestId);
  expect(retry.data).toEqual(first.data);
  const accounts = first.data.accounts as Array<{ id: string; currency: string; kind: string }>;
  expect(accounts).toHaveLength(6);
  expect(new Set(accounts.map(account => account.id)).size).toBe(6);
  expect(accounts.every(account => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(account.id))).toBe(true);
  expect(accounts.filter(account => account.currency === "ARS")).toHaveLength(3);
  expect(accounts.filter(account => account.currency === "USD")).toHaveLength(3);
  expect(accounts.some(account => account.kind === "custody")).toBe(false);

  await cancelButton.click();
  await expect(page.getByRole("heading", { name: "Prepará las seis cuentas del club" })).toHaveCount(0);
  await expect(setup.locator("form")).toHaveCount(0);
  await expect(setupButton).toHaveCount(0);
  expect(bootstrapRequests).toHaveLength(2);

  // The actual API state remains the existing disposable fixture after its real 409 response.
  const finalAccounts = await get(page, "accounts");
  const clubAccounts = finalAccounts.items.filter((account: { kind: string }) => account.kind !== "custody");
  expect(clubAccounts.map((account: { id: string }) => account.id).sort()).toEqual([
    "ops-bank-ARS", "ops-bank-USD", "ops-cash-ARS", "ops-cash-USD", "ops-reserve-ARS", "ops-reserve-USD",
  ].sort());
});

test("purchase debt derives supplier and currency from the selected purchase and persists its link", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Obligaciones", exact: true }).click();

  const actions = page.locator(".ops-header-actions");
  const linkedAction = actions.getByRole("button", { name: "＋ Deuda de compra", exact: true });
  await expect(linkedAction).toBeVisible();
  await expect(actions.getByRole("button", { name: "＋ Deuda histórica sin vínculo", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "＋ Nueva obligación", exact: true })).toBeVisible();

  await linkedAction.click();
  const dialog = page.getByRole("dialog");
  const purchase = dialog.getByLabel("Compra y proveedor", { exact: true });
  const seededPurchase = purchase.locator('option[value="ops-purchase"]');
  await expect(seededPurchase).toHaveCount(1);
  await expect(seededPurchase).toHaveText(/Proveedor de ensayo/);
  await purchase.selectOption("ops-purchase");
  await dialog.getByLabel("Importe de la obligación", { exact: true }).fill("7200");
  await dialog.getByLabel("Vencimiento", { exact: true }).fill("2026-10-31");
  await dialog.getByLabel("Período de devengamiento · YYYY-MM", { exact: true }).fill("2026-10");
  await dialog.getByLabel("Evidencia de la deuda de compra", { exact: true }).fill("Compromiso sintético vinculado a la compra de ensayo.");
  await expect(dialog.getByLabel("ID del beneficiario")).toHaveCount(0);
  await expect(dialog.getByLabel("Moneda", { exact: true })).toHaveCount(0);

  const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") && response.request().postDataJSON().command === "PayableCreated");
  await dialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const envelope = response.request().postDataJSON() as CommandEnvelope;
  expect(envelope.data).toMatchObject({
    purchaseId: "ops-purchase",
    beneficiaryId: "ops-supplier",
    kind: "purchase",
    currency: "ARS",
    amountMinor: "720000",
    dueDate: "2026-10-31",
    accrualPeriod: "2026-10",
    evidence: { note: "Compromiso sintético vinculado a la compra de ensayo." },
  });
  await expect(dialog).toHaveCount(0);

  const finalPayables = await get(page, "payables");
  const created = finalPayables.items.find((payable: { id: string }) => payable.id === envelope.targetId);
  expect(created).toMatchObject({
    id: envelope.targetId,
    purchaseId: "ops-purchase",
    beneficiaryId: "ops-supplier",
    kind: "purchase",
    currency: "ARS",
    amountMinor: "720000",
    accrualPeriod: "2026-10",
    verified: false,
  });
  expect(String(created.dueDate).slice(0, 10)).toBe("2026-10-31");
});
