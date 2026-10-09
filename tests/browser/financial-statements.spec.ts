import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "./isolated";

test.use({ timezoneId: "Pacific/Kiritimati" });

test("financial statements keep an unobserved period pending and preserve local finance access", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();

  const emptyPeriod = "2000-01-01";
  const arsReport = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/reports/operations/financial-statements"
      && url.searchParams.get("currency") === "ARS";
  });
  await page.goto(`/app/finanzas?from=${emptyPeriod}&to=${emptyPeriod}&currency=ARS`);
  const arsResponse = await arsReport;
  expect(arsResponse.status()).toBe(200);
  const ars = await arsResponse.json();
  expect(ars).toMatchObject({
    report: "operations-financial-statements",
    currency: "ARS",
    period: { from: emptyPeriod, to: emptyPeriod },
    incomeStatement: {
      state: "unknown",
      netSales: { amountMinor: null, observedMinor: null },
      costOfGoodsSold: { amountMinor: null, observedMinor: null },
      operatingResult: { amountMinor: null, observedMinor: null },
    },
    cashFlow: {
      openingBalanceMinor: null,
      closingBalanceMinor: null,
      openingConfirmed: false,
      closingConfirmed: false,
    },
  });
  expect(ars.coverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ section: "incomeStatement", source: "delivered-products", knownCount: 0 }),
  ]));

  await expect(page.getByRole("heading", { name: "Resultado del período" })).toBeVisible();
  await expect(page.getByText("Sin importes observados para este período.", { exact: true })).toBeVisible();
  await expect(page.getByText("Sin datos observados", { exact: true }).first()).toBeVisible();
  const cashCard = page.locator(".financial-report-card").filter({ has: page.locator("#financial-cash-title") });
  const cashMetrics = cashCard.locator(".financial-report-metrics > div");
  await expect(cashMetrics.filter({ hasText: "Saldo de apertura" }).locator("dd")).toHaveText("Pendiente");
  await expect(cashMetrics.filter({ hasText: "Saldo de cierre" }).locator("dd")).toHaveText("Pendiente");
  await expect(page.locator(".financial-report-content").getByText(/^\$\s*0,00$/)).toHaveCount(0);
  const desktopWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(desktopWidth).toEqual({ viewport: 1280, document: 1280 });
  await page.screenshot({ path: ".local/finance-qa/financial-statements-empty-local-synthetic-desktop.png", fullPage: true });

  const dateOnlyFilter = "2026-10-08";
  await page.getByLabel("Hasta").fill(dateOnlyFilter);
  await page.getByLabel("Desde").fill(dateOnlyFilter);
  const dateOnlyReport = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/reports/operations/financial-statements"
      && url.searchParams.get("from") === dateOnlyFilter
      && url.searchParams.get("to") === dateOnlyFilter;
  });
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  const dateOnlyResponse = await dateOnlyReport;
  expect(dateOnlyResponse.status()).toBe(200);
  const dateOnly = await dateOnlyResponse.json();
  expect(dateOnly).toMatchObject({
    currency: "ARS",
    period: { from: dateOnlyFilter, to: dateOnlyFilter },
  });

  await page.getByLabel("Desde").fill(emptyPeriod);
  await page.getByLabel("Hasta").fill(emptyPeriod);
  await page.getByLabel("Moneda").selectOption("USD");
  const usdReport = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/reports/operations/financial-statements"
      && url.searchParams.get("currency") === "USD";
  });
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  const usdResponse = await usdReport;
  expect(usdResponse.status()).toBe(200);
  const usd = await usdResponse.json();
  expect(usd).toMatchObject({ currency: "USD", period: { from: emptyPeriod, to: emptyPeriod } });
  const usdRequest = new URL(usdResponse.url());
  expect(usdRequest.searchParams.get("from")).toBe(emptyPeriod);
  expect(usdRequest.searchParams.get("to")).toBe(emptyPeriod);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(mobileWidth.viewport).toBe(390);
  expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
  await page.screenshot({ path: ".local/finance-qa/financial-statements-empty-local-synthetic-mobile.png", fullPage: true });

  await page.getByRole("button", { name: "Resumen local", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Resultado local" })).toBeVisible();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Historial de caja y banco" })).toBeVisible();
  await page.getByRole("button", { name: "Planificación", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Planificar sin confundirlo con caja real" })).toBeVisible();

  await mkdir(".local/finance-qa", { recursive: true });
  await writeFile(".local/finance-qa/financial-statements-empty-local-synthetic.json", `${JSON.stringify({
    evidence: "Local browser E2E against a disposable Postgres schema with synthetic demo seeds; no production connection.",
    timezoneId: "Pacific/Kiritimati",
    emptyPeriod: {
      requestStatus: arsResponse.status(),
      currency: ars.currency,
      from: ars.period.from,
      to: ars.period.to,
      incomeState: ars.incomeStatement.state,
      deliveredProductKnownCount: ars.coverage.find((row: { section: string; source: string }) => row.section === "incomeStatement" && row.source === "delivered-products")?.knownCount,
      netSales: ars.incomeStatement.netSales,
      operatingResult: ars.incomeStatement.operatingResult,
      openingBalanceMinor: ars.cashFlow.openingBalanceMinor,
      closingBalanceMinor: ars.cashFlow.closingBalanceMinor,
    },
    dateOnlyFilter: {
      requestStatus: dateOnlyResponse.status(),
      from: dateOnly.period.from,
      to: dateOnly.period.to,
      currency: dateOnly.currency,
    },
    usdFilter: {
      requestStatus: usdResponse.status(),
      from: usd.period.from,
      to: usd.period.to,
      currency: usd.currency,
    },
    viewport: { desktop: desktopWidth, mobile: mobileWidth },
    localFinanceViews: ["Resumen local", "Caja", "Planificación"],
  }, null, 2)}\n`);
});
