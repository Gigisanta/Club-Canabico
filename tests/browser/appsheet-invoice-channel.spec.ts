import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolated";

const field = (container: Locator, name: string) => container.locator(`[name="${name}"]`);

function isCatalogChannel(response: import("@playwright/test").Response, channel: "local" | "delivery") {
  if (response.request().method() !== "GET") return false;
  const url = new URL(response.url());
  return url.pathname === "/api/operations/catalog" && url.searchParams.get("channel") === channel;
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

async function expectProductOption(page: Page, label: string) {
  await page.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await expect(field(product, "line-skuId").locator('option[value="ops-sku-c"]')).toHaveText(label);
  await product.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(product).toHaveCount(0);
}

test("an invoice draft follows Moto catalog channels without remounting or losing its line", async ({ page }) => {
  const catalogChannels: Array<"local" | "delivery"> = [];
  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, mode: "active", cutoverProfile: "appsheet-replacement" },
    } });
  });
  await page.route("**/api/operations/catalog**", async route => {
    const url = new URL(route.request().url());
    const channel = url.searchParams.get("channel");
    if (route.request().method() === "GET" && url.pathname === "/api/operations/catalog" && (channel === "local" || channel === "delivery")) {
      catalogChannels.push(channel);
    }

    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const optionLabel = channel === "delivery"
      ? "Variedad C · canal reparto"
      : channel === "local"
        ? "Variedad C · canal retiro"
        : "Variedad C · catálogo base";
    const items = (body.items ?? []).map(item => {
      if (item.id !== "ops-sku-c") return item;
      const appSheet = item.appSheet && typeof item.appSheet === "object" && !Array.isArray(item.appSheet)
        ? item.appSheet as Record<string, unknown>
        : {};
      return { ...item, name: optionLabel, appSheet: { ...appSheet, availability: "Sí" } };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });

  const commandPosts: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/operations/commands") commandPosts.push(request.url());
  });

  await enterOrders(page);
  const localCatalogResponse = page.waitForResponse(response => isCatalogChannel(response, "local"));
  const invoice = await openInvoice(page);
  const localResponse = await localCatalogResponse;
  expect(localResponse.status()).toBe(200);
  expect(new URL(localResponse.url()).searchParams.get("channel")).toBe("local");

  const invoiceElement = await invoice.elementHandle();
  if (!invoiceElement) throw new Error("No se encontró el nodo del formulario de factura.");
  const invoiceNodeIsStillMounted = () => invoiceElement.evaluate(element =>
    element.isConnected && element === document.querySelector('[data-testid="appsheet-invoice-dialog"]'),
  );

  const invoiceDate = "2026-10-09";
  const invoiceNote = "Borrador de prueba: conservar al cambiar el canal.";
  await field(invoice, "invoiceDate").fill(invoiceDate);
  await field(invoice, "note").fill(invoiceNote);

  await invoice.getByTestId("appsheet-add-product").click();
  const product = page.getByTestId("appsheet-product-dialog");
  await expect(product).toBeVisible();
  await field(product, "line-skuId").selectOption("ops-sku-c");
  await field(product, "line-date").fill(invoiceDate);
  await field(product, "line-scale").selectOption("Precio_5_Gramos");
  await field(product, "line-quantity").fill("3");
  await field(product, "line-total").fill("12.01");
  await product.getByRole("button", { name: "Añadir producto", exact: true }).click();
  await expect(product).toHaveCount(0);

  const deliveryCatalogResponse = page.waitForResponse(response => isCatalogChannel(response, "delivery"));
  await invoice.getByRole("radio", { name: "Sí", exact: true }).click();
  const moto = page.getByTestId("appsheet-moto-dialog");
  await expect(moto).toBeVisible();
  await field(moto, "moto-deliveryDate").fill("2026-10-10");
  await field(moto, "moto-paymentMethod").selectOption("cash");
  await field(moto, "moto-serviceType").selectOption("CABA");
  await field(moto, "moto-destination").fill("Destino sintético para el cambio de canal");
  await field(moto, "moto-clientTariff").fill("25.00");
  await field(moto, "moto-adminTariff").fill("17.00");
  await field(moto, "moto-totalTariff").fill("39.00");
  await field(moto, "moto-notes").fill("Viaje sintético del spec de canal.");
  await moto.getByRole("button", { name: "Añadir viaje en moto", exact: true }).click();
  await expect(moto).toHaveCount(0);

  const deliveryResponse = await deliveryCatalogResponse;
  expect(deliveryResponse.status()).toBe(200);
  expect(new URL(deliveryResponse.url()).searchParams.get("channel")).toBe("delivery");
  expect(catalogChannels).toContain("delivery");
  await expect.poll(invoiceNodeIsStillMounted).toBe(true);
  await expect(field(invoice, "invoiceDate")).toHaveValue(invoiceDate);
  await expect(field(invoice, "note")).toHaveValue(invoiceNote);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(1);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toContainText(`${invoiceDate} · Precio_5_Gramos · 3 g`);
  await expectProductOption(page, "Variedad C · canal reparto");

  const localAgainResponse = page.waitForResponse(response => isCatalogChannel(response, "local"));
  await invoice.getByRole("radio", { name: "No", exact: true }).click();
  const localAgain = await localAgainResponse;
  expect(localAgain.status()).toBe(200);
  expect(new URL(localAgain.url()).searchParams.get("channel")).toBe("local");
  expect(catalogChannels).toContain("local");
  await expect.poll(invoiceNodeIsStillMounted).toBe(true);
  await expect(field(invoice, "invoiceDate")).toHaveValue(invoiceDate);
  await expect(field(invoice, "note")).toHaveValue(invoiceNote);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toHaveCount(1);
  await expect(invoice.locator(".appsheet-dialog-lines li")).toContainText(`${invoiceDate} · Precio_5_Gramos · 3 g`);
  await expectProductOption(page, "Variedad C · canal retiro");
  expect(commandPosts).toEqual([]);
});

