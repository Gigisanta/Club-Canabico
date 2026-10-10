import type { Page, Request } from "@playwright/test";
import { test, expect } from "./isolated";

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
async function submit(page: Page, command: string, retryConfirmation = false) {
  const response = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON().command === command);
  await page.getByRole("dialog").getByRole("button", { name: retryConfirmation ? "Reintentar confirmación" : "Revisar y registrar", exact: true }).click();
  const result = await response;
  const body = await result.json();
  expect(result.status(), JSON.stringify(body)).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return body;
}
async function submitAfterLostAcknowledgement(page: Page, command: string, malformedVersion = false) {
  let committed: { requestId: string; targetId: string } | undefined;
  const loseAcknowledgement = async (route: import("@playwright/test").Route) => {
    if (route.request().postDataJSON().command !== command) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = await response.json();
    if (malformedVersion) await route.fulfill({ response, json: { ...committed, version: -1 } });
    else await route.abort("failed");
  };
  await page.route("**/api/operations/commands", loseAcknowledgement);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Revisar y registrar" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Confirmación pendiente");
  expect(committed).toBeDefined();
  await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cerrar formulario", exact: true })).toBeDisabled();
  await expect(dialog.locator("input:not([type=hidden]), select, textarea").first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/operations/commands", loseAcknowledgement);
  const replay = await submit(page, command, true);
  expect(replay.replay).toBe(true);
  expect(replay.requestId).toBe(committed!.requestId);
  expect(replay.targetId).toBe(committed!.targetId);
  return replay;
}
async function report(page: Page, orderId: string, amount: string, custody?: string, loseAcknowledgement = false) {
  await page.getByRole("button", { name: "Cobros", exact: true }).click();
  await page.locator(".ops-header-actions").getByRole("button", { name: "＋ Reportar cobro", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Pedido confirmado").selectOption(orderId);
  await dialog.getByLabel("Medio recibido").selectOption("cash");
  await dialog.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  await dialog.getByLabel("Importe recibido", { exact: true }).fill(amount);
  if (custody) await dialog.getByLabel("Custodia del efectivo (opcional)").selectOption(custody);
  await dialog.getByLabel("Nota del reporte").fill("Evidencia sintética del reporte, sin recepción verificada todavía.");
  const response = await (loseAcknowledgement ? submitAfterLostAcknowledgement(page, "CollectionReported") : submit(page, "CollectionReported"));
  return response.result.report.id as string;
}
async function verify(page: Page, collectionId: string, accountId: string) {
  const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collectionId)
    ? collectionId.slice(0, 8).toUpperCase()
    : collectionId;
  const row = page.locator("tbody tr").filter({ hasText: `Cobro #${reference}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Verificar recepción", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Cuenta donde se recibió físicamente").selectOption(accountId);
  await dialog.getByLabel("Tratamiento de un excedente").selectOption("member_credit");
  await dialog.getByLabel("Evidencia de recepción").fill("Arqueo sintético independiente de la ubicación del efectivo.");
  await submit(page, "CollectionVerified");
}
const balance = (accounts: { items: Array<{ id: string; balanceMinor: string }> }, id: string) => BigInt(accounts.items.find(account => account.id === id)!.balanceMinor);
const gramsToMilliunits = (value: string) => {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  expect(match, `Cantidad en gramos inválida: ${value}`).not.toBeNull();
  return BigInt(match![1]!) * 1000n + BigInt((match![2] ?? "").padEnd(3, "0"));
};

// Browser ownership covers form availability, exact serialization, and repeated partial pickup.
// Server suites own authorization races and accounting invariants; this uses their real HTTP path.
test("local pre-order keeps its approved price while physical extra and partial pickups reach stock and cash", async ({ page }) => {
  await login(page);
  const accountsBefore = await get(page, "accounts");
  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: "ops-local-draft" });
  await row.getByRole("button", { name: "Cotizar", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Medio de pago( general)?$/).selectOption("cash");
  await dialog.getByLabel("Producto", { exact: true }).selectOption("ops-sku-b");
  await dialog.getByLabel("Cantidad solicitada", { exact: true }).fill("5");
  await dialog.getByLabel("Tarifa y escala aprobadas").selectOption({ label: "Tarifa de ensayo · escala-5 · desde 5 · 5500 ARS" });
  await submitAfterLostAcknowledgement(page, "OrderQuoted");
  expect((await get(page, "orders/ops-local-draft")).order.quoteVersion).toBe(1);
  await expect(row).toContainText("28.875");
  await row.getByRole("button", { name: "Confirmar pedido", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Aceptación registrada").fill("Aceptación sintética de la cotización congelada.");
  await submit(page, "OrderConfirmed");
  const detail = await get(page, "orders/ops-local-draft");
  expect(detail.reservations).toHaveLength(1);
  expect(detail.reservations[0].quantity).toBe("5");
  const reservedBalanceId = detail.reservations[0].balanceId as string;
  const catalogBeforePreparation = await get(page, "catalog");
  const skuBeforePreparation = catalogBeforePreparation.items.find((sku: { id: string }) => sku.id === "ops-sku-b");
  const balanceBeforePreparation = skuBeforePreparation?.lots
    .flatMap((lot: { balances: Array<{ id: string; reserved: string }> }) => lot.balances)
    .find((stockBalance: { id: string }) => stockBalance.id === reservedBalanceId);
  expect(balanceBeforePreparation).toBeDefined();
  const reservedBeforePreparation = gramsToMilliunits(balanceBeforePreparation!.reserved);
  await row.getByRole("button", { name: "Preparar por lote", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/Cantidad reservada · Variedad B/)).toHaveValue("5");
  await dialog.getByLabel("Peso real · Variedad B", { exact: true }).fill("5,035");
  await dialog.getByLabel("Evidencia de preparación").fill("Pesaje sintético de 5,035 g sobre 5 g facturados.");
  await submit(page, "OrderPrepared");
  for (const [quantity, physical] of [["2", "2,014"], ["3", "3,021"]]) {
    await row.getByRole("button", { name: "Completar retiro", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Cantidad entregada · renglón 1: Variedad B", { exact: true }).fill(quantity!);
    await dialog.getByLabel("Cantidad física · renglón 1: Variedad B", { exact: true }).fill(physical!);
    await dialog.getByLabel("Evidencia del retiro").fill("Retiro parcial sintético, sin volver a descontar stock.");
    // Delay the real refreshed read: the committed pickup must disable stale actions
    // until the server's next version and remaining quantities reach the screen.
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const delayOrders = async (route: import("@playwright/test").Route) => {
      const response = await route.fetch();
      readStarted();
      await heldRead;
      await route.fulfill({ response });
    };
    if (quantity === "2") await page.route("**/api/operations/orders", delayOrders);
    await submit(page, "LocalPickupCompleted");
    if (quantity === "2") {
      await started;
      try { await expect(row.getByRole("button", { name: "Completar retiro", exact: true })).toBeDisabled(); }
      finally { releaseRead(); }
      await expect(row.getByRole("button", { name: "Completar retiro", exact: true })).toBeEnabled();
      await page.unroute("**/api/operations/orders", delayOrders);
    }
  }
  const picked = await get(page, "orders/ops-local-draft");
  expect(picked.order.fulfillmentState).toBe("delivered");
  expect(picked.order.totalMinor).toBe("2887500");
  expect(picked.allocations[0].actualQuantity).toBe("5.035");
  expect(picked.allocations[0].deliveredQuantity).toBe("5.035");
  expect(picked.reservations).toHaveLength(0);
  const catalog = await get(page, "catalog");
  const sku = catalog.items.find((sku: { id: string }) => sku.id === "ops-sku-b");
  const preparedBalance = sku.lots.flatMap((lot: { balances: Array<{ id: string; quantity: string; reserved: string }> }) => lot.balances)
    .find((stockBalance: { id: string }) => stockBalance.id === reservedBalanceId);
  expect(preparedBalance).toBeDefined();
  expect(preparedBalance!.quantity).toBe("94.965");
  expect(gramsToMilliunits(preparedBalance!.reserved)).toBe(reservedBeforePreparation - gramsToMilliunits(detail.reservations[0].quantity));
  const collectionId = await report(page, "ops-local-draft", "28875");
  expect(balance(await get(page, "accounts"), "ops-cash-ARS")).toBe(balance(accountsBefore, "ops-cash-ARS"));
  await verify(page, collectionId, "ops-cash-ARS");
  expect(balance(await get(page, "accounts"), "ops-cash-ARS")).toBe(balance(accountsBefore, "ops-cash-ARS") + 2887500n);
  expect((await get(page, "orders/ops-local-draft")).order.financialState).toBe("paid");
});

test("finance UI verifies courier custody and accepts a gross rendition without applying the collection twice", async ({ page }) => {
  await login(page);
  const before = await get(page, "accounts");
  const orderBefore = await get(page, "orders/ops-delivery-order");
  const collectionId = await report(page, "ops-delivery-order", "25000", "ops-driver", true);
  expect((await get(page, "collections")).items.filter((row: { id: string }) => row.id === collectionId)).toHaveLength(1);
  expect(balance(await get(page, "accounts"), "ops-courier-ARS")).toBe(balance(before, "ops-courier-ARS"));
  await verify(page, collectionId, "ops-courier-ARS");
  const verified = await get(page, "accounts");
  expect(balance(verified, "ops-cash-ARS")).toBe(balance(before, "ops-cash-ARS"));
  expect(balance(verified, "ops-courier-ARS")).toBe(balance(before, "ops-courier-ARS") + 2500000n);
  let releaseAccountsRequest!: () => void;
  let signalAccountsRequest!: () => void;
  let signalAccountsRequestContinued!: () => void;
  const releaseAccounts = new Promise<void>(resolve => { releaseAccountsRequest = resolve; });
  const accountsRequestStarted = new Promise<void>(resolve => { signalAccountsRequest = resolve; });
  const accountsRequestContinued = new Promise<void>(resolve => { signalAccountsRequestContinued = resolve; });
  let accountsRequestIntercepted = false;
  const holdAccountsRequest = async (route: import("@playwright/test").Route) => {
    accountsRequestIntercepted = true;
    signalAccountsRequest();
    try {
      await releaseAccounts;
      await route.continue();
    } finally {
      signalAccountsRequestContinued();
    }
  };
  const commandRequestsDuringHold: Request[] = [];
  const observeRenditionCommands = (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/operations/commands") commandRequestsDuringHold.push(request);
  };
  await page.route("**/api/operations/accounts", holdAccountsRequest);
  page.on("request", observeRenditionCommands);
  try {
    await page.getByRole("button", { name: "Rendiciones", exact: true }).click();
    await accountsRequestStarted;
    const acceptButton = page.locator(".ops-header-actions").getByRole("button", { name: "＋ Aceptar rendición", exact: true });
    await expect(acceptButton).toBeVisible();
    await expect(acceptButton).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Cargando cuentas y referencias para aceptar una rendición" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(commandRequestsDuringHold).toHaveLength(0);
  } finally {
    releaseAccountsRequest();
    if (accountsRequestIntercepted) await accountsRequestContinued;
    await page.unroute("**/api/operations/accounts", holdAccountsRequest);
    page.off("request", observeRenditionCommands);
  }
  const acceptButton = page.locator(".ops-header-actions").getByRole("button", { name: "＋ Aceptar rendición", exact: true });
  await expect(acceptButton).toBeEnabled();
  await acceptButton.click();
  const dialog = page.getByRole("dialog");
  const sourceAccount = dialog.getByLabel("Custodia de origen · moneda");
  const destinationAccount = dialog.getByLabel("Cuenta del club de destino");
  await expect(sourceAccount.locator('option[value="ops-courier-ARS"]')).toHaveCount(1);
  await expect(destinationAccount.locator('option[value="ops-cash-ARS"]')).toHaveCount(1);
  await sourceAccount.selectOption("ops-courier-ARS");
  await destinationAccount.selectOption("ops-cash-ARS");
  await dialog.getByLabel("Dinero bruto por rendir").fill("25000");
  await dialog.getByLabel("Modalidad de rendición").selectOption("gross");
  await dialog.getByLabel("Turno asociado (opcional)").selectOption("ops-route");
  await dialog.getByLabel("Evidencia de la rendición").fill("Entrega sintética y arqueo independiente de la custodia.");
  await submitAfterLostAcknowledgement(page, "RenditionAccepted", true);
  const after = await get(page, "accounts"), orderAfter = await get(page, "orders/ops-delivery-order");
  expect(balance(after, "ops-courier-ARS")).toBe(balance(before, "ops-courier-ARS"));
  expect(balance(after, "ops-cash-ARS")).toBe(balance(before, "ops-cash-ARS") + 2500000n);
  expect(BigInt(orderAfter.order.verifiedMinor)).toBe(BigInt(orderBefore.order.verifiedMinor) + 2500000n);
  expect((await get(page, "settlements")).items).toHaveLength(1);
  await page.getByRole("button", { name: "Políticas y promociones", exact: true }).click();
  const simulation = page.getByRole("region", { name: "Margen previsto del pack" });
  await simulation.getByLabel("Pack para simular").selectOption("ops-pack");
  for (let index = 1; index <= 3; index++) await simulation.getByLabel(`Costo por gramo · componente ${index}`).fill("2000");
  await simulation.getByLabel("Otros costos variables previstos").fill("1000");
  await simulation.getByRole("button", { name: "Calcular margen previsto" }).click();
  await expect(simulation.getByLabel("Resultado de la simulación")).toContainText("44.000,00");
  await expect(simulation.getByLabel("Resultado de la simulación")).toContainText("58.67 %");
  await expect(simulation.getByLabel("Resultado de la simulación")).toContainText("150.00 %");
  expect(balance(await get(page, "accounts"), "ops-cash-ARS")).toBe(balance(after, "ops-cash-ARS"));
  expect((await get(page, "settlements")).items).toHaveLength(1);
});
