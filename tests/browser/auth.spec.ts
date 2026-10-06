import { test, expect } from "./isolated";
test("username login opens a persistent private session", async ({ page }) => {
  await page.goto("/app");
  await page.getByLabel("Nombre de usuario").fill(" OWNER ");
  const password = page.getByLabel("Contraseña", { exact: true });
  await password.fill("Demo-Bombo-2026!");
  const visibility = page.getByRole("button", { name: "Mostrar contraseña", exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await visibility.click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Ocultar contraseña", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Ocultar contraseña", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");

  // Hold the real synthetic login request at the browser boundary. The API still
  // validates the fixture credentials and issues its normal session response.
  let releaseLogin!: () => void;
  let signalLoginStarted!: () => void;
  const loginGate = new Promise<void>(resolve => { releaseLogin = resolve; });
  const loginStarted = new Promise<void>(resolve => { signalLoginStarted = resolve; });
  const holdLogin = async (route: import("@playwright/test").Route) => {
    signalLoginStarted();
    await loginGate;
    await route.continue();
  };
  await page.route("**/api/auth/login", holdLogin);
  let login: import("@playwright/test").Response;
  try {
    const response = page.waitForResponse(request => request.url().endsWith("/api/auth/login") && request.request().method() === "POST");
    await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
    await loginStarted;
    const pending = page.getByRole("button", { name: "Ingresando…", exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".login-form form")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("Nombre de usuario")).toBeDisabled();
    await expect(password).toBeDisabled();
    await expect(page.getByRole("button", { name: "Mostrar contraseña", exact: true })).toBeDisabled();
    releaseLogin();
    login = await response;
  } finally {
    releaseLogin();
    await page.unroute("**/api/auth/login", holdLogin);
  }
  expect(login.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Iniciar sesión", exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Iniciar sesión", exact: true })).toBeHidden();
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).user.username).toBe("owner");
});
