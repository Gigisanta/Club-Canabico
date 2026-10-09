import type { Page, Request } from "@playwright/test";
import { expect, test } from "./isolated";

type CommandEnvelope = {
  schemaVersion: number;
  requestId: string;
  targetId: string;
  expectedVersion: number;
  occurredAt: string;
  command: string;
  data: Record<string, unknown>;
};

const field = (invoice: ReturnType<Page["getByTestId"]>, name: string) => invoice.locator(`[name="${name}"]`);

function isCommand(request: Request, command?: string) {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/operations/commands") return false;
  try { return command === undefined || request.postDataJSON().command === command; } catch { return false; }
}

async function enterOrders(page: Page) {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
}

async function openInvoice(page: Page) {
  await page.getByTestId("appsheet-invoice-open").click();
  const invoice = page.getByTestId("appsheet-invoice-dialog");
  await expect(invoice).toBeVisible();
  return invoice;
}

async function selectMember(invoice: ReturnType<Page["getByTestId"]>) {
  await invoice.getByRole("searchbox", { name: "Buscar cliente por nombre", exact: true }).fill("Socio de ensayo");
  const member = field(invoice, "memberId");
  await expect(member.locator('option[value="ops-member"]')).toHaveCount(1);
  await member.selectOption("ops-member");
  await expect(field(invoice, "address")).toHaveValue("Dirección sintética 123");
}

async function preserveInvoiceDraft(page: Page, invoice: ReturnType<Page["getByTestId"]>) {
  await selectMember(invoice);
  await field(invoice, "note").fill("Borrador sintético que debe volver intacto.");
  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await field(product, "line-skuId").selectOption("ops-sku-c");
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-quantity").fill("2.5");
  await field(product, "line-total").fill("9.99");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);
}

async function fillNewMember(page: Page, name: string) {
  await page.getByTestId("appsheet-add-member").click();
  const member = page.getByTestId("appsheet-member-dialog");
  await expect(member).toBeVisible();
  await field(member, "newMember-name").fill(name);
  await field(member, "newMember-email").fill(`qa-${crypto.randomUUID()}@example.test`);
  await field(member, "newMember-phone").fill("+5491112345678");
  await field(member, "newMember-address").fill("Domicilio sintético de prueba 44");
  return member;
}

async function commandEnvelope(request: Request): Promise<CommandEnvelope> {
  return request.postDataJSON() as CommandEnvelope;
}

test("alta en factura confirma lectura fresca, mantiene el borrador y reintenta el mismo MemberCreated", async ({ page }) => {
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await preserveInvoiceDraft(page, invoice);
  const name = `Socio sintético inline ${crypto.randomUUID().slice(0, 8)}`;
  const memberDialog = await fillNewMember(page, name);
  const envelopes: CommandEnvelope[] = [];

  const loseFirstAcknowledgement = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    if (!isCommand(request, "MemberCreated")) return route.continue();
    envelopes.push(await commandEnvelope(request));
    if (envelopes.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    return route.continue();
  };
  const commands: string[] = [];
  page.on("request", request => {
    if (isCommand(request)) {
      try { commands.push(String(request.postDataJSON().command)); } catch { /* malformed requests are asserted through the response */ }
    }
  });
  await page.route("**/api/operations/commands", loseFirstAcknowledgement);

  await memberDialog.getByTestId("appsheet-save-member").click();
  await expect(memberDialog.getByRole("alert")).toContainText("confirmación del socio quedó pendiente");
  const retry = memberDialog.getByTestId("appsheet-retry-member");
  await expect(retry).toBeEnabled();
  const replayResponse = page.waitForResponse(response => isCommand(response.request(), "MemberCreated"));
  await retry.click();
  const response = await replayResponse;
  const responseText = response.status() === 200 ? "" : await response.text();
  expect(response.status(), responseText).toBe(200);
  const replay = await response.json();
  expect(replay.replay).toBe(true);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[1]).toEqual(envelopes[0]);
  expect(envelopes[0]).toMatchObject({ command: "MemberCreated", expectedVersion: 0, data: {
    name, email: expect.stringMatching(/^qa-.*@example\.test$/), phone: "+5491112345678",
    address: { address: "Domicilio sintético de prueba 44" }, preferences: {},
  } });
  expect(replay.requestId).toBe(envelopes[0]!.requestId);
  expect(replay.targetId).toBe(envelopes[0]!.targetId);
  await page.unroute("**/api/operations/commands", loseFirstAcknowledgement);

  await expect(memberDialog).toHaveCount(0);
  await expect(invoice).toBeVisible();
  await expect(field(invoice, "memberId")).toHaveValue(envelopes[0]!.targetId);
  await expect(field(invoice, "memberId").locator(`option[value="${envelopes[0]!.targetId}"]`)).toHaveText(name);
  await expect(field(invoice, "address")).toHaveValue("Domicilio sintético de prueba 44");
  await expect(field(invoice, "note")).toHaveValue("Borrador sintético que debe volver intacto.");
  await expect(invoice.locator("[data-testid^='appsheet-product-row-']")).toHaveCount(1);
  expect(commands).toEqual(["MemberCreated", "MemberCreated"]);

  const listResponse = await page.request.get(`/api/operations/members?limit=100&q=${encodeURIComponent(name)}`);
  expect(listResponse.status()).toBe(200);
  const listed = await listResponse.json();
  expect(listed.items.some((item: { id: string }) => item.id === envelopes[0]!.targetId)).toBe(true);
});

