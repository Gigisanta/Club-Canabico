import { test, expect } from "./isolated";

// Real rendered UI and requests, using only the isolated runner's synthetic club.
test("operations desktop and mobile show business tasks, exact account currencies and coverage", async ({ page }, testInfo) => {
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("response",response=>{if(response.url().includes("/api/")&&response.status()>=500)errors.push(`${response.status()} ${new URL(response.url()).pathname}`);});
  await page.goto("/app/operations");
  await page.getByRole("button",{name:"Explorar club de demostración"}).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
  await expect(page.locator(".ops-home-page")).toContainText("Contribución");
  await expect(page.locator(".ops-topbar")).toContainText("Ensayo");
  await expect(page.locator(".ops-home-page .ops-spinner")).toHaveCount(0);
  const session = await page.request.get("/api/auth/me");
  expect(session.ok()).toBe(true);
  const { user } = await session.json();
  await expect(page.locator(".ops-profile-line strong")).toHaveText(user.name);
  await page.screenshot({path:testInfo.outputPath("operations-desktop.png"),fullPage:true});
  await page.getByRole("button",{name:"Cuentas y saldos",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Cuentas y saldos",exact:true})).toBeVisible();
  await expect(page.locator(".ops-content")).toContainText("ARS");
  await expect(page.locator(".ops-content")).toContainText("USD");
  await page.screenshot({path:testInfo.outputPath("operations-accounts.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const menu = page.getByRole("button",{name:"Abrir menú",exact:true});
  const navigation = page.locator(".ops-sidebar");
  await expect(page.getByRole("button",{name:"Pedidos",exact:true})).toHaveCount(0);
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  const currentSection = navigation.getByRole("button",{name:"Cuentas y saldos",exact:true});
  await expect(currentSection).toBeFocused();
  await currentSection.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await menu.click();
  const closeMenu = navigation.getByRole("button",{name:"Cerrar menú",exact:true});
  const exit = navigation.getByRole("button",{name:/Cerrar sesión|Volver al panel/});
  await exit.press("Tab");
  await expect(closeMenu).toBeFocused();
  await closeMenu.press("Shift+Tab");
  await expect(exit).toBeFocused();
  await page.getByRole("button",{name:"Pedidos",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Pedidos",exact:true})).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect.poll(async () => { const box = await page.locator(".ops-sidebar").boundingBox(); return box !== null && box.x + box.width <= 0; }).toBe(true);
  await page.screenshot({path:testInfo.outputPath("operations-mobile.png"),fullPage:true,animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("operations section URL follows browser history and survives reload", async ({ page }) => {
  await page.goto("/app/operations?section=orders");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();

  const currentSection = page.locator(".ops-nav-item[aria-current='page']");
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
  await expect(currentSection).toHaveText("Pedidos");
  await expect(page).toHaveTitle("Pedidos · Bombo");
  expect(new URL(page.url()).searchParams.get("section")).toBe("orders");

  const orderRow = page.locator("tbody tr").filter({ hasText: "ops-local-draft" });
  await expect(orderRow).toBeVisible();
  const filter = page.getByRole("searchbox", { name: "Buscar en columnas visibles", exact: true });
  await filter.fill("no-such-order-9e7d");
  await expect(page.getByRole("heading", { name: "No hay coincidencias", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q-orders")).toBe("no-such-order-9e7d");
  await page.getByRole("button", { name: "Borrar búsqueda", exact: true }).click();
  await expect(orderRow).toBeVisible();
  expect(new URL(page.url()).searchParams.has("q-orders")).toBe(false);

  await page.getByRole("button", { name: "Cuentas y saldos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cuentas y saldos", exact: true })).toBeVisible();
  await expect(currentSection).toHaveText("Cuentas y saldos");
  await expect(page).toHaveTitle("Cuentas y saldos · Bombo");
  expect(new URL(page.url()).searchParams.get("section")).toBe("accounts");

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
  await expect(currentSection).toHaveText("Pedidos");
  expect(new URL(page.url()).searchParams.get("section")).toBe("orders");

  await page.goForward();
  await expect(page.getByRole("heading", { name: "Cuentas y saldos", exact: true })).toBeVisible();
  await expect(currentSection).toHaveText("Cuentas y saldos");
  expect(new URL(page.url()).searchParams.get("section")).toBe("accounts");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Cuentas y saldos", exact: true })).toBeVisible();
  await expect(page.locator(".ops-nav-item[aria-current='page']")).toHaveText("Cuentas y saldos");
  await expect(page).toHaveTitle("Cuentas y saldos · Bombo");
  expect(new URL(page.url()).searchParams.get("section")).toBe("accounts");
});

test("new order validation preserves its draft and closing restores focus", async ({ page }) => {
  await page.goto("/app/operations?section=orders");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();

  const trigger = page.getByRole("button", { name: "＋ Nuevo pedido", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const member = dialog.getByRole("combobox", { name: "Socio", exact: true });
  await expect(member.locator("option").nth(1)).toBeAttached();
  const address = dialog.getByRole("textbox", { name: "Domicilio de reparto (opcional)", exact: true });
  await address.fill("Dirección sintética conservada durante la validación");

  const orderBefore = await page.request.get("/api/operations/orders/ops-local-draft");
  expect(orderBefore.status()).toBe(200);
  const before = (await orderBefore.json()).order;
  let commandRequests = 0;
  const watchCommands = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") commandRequests += 1;
    await route.continue();
  };
  await page.route("**/api/operations/commands", watchCommands);
  await dialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  await expect(dialog.locator("#ops-dialog-error")).toHaveText("Revisá los campos marcados antes de continuar.");
  await expect(member).toBeFocused();
  await expect(address).toHaveValue("Dirección sintética conservada durante la validación");
  expect(commandRequests).toBe(0);
  const orderAfter = await page.request.get("/api/operations/orders/ops-local-draft");
  expect(orderAfter.status()).toBe(200);
  const after = (await orderAfter.json()).order;
  expect(after.version).toBe(before.version);
  expect(after.commercialState).toBe(before.commercialState);
  expect(after.quoteVersion).toBe(before.quoteVersion);
  await page.unroute("**/api/operations/commands", watchCommands);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  const reopened = page.getByRole("dialog");
  await expect(reopened).toBeVisible();
  await reopened.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(reopened).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("configuration percent validation preserves focus and recovers from a server rejection", async ({ page }) => {
  await page.goto("/app/operations?section=configuration");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Configuración versionada", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "＋ Proponer configuración", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const percent = dialog.getByRole("textbox", { name: "Máximo adicional (%)", exact: true });
  await percent.fill("120");
  await dialog.getByLabel("Nombre de la regla", { exact: true }).fill("Límites sintéticos");
  await dialog.getByLabel("Tipo", { exact: true }).selectOption("preparation_limits");
  await dialog.getByLabel("Máximo de gramos por pedido", { exact: true }).fill("100");
  await dialog.getByLabel("Máximo extra por línea", { exact: true }).fill("0.1");
  await dialog.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  await dialog.getByLabel("Motivo y evidencia", { exact: true }).fill("Caso sintético de validación del límite porcentual.");

  let commandRequests = 0;
  const watchCommands = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") commandRequests += 1;
    await route.continue();
  };
  await page.route("**/api/operations/commands", watchCommands);
  await dialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const inlineError = dialog.locator("#ops-field-maximumExtraPercent-error");
  await expect(inlineError).toHaveText("El valor máximo es 100.");
  await expect(percent).toHaveAttribute("aria-invalid", "true");
  await expect(percent).toBeFocused();
  await expect(percent).toHaveValue("120");
  expect(commandRequests).toBe(0);

  await percent.fill("110");
  await expect(percent).toBeFocused();
  await expect(percent).toHaveAttribute("aria-invalid", "true");
  await expect(inlineError).toHaveText("El valor máximo es 100.");
  await expect(dialog.locator("#ops-dialog-error")).not.toBeFocused();

  await percent.fill("90");
  await expect(percent).toBeFocused();
  await expect(percent).not.toHaveAttribute("aria-invalid", "true");
  await expect(inlineError).toHaveCount(0);
  await expect(dialog.locator("#ops-dialog-error")).toHaveCount(0);
  await expect(dialog.getByLabel("Nombre de la regla", { exact: true })).toHaveValue("Límites sintéticos");
  await expect(dialog.getByLabel("Tipo", { exact: true })).toHaveValue("preparation_limits");
  await expect(dialog.getByLabel("Moneda", { exact: true })).toHaveValue("ARS");
  await expect(dialog.getByLabel("Motivo y evidencia", { exact: true })).toHaveValue("Caso sintético de validación del límite porcentual.");
  expect(commandRequests).toBe(0);

  // Model the documented HTTP 422 { error } response without writing to the disposable DB.
  const rejectedMessage = "Máximo adicional (%): el porcentaje excede el límite vigente.";
  let rejectedCommand = "";
  const rejectCommand = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "POST") return route.continue();
    commandRequests += 1;
    const payload = route.request().postDataJSON();
    rejectedCommand = String(payload.command);
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: rejectedMessage }) });
  };
  await page.unroute("**/api/operations/commands", watchCommands);
  await page.route("**/api/operations/commands", rejectCommand);
  await dialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  await expect(dialog.locator("#ops-dialog-error")).toHaveText(rejectedMessage);
  await expect(inlineError).toHaveText(rejectedMessage);
  await expect(percent).toBeFocused();
  await expect(percent).toHaveAttribute("aria-invalid", "true");
  expect(rejectedCommand).toBe("ConfigurationProposed");

  await percent.fill("110");
  await expect(percent).toBeFocused();
  await expect(dialog.locator("#ops-dialog-error")).toHaveCount(0);
  await expect(inlineError).toHaveText("El valor máximo es 100.");
  await expect(percent).toHaveAttribute("aria-invalid", "true");
  await expect(percent).toHaveValue("110");
  await expect(dialog.getByLabel("Nombre de la regla", { exact: true })).toHaveValue("Límites sintéticos");
  expect(commandRequests).toBe(1);
  await page.unroute("**/api/operations/commands", rejectCommand);
});

test("repeated amount field rejects more than two decimals and keeps focus", async ({ page }) => {
  await page.goto("/app/operations?section=commercial");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { name: "Políticas, packs y promociones", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "＋ Proponer pack", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nombre", { exact: true }).fill("Pack sintético de validación");
  await dialog.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  await dialog.getByLabel("Precio total del pack", { exact: true }).fill("100");
  await dialog.getByLabel("Producto fijo (opcional)", { exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel("Unidad", { exact: true }).selectOption("g");
  await dialog.getByLabel("Cantidad por pack", { exact: true }).fill("1");
  const reference = dialog.getByLabel("Importe de referencia del componente", { exact: true });
  await reference.fill("1,001");

  let commandRequests = 0;
  const watchCommands = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") commandRequests += 1;
    await route.continue();
  };
  await page.route("**/api/operations/commands", watchCommands);
  await dialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  await expect(reference).toHaveAttribute("aria-invalid", "true");
  await expect(reference).toBeFocused();
  await expect(reference).toHaveValue("1,001");
  await expect(dialog.getByRole("alert").filter({ hasText: "Ingresá un importe válido con hasta dos decimales." })).toBeVisible();
  expect(commandRequests).toBe(0);
  await page.unroute("**/api/operations/commands", watchCommands);
});
