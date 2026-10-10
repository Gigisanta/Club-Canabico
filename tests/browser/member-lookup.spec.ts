import { test, expect } from "./isolated";

// Owner boundary: a real operator selects a member beyond the first page and
// the authenticated API persists that identity, using only disposable fixtures.
test("new order can select a long-tail member through paged lookup and search", async ({ page }) => {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
  const origin = new URL(page.url()).origin;
  const suffix = crypto.randomUUID();
  const tailId = crypto.randomUUID();
  const tailName = `ZZZZ Consulta ${suffix}`;
  for (let index = 0; index < 111; index++) {
    const targetId = index === 110 ? tailId : crypto.randomUUID();
    const response = await page.request.post("/api/operations/commands", {
      headers: { Origin: origin },
      data: { schemaVersion: 1, requestId: crypto.randomUUID(), targetId, expectedVersion: 0,
        occurredAt: new Date().toISOString(), command: "MemberCreated",
        data: { name: index === 110 ? tailName : `ZZZ Consulta ${suffix} ${String(index).padStart(3, "0")}`, address: {}, preferences: {} } },
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  await page.getByRole("button", { name: "Pedidos", exact: true }).click();
  await page.getByRole("group", { name: "Pedidos: acciones", exact: true }).getByRole("button", { name: "＋ Pedido avanzado", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const member = dialog.getByRole("combobox", { name: "Socio", exact: true });
  await expect(dialog.getByRole("searchbox", { name: "Buscar socio por nombre", exact: true })).toBeVisible();
  await expect(member.locator("option")).toHaveCount(101);
  await expect(member.locator(`option[value="${tailId}"]`)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cargar más opciones", exact: true }).click();
  await expect(member.locator(`option[value="${tailId}"]`)).toHaveText(tailName);
  await dialog.getByRole("searchbox", { name: "Buscar socio por nombre", exact: true }).fill(tailName);
  await expect(member.locator("option")).toHaveCount(2);
  await member.selectOption(tailId);
  await dialog.getByLabel("Modalidad", { exact: true }).selectOption("local");
  await dialog.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  const created = page.waitForResponse(response => response.url().endsWith("/api/operations/commands") && response.request().method() === "POST" && response.request().postDataJSON()?.command === "OrderCreated");
  await dialog.getByRole("button", { name: "Revisar y registrar" }).click();
  const response = await created;
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(200);
  const detail = await page.request.get(`/api/operations/orders/${result.targetId}`);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).order.memberId).toBe(tailId);
});