test("un rechazo de alta no escribe al socio ni pierde la factura; cancelar vuelve al mismo borrador", async ({ page }) => {
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await preserveInvoiceDraft(page, invoice);
  const selectedBefore = await field(invoice, "memberId").inputValue();
  const name = `Socio rechazado sintético ${crypto.randomUUID().slice(0, 8)}`;
  const memberDialog = await fillNewMember(page, name);
  let rejected: CommandEnvelope | null = null;
  const rejectBeforeWrite = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    if (!isCommand(request, "MemberCreated")) return route.continue();
    rejected = await commandEnvelope(request);
    return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "MEMBER_CREATE_REJECTED", message: "El servidor rechazó el alta de prueba." }) });
  };
  const invoiceSaves: string[] = [];
  page.on("request", request => { if (isCommand(request, "InvoiceSaved")) invoiceSaves.push(request.url()); });
  await page.route("**/api/operations/commands", rejectBeforeWrite);

  await memberDialog.getByTestId("appsheet-save-member").click();
  await expect(memberDialog.getByRole("alert")).toHaveText("El servidor rechazó el alta de prueba.");
  await expect(field(memberDialog, "newMember-name")).toHaveValue(name);
  expect(rejected).not.toBeNull();
  const absent = await page.request.get(`/api/operations/members/${encodeURIComponent(rejected!.targetId)}`);
  expect(absent.status()).toBe(404);
  await page.unroute("**/api/operations/commands", rejectBeforeWrite);

  await memberDialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(memberDialog).toHaveCount(0);
  await expect(invoice).toBeVisible();
  await expect(field(invoice, "memberId")).toHaveValue(selectedBefore);
  await expect(field(invoice, "note")).toHaveValue("Borrador sintético que debe volver intacto.");
  await expect(invoice.locator("[data-testid^='appsheet-product-row-']")).toHaveCount(1);
  expect(invoiceSaves).toHaveLength(0);
});

test("si la lectura fresca del socio falla no se inventa una opción y la búsqueda nativa sigue disponible", async ({ page }) => {
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await preserveInvoiceDraft(page, invoice);
  const selectedBefore = await field(invoice, "memberId").inputValue();
  const name = `Socio lectura fallida ${crypto.randomUUID().slice(0, 8)}`;
  const memberDialog = await fillNewMember(page, name);
  let createdTargetId = "";
  const observeCreate = async (route: import("@playwright/test").Route) => {
    if (isCommand(route.request(), "MemberCreated")) createdTargetId = (await commandEnvelope(route.request())).targetId;
    return route.continue();
  };
  const rejectFreshDetailRead = async (route: import("@playwright/test").Route) => {
    const url = new URL(route.request().url());
    if (createdTargetId && route.request().method() === "GET" && url.pathname === `/api/operations/members/${createdTargetId}`) {
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "MEMBER_READ_REJECTED", message: "Lectura de prueba no disponible." }) });
    }
    return route.continue();
  };
  await page.route("**/api/operations/members/**", rejectFreshDetailRead);
  await page.route("**/api/operations/commands", observeCreate);
  const created = page.waitForResponse(response => isCommand(response.request(), "MemberCreated"));
  await memberDialog.getByTestId("appsheet-save-member").click();
  const createResponse = await created;
  expect(createResponse.status()).toBe(200);
  await expect(page.getByTestId("appsheet-member-dialog")).toHaveCount(0);
  await expect(invoice.getByRole("alert")).toContainText("El socio fue guardado, pero no se pudo comprobar su ficha");
  await expect(field(invoice, "memberId")).toHaveValue(selectedBefore);
  await expect(field(invoice, "memberId").locator(`option[value="${createdTargetId}"]`)).toHaveCount(0);

  await invoice.getByRole("searchbox", { name: "Buscar cliente por nombre", exact: true }).fill(name);
  await expect(field(invoice, "memberId").locator(`option[value="${createdTargetId}"]`)).toHaveText(name);
  await field(invoice, "memberId").selectOption(createdTargetId);
  await expect(field(invoice, "memberId")).toHaveValue(createdTargetId);
  await expect(field(invoice, "note")).toHaveValue("Borrador sintético que debe volver intacto.");
  await expect(invoice.locator("[data-testid^='appsheet-product-row-']")).toHaveCount(1);
});

test("sin permiso para crear socios no aparece el alta y la factura conserva su borrador", async ({ page }) => {
  const restrictMemberCreate = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      capabilities: context.capabilities.filter((capability: string) => capability !== "members.write"),
      commands: context.commands.filter((entry: { command: string }) => entry.command !== "MemberCreated"),
    } });
  };
  await page.route("**/api/operations/context", restrictMemberCreate);
  await enterOrders(page);
  const invoice = await openInvoice(page);
  await expect(invoice.getByTestId("appsheet-add-member")).toHaveCount(0);
  await preserveInvoiceDraft(page, invoice);
  await expect(field(invoice, "memberId")).toHaveValue("ops-member");
  await expect(field(invoice, "note")).toHaveValue("Borrador sintético que debe volver intacto.");
  await expect(invoice.locator("[data-testid^='appsheet-product-row-']")).toHaveCount(1);
  const memberWrites = page.getByTestId("appsheet-add-member");
  await expect(memberWrites).toHaveCount(0);
  await invoice.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(invoice).toHaveCount(0);
});