test("confirmation uses the fresh Moto channel before sending its versioned command", async ({ page }) => {
  const orderId = "channel-race-preorder";
  const lineId = "channel-race-line";
  const skuId = "ops-sku-c";
  const invoiceDate = "2026-10-09";
  const staleQuote = {
    source: "appsheet-invoice",
    invoiceNumber: "F-2026-0042",
    invoiceDate,
    currency: "ARS",
    totalCalculationState: "defined",
    totalMinor: "1201",
    capturedBaseMinor: "1201",
    input: {
      memberId: "ops-member",
      invoiceDate,
      currency: "ARS",
      address: {},
      note: "",
      productPaymentMethod: "cash",
      lines: [{ id: lineId, skuId, date: invoiceDate, scale: "Precio_5_Gramos", quantity: "3", totalMinor: "1201" }],
      preorder: true,
    },
    lines: [{ id: lineId, skuId, date: invoiceDate, scale: "Precio_5_Gramos", requested: "3", explicitTotalMinor: "1201" }],
  };
  const staleOrder = {
    id: orderId,
    memberId: "ops-member",
    memberName: "Socio de ensayo",
    channel: "local",
    currency: "ARS",
    quote: staleQuote,
    quoteVersion: 4,
    subtotalMinor: "1201",
    totalMinor: "1201",
    commercialState: "preorder",
    financialState: "unpaid",
    createdAt: "2026-10-09T12:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
    lines: [{ id: lineId, orderId, skuId, unit: "g", requested: "3", skuName: "Variedad C" }],
  };
  const freshMoto = {
    deliveryDate: "2026-10-10",
    paymentMethod: "cash",
    serviceType: "CABA",
    destination: "Destino sintético de la versión nueva",
    clientTariffMinor: "2500",
    adminTariffMinor: "1700",
    totalTariffMinor: "3900",
    notes: "",
  };
  const freshOrder = {
    ...staleOrder,
    channel: "delivery",
    quote: {
      ...staleQuote,
      input: { ...staleQuote.input, moto: freshMoto },
      moto: freshMoto,
    },
    quoteVersion: 5,
    updatedAt: "2026-10-10T12:00:00.000Z",
  };
  const catalogChannels: Array<"local" | "delivery"> = [];
  let interceptedConfirmation: Record<string, unknown> | null = null;

  await page.route("**/api/operations/context", async route => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const context = await response.json();
    return route.fulfill({ response, json: {
      ...context,
      authority: { ...context.authority, mode: "active", cutoverProfile: "appsheet-replacement" },
    } });
  });
  await page.route("**/api/operations/orders**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/operations/orders") {
      return route.fulfill({ status: 200, json: {
        items: [staleOrder],
        versions: { [orderId]: 4 },
        hasMore: false,
        nextCursor: null,
      } });
    }
    if (route.request().method() === "GET" && url.pathname === `/api/operations/orders/${orderId}`) {
      return route.fulfill({ status: 200, json: {
        order: freshOrder,
        reservations: [],
        allocations: [],
        deliveries: [],
        version: 5,
      } });
    }
    return route.continue();
  });
  await page.route("**/api/operations/catalog**", async route => {
    const url = new URL(route.request().url());
    const channel = url.searchParams.get("channel");
    if (route.request().method() === "GET" && url.pathname === "/api/operations/catalog" && (channel === "local" || channel === "delivery")) {
      catalogChannels.push(channel);
    }
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = (body.items ?? []).map(item => {
      if (item.id !== skuId) return item;
      const appSheet = item.appSheet && typeof item.appSheet === "object" && !Array.isArray(item.appSheet)
        ? item.appSheet as Record<string, unknown>
        : {};
      return { ...item, appSheet: { ...appSheet, availability: "Sí" } };
    });
    return route.fulfill({ response, json: { ...body, items } });
  });
  await page.route("**/api/operations/commands", async route => {
    try {
      const envelope = route.request().postDataJSON() as Record<string, unknown>;
      if (envelope.command === "InvoiceConfirmed") {
        interceptedConfirmation = envelope;
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Rechazo sintético: la prueba conserva la preventa." }),
        });
      }
    } catch {
      // Other routes continue unchanged when their body is not a command envelope.
    }
    return route.continue();
  });

  await enterOrders(page);
  const localCatalogResponse = page.waitForResponse(response => isCatalogChannel(response, "local"));
  const freshOrderResponse = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === `/api/operations/orders/${orderId}`,
  );
  const deliveryCatalogResponse = page.waitForResponse(response => isCatalogChannel(response, "delivery"));
  const preorderRow = page.locator("tbody tr").first();
  await expect(preorderRow).toHaveCount(1);
  const actionDisclosure = preorderRow.locator("details summary");
  if (await actionDisclosure.count()) await actionDisclosure.click();
  await preorderRow.getByRole("button", { name: "Confirmar preventa", exact: true }).click();
  const confirmationDialog = page.getByTestId("appsheet-invoice-dialog");
  await expect(confirmationDialog).toBeVisible();

  const [localResponse, freshResponse] = await Promise.all([localCatalogResponse, freshOrderResponse]);
  expect(localResponse.status()).toBe(200);
  expect(new URL(localResponse.url()).searchParams.get("channel")).toBe("local");
  expect(freshResponse.status()).toBe(200);
  expect(await freshResponse.json()).toMatchObject({
    order: { id: orderId, channel: "delivery", quote: { input: { moto: freshMoto } } },
    version: 5,
  });

  const deliveryResponse = await deliveryCatalogResponse;
  expect(deliveryResponse.status()).toBe(200);
  expect(new URL(deliveryResponse.url()).searchParams.get("channel")).toBe("delivery");
  expect(catalogChannels).toContain("delivery");
  await expect(confirmationDialog.getByTestId("appsheet-confirm-preorder")).toBeEnabled();

  const confirmResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/operations/commands" &&
      response.request().postDataJSON().command === "InvoiceConfirmed",
  );
  await confirmationDialog.getByTestId("appsheet-confirm-preorder").click();
  const rejected = await confirmResponse;
  expect(rejected.status()).toBe(422);
  expect(interceptedConfirmation).toMatchObject({
    command: "InvoiceConfirmed",
    targetId: orderId,
    expectedVersion: 5,
    data: { acceptance: { method: "operator_confirmed_saved_preorder" } },
  });
  await expect(confirmationDialog.getByRole("alert")).toContainText("Rechazo sintético");
});
