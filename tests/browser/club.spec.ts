import { test, expect } from "@playwright/test";
test("purchase history helps service without extra entry", async ({ page }) => {
  await page.goto("/socios");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await page.getByRole("button", { name: "Ver ficha" }).first().click();
  const profile = page.getByRole("dialog", { name: "Ficha del socio" });
  const profileInsight = profile.getByRole("region", { name: "Lectura automática del socio" });
  await expect(profileInsight).toContainText("Ticket promedio");
  await expect(profileInsight).toContainText("Más elegido");
  await expect(profileInsight).toContainText("Ritmo reciente");
  await profile.getByRole("button", { name: "Cerrar" }).click();
  await page.goto("/ventas");
  await page.getByRole("button", { name: "Nueva venta" }).click();
  const checkout = page.getByRole("dialog", { name: "Nueva venta" });
  await checkout.getByRole("combobox", { name: "Buscar socio" }).focus();
  await checkout.getByRole("listbox", { name: "Socios encontrados" }).getByRole("option").first().waitFor();
  await checkout.getByRole("combobox", { name: "Buscar socio" }).press("ArrowDown");
  await checkout.getByRole("combobox", { name: "Buscar socio" }).press("Enter");
  await expect(checkout.getByRole("button", { name: "Cambiar socio" })).toBeVisible();
  await expect(checkout.getByRole("region", { name: "Lectura automática del socio" })).toContainText("Última compra");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("dashboard separates actuals, projections and recommended actions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Estado del período" })).toBeVisible();
  const outlook = page.getByRole("region", { name: "Lo que sugiere el ritmo reciente" });
  await expect(outlook).toContainText("Ventas estimadas · próximos 7 días");
  await expect(outlook).toContainText("Compradores estimados · próximos 30 días");
  await expect(outlook).toContainText("No incluyen estacionalidad ni equivalen a caja proyectada");
  await expect(page.getByRole("region", { name: "Qué revisar esta semana" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cómo compran los socios" })).toBeVisible();
  await page.getByRole("combobox", { name: "Período del dashboard" }).selectOption("week");
  await expect(page.locator(".metrics-grid")).toContainText("Ventas del período");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(outlook).toBeVisible();
  expect(errors).toEqual([]);
});
test("saved products and profiles help classify new stock", async ({ page }) => {
  await page.goto("/inventario");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[name="ownerId"]')).toHaveCount(0);
  await expect(dialog).not.toContainText(/reprogram/i);
  await dialog.getByRole("button", { name: "Ver todos los productos guardados" }).click();
  await expect(dialog.getByRole("listbox", { name: "Productos guardados" })).toBeVisible();
  await expect(dialog.getByRole("listbox", { name: "Productos guardados" }).getByRole("option").first()).toBeVisible();
  await dialog.getByLabel("Nombre del producto").fill("Lemon");
  await dialog.getByRole("listbox", { name: "Productos guardados" }).getByRole("option", { name: /Lemon Haze.*Flor.*Sativa/ }).click();
  await expect(dialog.getByLabel("Nombre del producto")).toHaveValue("Lemon Haze");
  await expect(dialog.getByLabel("Perfil (opcional)")).toHaveValue("Sativa");
  await dialog.getByLabel("Nombre del producto").fill("Lemon");
  await expect(dialog.getByRole("listbox", { name: "Productos guardados" }).getByRole("option", { name: /Lemon Haze/ })).toBeVisible();
  await dialog.getByLabel("Nombre del producto").press("ArrowDown");
  await dialog.getByLabel("Nombre del producto").press("Enter");
  await expect(dialog.getByLabel("Nombre del producto")).toHaveValue("Lemon Haze");
  await dialog.getByLabel("Nombre del producto").fill("Aceite CBD nuevo");
  await expect(dialog.getByText("Sin coincidencias. Podés guardar este nombre nuevo.")).toBeVisible();
  await expect(dialog.getByLabel("Perfil (opcional)")).toHaveValue("CBD");
  await expect(dialog.getByLabel("Tipo", { exact: true })).toHaveValue("Aceite");
  await expect(dialog.getByLabel("Unidad")).toHaveValue("ud");
  const costInput = dialog.getByLabel("Precio de costo");
  const priceInput = dialog.getByLabel("Precio de venta");
  await expect(costInput).toHaveValue("");
  await expect(priceInput).toHaveValue("");
  await costInput.fill("4000");
  await priceInput.fill("40000");
  await expect(dialog.getByText(/Vas a guardar.*4\.000,00/)).toBeVisible();
  await expect(dialog.getByText(/Vas a guardar.*40\.000,00/)).toBeVisible();
  await expect(dialog.getByText(/supera diez veces el costo/)).toBeVisible();
  await priceInput.fill("3500");
  await expect(dialog.getByText(/por debajo del costo/)).toBeVisible();
  await priceInput.fill("5000");
  await expect(dialog.getByText(/por debajo del costo/)).toHaveCount(0);
  await priceInput.fill("1e6");
  await expect(priceInput).toHaveValue("5000");
  await costInput.fill("");
  await expect(costInput).toHaveValue("");
  await costInput.fill("4000");
  const desktopCost = await costInput.boundingBox();
  const desktopPrice = await priceInput.boundingBox();
  expect(desktopCost && desktopPrice && Math.abs(desktopCost.y - desktopPrice.y) < 3 && desktopPrice.x > desktopCost.x).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByLabel("Nombre del producto")).toBeVisible();
  const mobileCost = await costInput.boundingBox();
  const mobilePrice = await priceInput.boundingBox();
  expect(mobileCost && mobilePrice && Math.abs(mobileCost.y - mobilePrice.y) < 3 && mobilePrice.x > mobileCost.x).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await page.getByRole("button", { name: "Ver detalle de Lemon Haze" }).click();
  await page.getByRole("button", { name: "Editar Lemon Haze" }).click();
  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByLabel("Precio de costo")).not.toHaveValue("");
  await expect(editDialog.getByLabel("Precio de venta")).not.toHaveValue("");
  await expect(editDialog.getByText(/Valores anteriores: costo/)).toBeVisible();
  await editDialog.getByRole("button", { name: "Cerrar" }).click();
});
test("product picker can browse beyond the first catalog page", async ({ page }) => {
  await page.goto("/inventario");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await page.route("**/api/product-catalog?all=1*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor") || "";
    const products = (cursor ? [40, 41] : Array.from({ length: 40 }, (_, index) => index))
      .map((index) => ({ name: `Producto ${String(index).padStart(2, "0")}`, strain: "", type: "Flor", unit: "g" }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      products, profiles: [], nextCursor: cursor ? null : "Producto 39", cursor,
    }) });
  });
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo stock" });
  await dialog.getByRole("button", { name: "Ver todos los productos guardados" }).click();
  await expect(dialog.getByRole("listbox", { name: "Productos guardados" }).getByRole("option")).toHaveCount(40);
  await dialog.getByRole("button", { name: "Mostrar más productos" }).click();
  await expect(dialog.getByRole("listbox", { name: "Productos guardados" }).getByRole("option")).toHaveCount(42);
  await dialog.getByRole("option", { name: "Producto 41 Flor" }).click();
  await expect(dialog.getByRole("combobox", { name: "Nombre del producto" })).toHaveValue("Producto 41");
});
test("new stock assigns the signed-in owner without an extra field", async ({ page }) => {
  await page.goto("/inventario");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/products", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  });
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[name="ownerId"]')).toHaveCount(0);
  await dialog.getByLabel("Nombre del producto").fill("Lote de prueba sin guardar");
  await dialog.getByLabel("Código de lote").fill("QA-SIN-GUARDAR");
  await dialog.getByLabel("Ubicación").selectOption({ index: 1 });
  await dialog.getByLabel("Precio de costo").fill("100");
  await dialog.getByLabel("Precio de venta").fill("200");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(payload).toMatchObject({ ownerId: "owner", name: "Lote de prueba sin guardar" });
});
test("owner saves a default supplier and selects it for a new lot", async ({ page }) => {
  const suffix = Date.now().toString().slice(-8);
  const supplier = `Proveedor QA ${suffix}`;
  const lot = `Lote proveedor QA ${suffix}`;
  await page.goto("/inventario");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await page.getByRole("heading", { name: "Inventario", exact: true }).waitFor();
  await page.getByRole("button", { name: "Proveedores" }).click();
  await page.getByRole("button", { name: "Nuevo proveedor" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre del proveedor").fill(supplier);
  await dialog.getByLabel("Persona de contacto").fill("Contacto de prueba");
  await dialog.getByLabel("Seleccionar por defecto en lotes nuevos").check();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".supplier-card").filter({ hasText: supplier })).toContainText("Predeterminado");
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Proveedor", { exact: true }).locator("option:checked")).toHaveText(supplier);
  await dialog.getByLabel("Nombre del producto").fill(lot);
  await dialog.getByLabel("Perfil (opcional)").fill("Prueba");
  await dialog.getByLabel("Código de lote").fill(`QA-SUP-${suffix}`);
  await dialog.getByRole("button", { name: "Agregar ubicación" }).click();
  await dialog.getByLabel("Nombre de la nueva ubicación").fill(`Depósito QA ${suffix}`);
  await dialog.locator(".location-quick-add .button").filter({ hasText: "Guardar" }).click();
  await expect(dialog.getByLabel("Ubicación")).toHaveValue(/.+/);
  await expect(dialog.getByLabel("Ubicación").locator("option:checked")).toHaveText(`Depósito QA ${suffix}`);
  await dialog.getByLabel("Stock inicial").fill("20");
  await dialog.getByLabel("Precio de costo").fill("100");
  await dialog.getByLabel("Precio de venta").fill("200");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".supplier-card").filter({ hasText: supplier })).toContainText("1 lote vinculado");
  await page.getByRole("button", { name: "Ubicaciones" }).click();
  const savedLocation = page.locator(".supplier-card").filter({ hasText: `Depósito QA ${suffix}` });
  await expect(savedLocation).toContainText("1 lote vinculado");
  await savedLocation.getByRole("button", { name: "Editar" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre de la ubicación").fill(`Depósito Principal QA ${suffix}`);
  await dialog.getByLabel("Seleccionar por defecto al crear stock").check();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(savedLocation).toBeHidden();
  await expect(page.locator(".supplier-card").filter({ hasText: `Depósito Principal QA ${suffix}` })).toContainText("Predeterminada");
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Ubicación").locator("option:checked")).toHaveText(`Depósito Principal QA ${suffix}`);
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await page.getByRole("combobox", { name: "Filtrar por proveedor" }).selectOption({ label: supplier });
  await expect(page.locator(".stock-card")).toContainText(lot);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".supplier-card").filter({ hasText: supplier })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
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
    page.getByRole("heading", { name: "Hola, Tiziano." }),
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
  await page.getByRole("button", { name: "Nuevo stock" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre del producto").fill(product);
  await dialog.getByLabel("Perfil (opcional)").fill("Prueba");
  await dialog.getByLabel("Código de lote").fill(`QA-${suffix}`);
  await dialog.getByLabel("Ubicación").selectOption({ index: 1 });
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
  await dialog.getByRole("combobox", { name: "Buscar socio" }).fill(customer);
  await dialog.getByRole("option", { name: new RegExp(customer) }).click();
  const option = dialog
    .getByLabel("Producto / lote")
    .locator("option")
    .filter({ hasText: product });
  await dialog
    .getByLabel("Producto / lote")
    .selectOption((await option.getAttribute("value")) || "");
  await dialog.getByLabel("Cantidad línea 1").fill("2");
  await dialog.getByRole("button", { name: "Sumar 1 g en línea 1" }).click();
  await expect(dialog.getByLabel("Cantidad línea 1")).toHaveValue("3");
  await dialog.getByRole("button", { name: "Restar 1 g en línea 1" }).click();
  await expect(dialog.locator(".total")).toContainText("20.000,00");
  await dialog.getByRole("button", { name: "Confirmar venta" }).click();
  await expect(
    page.getByRole("heading", { name: "Comprobante de venta" }),
  ).toBeVisible();
  await expect(page.locator(".ticket-total")).toContainText("20.000,00");
  await expect(page.locator(".print-ticket")).toContainText("2 g ×");
  await expect(page.locator(".print-ticket")).toContainText("no constituye una factura fiscal");
  await expect(page.locator(".print-ticket")).toContainText("Fecha y hora");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-ticket")).toBeVisible();
  await expect(page.locator(".ticket-print")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByPlaceholder("Buscar socio, producto o ticket…").fill(product);
  await expect(page.getByRole("row", { name: new RegExp(product) })).toBeVisible();
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
  const customerRow = page.getByRole("row", { name: new RegExp(customer) });
  await expect(customerRow).toBeVisible();
  await customerRow.getByRole("button", { name: "Ver ficha" }).click();
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
      `name,email,phone,notes,sourceSystem,sourceId\nSocio Importado,importado@example.com,,Prueba,appsheet,browser-${suffix}`,
    ),
  });
  await page.getByRole("button", { name: "Validar archivo" }).click();
  await expect(page.getByText("1 registros válidos")).toBeVisible();
  for (const [label, heading] of [
    ["Gastos", "Gastos registrados"],
    ["Caja y planificación", "Caja y planificación"],
    ["Responsables", "Responsables"],
    ["Reportes", "Reportes y liquidaciones"],
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    if (label === "Gastos") await expect(page.getByRole("heading", { name: "Registro de gastos" })).toBeVisible();
    if (label === "Caja y planificación") {
      await expect(page.getByRole("heading", { name: "Capital en inventario" })).toBeVisible();
      await page.getByRole("button", { name: "Movimientos reales" }).click();
      await expect(page.getByRole("heading", { name: "Movimientos reales" })).toBeVisible();
      await expect(page.locator(".finance-section tbody tr").first()).toBeVisible();
    }
  }
  await page.getByRole("link", { name: "Caja y planificación" }).click();
  await page.getByRole("button", { name: "Agregar proyección" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Fecha").fill("2027-01-10");
  await dialog.getByLabel("Categoría").selectOption("operating_expense");
  await dialog.getByLabel("Importe en ARS (negativo si sale dinero)").fill("-123.45");
  await dialog.getByLabel("Detalle / comprobante de referencia").fill(`Personal QA ${suffix}`);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Proyección", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(`Personal QA ${suffix}`) })).toContainText("123,45");
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
  await page.getByRole("button", { name: "Lucía · sus lotes y ventas" }).click();
  await expect(
    page.getByRole("heading", { name: "Hola, Lucía." }),
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
    page.getByRole("heading", { name: "Hola, Tiziano." }),
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
  await page.getByRole("button", { name: "Abrir navegación" }).click();
  await page.getByRole("button", { name: /3 lotes necesitan atención/ }).click();
  await expect(page.locator(".stock-card")).toHaveCount(3);
});
