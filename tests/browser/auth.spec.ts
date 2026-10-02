import { test, expect } from "./isolated";
test("username login opens a persistent private session", async ({ page }) => {
  await page.goto("/app");
  await page.getByLabel("Nombre de usuario").fill(" OWNER ");
  await page.getByLabel("Contraseña", { exact: true }).fill("Demo-Bombo-2026!");
  const [login] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/auth/login") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Iniciar sesión", exact: true }).click(),
  ]);
  expect(login.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Iniciar sesión", exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Iniciar sesión", exact: true })).toBeHidden();
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).user.username).toBe("owner");
});
