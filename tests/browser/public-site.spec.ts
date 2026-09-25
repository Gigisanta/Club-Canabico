import { test, expect } from "./isolated";
import { resolve } from "node:path";

test("public preview and legacy deep links work on desktop and mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Un lugar para/ })).toBeVisible();
  await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
  await page.goto("/productos");
  await expect(page.getByRole("heading", { name: /Lo que queremos/ })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/\$\s?\d|stock:\s?\d|reservar/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(Number.parseFloat(await page.locator(".public-hero h1").evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(50);
  await page.getByRole("button", { name: "Abrir menú" }).click();
  await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Abrir menú" })).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/socios?segment=permits&q=Ana");
  await expect(page).toHaveURL(/\/app\/socios\?segment=permits&q=Ana$/);
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Socios y fidelización" })).toBeVisible();
});

test("owner curates a public ficha; inquiry lands only in its private inbox", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const slug = `vista-previa-qa-${suffix}`;
  const title = `Vista previa QA ${suffix}`;
  const contact = `bombo-qa-${suffix}@example.test`;
  const origin = new URL(process.env.E2E_BASE_URL!).origin;
  let itemId = "";
  let inquiryId = "";
  let previousChannels: { whatsappPhone: string; instagramUrl: string } | null = null;
  await page.goto("/app/vidriera");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  try {
    await page.getByRole("button", { name: "Nueva ficha" }).click();
    const dialog = page.getByRole("dialog", { name: "Nueva ficha" });
    await dialog.getByLabel("Nombre", { exact: true }).fill(title);
    await dialog.getByLabel("Categoría").fill("Flores");
    await dialog.getByLabel("Descripción").fill("Ficha editorial de verificación, sin precio, stock ni reservas.");
    await dialog.getByLabel("Orden de presentación").fill("1");
    await dialog.getByLabel("Imagen de la ficha").setInputFiles(resolve("public/brand/bombo-symbol.png"));
    await dialog.getByRole("button", { name: "Crear borrador" }).click();
    await expect(dialog).toBeHidden();
    const card = page.locator(".showcase-admin-card").filter({ hasText: title });
    await expect(card).toContainText("Borrador");
    const listResponse = await page.request.get("/api/site/admin/showcase");
    itemId = ((await listResponse.json()).items as { id: string; title: string }[]).find(item => item.title === title)?.id || "";
    expect(itemId).not.toBe("");
    await card.getByRole("button", { name: "Publicar" }).click();
    await expect(card).toContainText("Publicada");
    await page.goto(`/productos/${slug}`);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.locator(".public-detail-image img")).toHaveAttribute("src", new RegExp(slug));
    previousChannels = await (await page.request.get("/api/site/admin/channels")).json();
    await page.request.put("/api/site/admin/channels", { headers: { Origin: origin }, data: { whatsappPhone: "5491111111111", instagramUrl: previousChannels.instagramUrl || "" } });
    let interceptedWhatsAppUrl = "";
    await page.context().route("https://wa.me/**", async route => {
      interceptedWhatsAppUrl = route.request().url();
      await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>WhatsApp interceptado</h1>" });
    });
    await page.getByLabel("Tu nombre").fill("Persona QA");
    await page.getByLabel("Correo o teléfono").fill(contact);
    await page.getByLabel("Mensaje").fill("Quisiera conocer más sobre esta ficha.");
    await page.getByLabel(/Acepto que Bombo/).check();
    await page.getByRole("button", { name: "Enviar consulta" }).click();
    await expect(page.getByRole("status")).toContainText(/consulta quedó guardada/i);
    const whatsAppCTA = page.getByRole("link", { name: /WhatsApp/i });
    await expect(whatsAppCTA).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/productos/${slug}$`));

    const inboxPage = await page.context().newPage();
    await inboxPage.goto("/app/consultas");
    const inquiry = inboxPage.locator(".inquiry-card").filter({ hasText: contact });
    const inboxResponse = await page.request.get("/api/site/admin/inquiries");
    inquiryId = ((await inboxResponse.json()).items as { id: string; contact: string }[]).find(item => item.contact === contact)?.id || "";
    expect(inquiryId).not.toBe("");
    await expect(inquiry).toContainText(title);
    await inquiry.getByLabel("Notas internas").fill("Seguimiento pendiente en esta vista previa.");
    await inboxPage.getByRole("button", { name: "Contactadas", exact: true }).click();
    await inboxPage.getByRole("button", { name: "Todas", exact: true }).click();
    await expect(inquiry.getByLabel("Notas internas")).toHaveValue("Seguimiento pendiente en esta vista previa.");
    await inboxPage.close();

    await whatsAppCTA.click();
    await expect.poll(() => interceptedWhatsAppUrl).toMatch(/^https:\/\/wa\.me\/5491111111111/);
    const whatsAppURL = new URL(interceptedWhatsAppUrl);
    const whatsAppText = whatsAppURL.searchParams.get("text") || "";
    expect(whatsAppText).toBe("Hola Bombo, envié una consulta desde la web.");
    expect(interceptedWhatsAppUrl).not.toContain(contact);
    expect(interceptedWhatsAppUrl).not.toContain("Persona QA");
    expect(interceptedWhatsAppUrl).not.toContain(title);

    const searchResponse = await page.request.get(`/api/search?q=${encodeURIComponent(contact)}`);
    const searchBody = JSON.stringify(await searchResponse.json());
    expect(searchBody).not.toContain(contact);
  } finally {
    if (previousChannels) await page.request.put("/api/site/admin/channels", { headers: { Origin: origin }, data: { whatsappPhone: previousChannels.whatsappPhone || "", instagramUrl: previousChannels.instagramUrl || "" } });
    if (inquiryId) await page.request.delete(`/api/site/admin/inquiries/${inquiryId}`, { headers: { Origin: origin } });
    if (itemId) await page.request.delete(`/api/site/admin/showcase/${itemId}`, { headers: { Origin: origin } });
  }
});

test("consultas ignores a delayed page from the previous filter", async ({ page }) => {
  await page.goto("/app/consultas");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  const inquiry = {
    id: "inquiry-stale-page", name: "Consulta de otra etapa", contact: "otra@example.test",
    interest: "Club", message: "Consulta de verificación visual.", source: "test",
    status: "new", notes: "", consentAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  };
  let releaseOldPage: (() => void) | undefined;
  let oldPageRequested!: () => void;
  const oldRequest = new Promise<void>((resolve) => { oldPageRequested = resolve; });
  await page.route("**/api/site/admin/inquiries*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      oldPageRequested();
      await new Promise<void>((resolve) => { releaseOldPage = resolve; });
      await route.fulfill({ json: { items: [inquiry], nextCursor: null } });
    } else if (url.searchParams.get("status") === "closed") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else {
      await route.fulfill({ json: { items: [], nextCursor: "next-page" } });
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar más consultas" }).click();
  await oldRequest;
  await page.getByRole("button", { name: "Cerradas", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sin resultados en esta etapa" })).toBeVisible();
  releaseOldPage?.();
  await expect(page.getByText("Consulta de otra etapa")).toHaveCount(0);
});

test("public admin pages and API reject non managers", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await page.getByRole("button", { name: "Probar otro rol" }).click();
  await page.getByRole("button", { name: "Lucía · sus lotes y ventas" }).click();
  await expect(page.getByRole("link", { name: "Vidriera" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Consultas" })).toHaveCount(0);
  await page.goto("/app/vidriera");
  await expect(page).toHaveURL(/\/app\/?$/);
  const response = await page.request.get("/api/site/admin/showcase");
  expect(response.status()).toBe(403);
});
