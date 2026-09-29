import { expect, test } from "./isolated";

test("primary areas stay direct and secondary tools remain reachable", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Resumen de hoy" })).toBeVisible();
  const sidebar = page.locator("#app-navigation");
  await expect(sidebar.locator(".hub-group")).toHaveCount(5);
  await expect(sidebar.getByRole("link", { name: "Finanzas", exact: true })).toBeVisible();
  await expect(sidebar.locator(".hub-items-context")).toHaveCount(1);
  const more = sidebar.getByRole("button", { name: "Más herramientas" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("link", { name: "Importar y conciliar" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await sidebar.getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inventario", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Análisis de stock" })).toBeVisible();
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

test("five roles see only their allowed areas and mobile More exposes tools", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  const roles = [
    { name: "Dueño · vista consolidada", hubs: 5, web: true, expenses: true },
    { name: "Gerente · operación del club", hubs: 5, web: true, expenses: true },
    { name: "Lucía · sus lotes y ventas", hubs: 4, web: false, expenses: true },
    { name: "Cajero · ventas y stock", hubs: 4, web: false, expenses: false },
    { name: "Solo lectura", hubs: 4, web: false, expenses: true },
  ];
  for (const [index, role] of roles.entries()) {
    if (index > 0) {
      await page.getByRole("button", { name: "Probar otro rol" }).click();
      await page.getByRole("dialog").getByRole("button", { name: role.name }).click();
    }
    const tabs = page.locator(".mobile-tabbar");
    for (const label of ["Inicio", "Ventas", "Stock", role.web ? "Finanzas" : "Socios"])
      await expect(tabs.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
    await expect(tabs.getByRole("link", { name: role.web ? "Socios" : "Finanzas", exact: true })).toHaveCount(0);
    await tabs.getByRole("button", { name: "Más secciones" }).click();
    const sidebar = page.locator("#app-navigation");
    await expect(sidebar.locator(".hub-group")).toHaveCount(role.hubs);
    await expect(sidebar.getByRole("link", { name: "Socios", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Finanzas", exact: true })).toHaveCount(role.web ? 1 : 0);
    await sidebar.getByRole("button", { name: "Más herramientas" }).click();
    await expect(sidebar.locator('.hub-tools-list a[href="/app/consultas"]')).toHaveCount(role.web ? 1 : 0);
    await sidebar.getByRole("button", { name: "Cerrar navegación" }).click();
    await page.goto("/app/gastos");
    await expect(page).toHaveURL(role.expenses ? /\/app\/gastos$/ : /\/app\/?$/);
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
