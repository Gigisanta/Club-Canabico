import { test, expect } from "./isolated";

test.use({ actionTimeout: 10000 });

async function enterDemo(page: import("@playwright/test").Page, destination = "/app/operations") {
  await page.goto(destination);
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
}

test("members search and cursor pagination expose records beyond the first 200", async ({ page }) => {
  const urls: string[] = [];
  await enterDemo(page);
  await page.route("**/api/operations/members**", async route => {
    const url = new URL(route.request().url());
    urls.push(url.pathname + url.search);
    const q = url.searchParams.get("q");
    const cursor = url.searchParams.get("cursor");
    const body = q
      ? { items: [{ id: "member-search", name: "Resultado buscado" }], hasMore: false, nextCursor: null }
      : cursor
        ? { items: [{ id: "member-201", name: "Socio 201" }], hasMore: false, nextCursor: null }
        : { items: Array.from({ length: 200 }, (_, index) => ({ id: `member-${index + 1}`, name: `Socio ${index + 1}` })), hasMore: true, nextCursor: "cursor-200" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.getByRole("button", { name: "Socios", exact: true }).click();
  await expect(page.getByText("Socio 200", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cargar más socios" }).click();
  await expect(page.getByText("Socio 201", { exact: true })).toBeVisible();
  await expect.poll(() => urls.some(value => value.includes("cursor=cursor-200"))).toBe(true);

  const search = page.getByRole("searchbox", { name: "Buscar socio" });
  await search.fill("objetivo");
  await expect(page.getByText("Resultado buscado", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.getByText("Socio 201", { exact: true })).toHaveCount(0);
  await expect.poll(() => urls.some(value => value.includes("q=objetivo"))).toBe(true);
});

test("an analysis refresh failure removes the previously rendered snapshot", async ({ page }) => {
  await enterDemo(page, "/app");
  await page.goto("/app/decisiones/stock");
  await expect(page.getByRole("heading", { name: "Análisis de stock" })).toBeVisible();
  await expect(page.locator(".da-header-meta")).toContainText("Actualizado al");

  await page.route("**/api/decision-analysis", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Fallo sintético de actualización" }),
  }));
  await page.getByRole("button", { name: "Actualizar análisis" }).click();
  await expect(page.getByRole("alert")).toContainText("Fallo sintético de actualización");
  await expect(page.locator(".da-header-meta")).not.toContainText("Actualizado al");
  await expect(page.locator(".da-evidence")).toHaveCount(0);
});

test("quote form serializes independent payment methods and displays a rejected command", async ({ page }) => {
  await enterDemo(page);
  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: "ops-local-draft" });
  await row.getByRole("button", { name: "Cotizar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Medio de pago( general)?$/).selectOption("cash");
  await dialog.getByLabel("Medio de pago de productos (opcional)").selectOption("transfer");
  await dialog.getByLabel("Medio de pago de entrega (opcional)").selectOption("card");
  await dialog.getByLabel("Producto", { exact: true }).selectOption("ops-sku-b");
  await dialog.getByLabel("Cantidad solicitada").fill("5");
  await dialog.getByLabel("Tarifa y escala aprobadas").selectOption({ label: "Tarifa de ensayo · escala-5 · desde 5 · 5500 ARS" });

  let payload: Record<string, unknown> | undefined;
  await page.route("**/api/operations/commands", async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Rechazo sintético para comprobar la respuesta sin escritura" }) });
  });
  await dialog.getByRole("button", { name: "Revisar y registrar" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Rechazo sintético");
  expect(payload?.data).toMatchObject({ paymentMethod: "cash", productPaymentMethod: "transfer", deliveryPaymentMethod: "card" });
});
