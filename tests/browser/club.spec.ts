import { test, expect } from "@playwright/test";
test("owner: create lot and customer, sell, verify persistence, and preview CSV", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explorar club de demostración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Todo en orden, Tomás." }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Período del dashboard" })
    .selectOption("today");
  await expect(page.locator(".metrics-grid")).toContainText(
    "Ventas del período",
  );
  await page.getByRole("link", { name: /Inventario/ }).click();
  await expect(
    page.getByRole("heading", { name: "Inventario", exact: true }),
  ).toBeVisible();
  const suffix = Date.now().toString().slice(-7);
  await page
    .getByRole("button", { name: "Ver detalle de Amnesia Haze" })
    .click();
  await expect(
    page.getByRole("button", { name: "Ocultar detalle de Amnesia Haze" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "Ocultar detalle de Amnesia Haze" }),
  ).toContainText("Valor del lote al costo");
  await page.getByRole("button", { name: "Mover Amnesia Haze" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Estado del stock" })
    .selectOption("low");
  await expect(page.locator(".stock-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Vista de tabla" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page
    .getByRole("combobox", { name: "Estado del stock" })
    .selectOption("all");
  await page.getByRole("button", { name: "Vista de tarjetas" }).click();
  const product = `QA Lote ${suffix}`;
  const customer = `QA Socio ${suffix}`;
  await page.getByRole("button", { name: "Nuevo lote" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre del producto").fill(product);
  await dialog.getByLabel("Cepa / strain").fill("Prueba");
  await dialog.getByLabel("Código de lote").fill(`QA-${suffix}`);
  await dialog.getByLabel("Ubicación").fill("Depósito de prueba");
  await dialog.getByLabel("Responsable de reprogram").selectOption("r1");
  await dialog.getByLabel("Stock inicial").fill("10");
  await dialog.getByLabel("Stock mínimo").fill("2");
  await dialog.getByLabel("Precio de costo").fill("4000");
  await dialog.getByLabel("Precio de venta").fill("10000");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(product, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Socios y fidelización" }).click();
  await page.getByRole("button", { name: "Nuevo socio" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre completo").fill(customer);
  await dialog
    .getByLabel("Correo electrónico")
    .fill(`qa-${suffix}@example.com`);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("link", { name: "Ventas y caja" }).click();
  await page.getByRole("button", { name: "Nueva venta" }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Socio", { exact: true })
    .selectOption({ label: `${customer} · Bronce` });
  const option = dialog
    .getByLabel("Producto / lote")
    .locator("option")
    .filter({ hasText: product });
  await dialog
    .getByLabel("Producto / lote")
    .selectOption((await option.getAttribute("value")) || "");
  await dialog.getByLabel("Cantidad línea 1").fill("2");
  await expect(dialog.locator(".total")).toContainText("20.000,00");
  await dialog.getByRole("button", { name: "Confirmar venta" }).click();
  await expect(
    page.getByRole("heading", { name: "Comprobante de venta" }),
  ).toBeVisible();
  await expect(page.locator(".ticket-total")).toContainText("20.000,00");
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByRole("link", { name: /Inventario/ }).click();
  await page
    .getByPlaceholder("Buscar producto, lote o responsable…")
    .fill(product);
  await expect(page.locator(".stock-card")).toHaveCount(1);
  await expect(page.locator(".stock-card")).toContainText("8");
  await page.reload();
  await expect(page.getByText(product, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Socios y fidelización" }).click();
  await page.getByPlaceholder("Buscar por nombre o email…").fill(customer);
  await page.getByRole("button", { name: "Ver ficha" }).click();
  await expect(page.locator(".detail-stats")).toContainText("20.000,00");
  await expect(page.locator(".detail-stats")).toContainText("2");
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByRole("link", { name: "Configuración", exact: true }).click();
  await page.getByRole("button", { name: "Importar desde Sheets" }).click();
  await page.getByLabel("Datos a importar").selectOption("customers");
  await page.locator("input[type=file]").setInputFiles({
    name: "socios.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,email,phone,notes\nSocio Importado,importado@example.com,,Prueba",
    ),
  });
  await page.getByRole("button", { name: "Validar archivo" }).click();
  await expect(page.getByText("1 registros válidos")).toBeVisible();
  for (const [label, heading] of [
    ["Gastos", "Gastos y flujo de caja"],
    ["Responsables", "Responsables de reprogram"],
    ["Reportes", "Reportes y liquidaciones"],
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("responsible: scope cannot be switched; foreign lots and settings actions absent", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explorar club de demostración" })
    .click();
  await page.getByRole("button", { name: "Probar otro rol" }).click();
  await page.getByRole("button", { name: "Lucía · solo su reprogram" }).click();
  await expect(
    page.getByRole("heading", { name: "Todo en orden, Lucía." }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Filtrar por responsable" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: /Inventario/ }).click();
  await expect(page.locator(".stock-grid")).not.toContainText("Gorilla Glue");
  await expect(page.locator(".stock-grid")).toContainText("Amnesia Haze");
  await page.getByRole("button", { name: "Movimientos", exact: true }).click();
  await expect(page.getByText(/movimientos · Página 1/)).toBeVisible();
  await page.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(page.getByText(/movimientos · Página 2/)).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByRole("link", { name: "Configuración", exact: true }).click();
  await expect(page.getByLabel("Nombre del club")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Guardar", exact: true }),
  ).toBeHidden();
});
test("mobile: navigation, filters and sale modal fit the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explorar club de demostración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Todo en orden, Tomás." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Nueva venta" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Abrir navegación" }).click();
  await page.getByRole("link", { name: /Inventario/ }).click();
  await expect(
    page.getByRole("heading", { name: "Inventario", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
