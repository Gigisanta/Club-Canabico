import { expect, test } from "./isolated";

test("six hubs lead to their pages and search understands former labels", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Resumen de hoy" })).toBeVisible();
  const sidebar = page.locator("#app-navigation");
  await expect(sidebar.locator(".hub-group")).toHaveCount(6);
  await expect(sidebar.locator('.hub-toggle[aria-expanded="true"]')).toHaveCount(1);
  const stockToggle = sidebar.locator('.hub-toggle[aria-controls="hub-items-stock"]');
  await stockToggle.focus();
  await page.keyboard.press("Enter");
  await expect(stockToggle).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("region", { name: "Opciones de Stock" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(stockToggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(stockToggle).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.locator('.hub-toggle[aria-expanded="true"]')).toHaveCount(1);
  await sidebar.getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inventario", exact: true })).toBeVisible();
  await expect(page.locator(".breadcrumb")).toContainText("Stock");
  await expect(page.locator(".breadcrumb")).toContainText("Inventario");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Buscar socio, producto o sección…").fill("fidelización");
  await page.getByRole("button", { name: /Directorio/ }).click();
  await expect(page).toHaveURL(/\/app\/socios$/);
  await expect(page.getByRole("heading", { name: "Directorio de socios" })).toBeVisible();
  await page.goto("/app/configuracion?tab=public");
  await expect(page.getByRole("heading", { name: "Canales del club" })).toBeVisible();
  await expect(page.locator(".breadcrumb")).toContainText("Web pública");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Canales del club" })).toBeVisible();
});

test("five roles see only their allowed hubs and mobile More exposes the same destinations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  const roles = [
    { name: "Dueño · vista consolidada", hubs: 6, web: true, expenses: true },
    { name: "Gerente · operación del club", hubs: 6, web: true, expenses: true },
    { name: "Lucía · sus lotes y ventas", hubs: 5, web: false, expenses: true },
    { name: "Cajero · ventas y stock", hubs: 5, web: false, expenses: false },
    { name: "Solo lectura", hubs: 5, web: false, expenses: true },
  ];
  for (const [index, role] of roles.entries()) {
    if (index > 0) {
      await page.getByRole("button", { name: "Probar otro rol" }).click();
      await page.getByRole("dialog").getByRole("button", { name: role.name }).click();
    }
    const tabs = page.locator(".mobile-tabbar");
    for (const label of ["Inicio", "Ventas", "Stock", "Socios"])
      await expect(tabs.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
    await tabs.getByRole("button", { name: "Más secciones" }).click();
    const sidebar = page.locator("#app-navigation");
    await expect(sidebar.locator(".hub-group")).toHaveCount(role.hubs);
    await expect(sidebar.locator('.hub-items a[href="/app/consultas"]')).toHaveCount(role.web ? 1 : 0);
    await expect(sidebar.locator('.hub-items a[href="/app/gastos"]')).toHaveCount(role.expenses ? 1 : 0);
    await sidebar.getByRole("button", { name: "Cerrar navegación" }).click();
    await page.goto("/app/vidriera");
    await expect(page).toHaveURL(role.web ? /\/app\/vidriera$/ : /\/app\/?$/);
    await page.goto("/app");
  }
});

test("sales and member lists stay short on mobile while later pages remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/ventas");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".sales-history-table tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(page.getByText(/Página 2 ·/)).toBeVisible();
  await page.goto("/app/socios");
  await expect(page.locator(".customers-table tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(page.getByText(/Página 2 ·/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
