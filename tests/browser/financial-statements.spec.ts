import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { createFinancialSourceReviewManifest, prepareFinancialSourceStage, stageFinancialSource } from "../../server/operations/financial-source-stage.js";
import { expect, test } from "./isolated";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const backupScript = join(repositoryRoot, "scripts/operations-backup.mjs");
const sourceFixtureKey = "c".repeat(64);
const sourcePiiSentinel = "SYNTHETIC_USER_ROW_MUST_NOT_BE_STAGED";

function sourceFixtureRows(prefix: string) {
  return [
    ["2026-08-31", "Ingreso", "Caja sintética A", 125.5, "ARS", `${prefix}-ars-in`],
    ["2026-08-31", "Egreso", "Caja sintética A", 25.25, "ARS", `${prefix}-ars-out`],
    ["2026-09-01", "Ingreso", "Caja sintética USD", 10, "USD", `${prefix}-usd-in`],
    ["2026-10-09", "Ingreso", "Caja sintética A", "30.00", "ARS", `${prefix}-future-text-amount`],
    [null, "Ingreso", "Caja sintética A", 15, "ARS", `${prefix}-missing-date`],
    ["2026-08-20", "Ingreso", "Caja sintética USD", "no-numérico", "USD", `${prefix}-invalid-amount`],
    ["2026-08-22", "Ingreso", "Caja sintética A", 30, "ARS", `${prefix}-duplicate-key`],
    ["2026-08-23", "Ingreso", "", 40, "ARS", `${prefix}-duplicate-key`],
  ] as const;
}

async function sourceFixtureWorkbook(prefix: string) {
  const workbook = new ExcelJS.Workbook();
  const movements = workbook.addWorksheet("Movimiento_Nueva");
  movements.addRow(["Fecha", "Tipo_Movimiento", "Caja", "Monto", "Tipo_Moneda", "ID_Movimiento_Unique"]);
  for (const row of sourceFixtureRows(prefix)) movements.addRow([...row]);
  const users = workbook.addWorksheet("T_Usuarios");
  users.addRow(["ID_Usuario", "Nombre", "Contraseña", "Token"]);
  users.addRow(["synthetic-user", sourcePiiSentinel, "synthetic-password", "synthetic-token"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function runSourceBackup(directory: string, databaseUrl: string, privateObjectRoot: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      BACKUP_ENCRYPTION_KEY: sourceFixtureKey,
      PRIVATE_OBJECT_ROOT: privateObjectRoot,
      PRIVATE_OBJECT_PROVIDER: "local",
      PRIVATE_S3_BUCKET: "",
      ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
    };
    const child = spawn(process.execPath, [backupScript, "backup", directory], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function safeSourceBackupOutput(result: { stdout: string; stderr: string; databaseUrl: string }) {
  return `${result.stdout}\n${result.stderr}`
    .split(sourceFixtureKey).join("[synthetic fixture key]")
    .split(result.databaseUrl).join("[isolated PostgreSQL URL redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[PostgreSQL URL redacted]");
}

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

test("financial source panel reads an isolated staged snapshot with separate ARS and USD observations", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(process.env.BOMBO_E2E_ISOLATED).toBe("1");
  const databaseURL = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]", "::1"]).toContain(databaseURL.hostname);
  expect(databaseURL.searchParams.get("schema")).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  const financeQaRoot = resolve(repositoryRoot, ".local/finance-qa");
  expect(process.env.PG_BIN && isAbsolute(process.env.PG_BIN)).toBe(true);
  expect(process.env.E2E_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(process.env.PRIVATE_OBJECT_PROVIDER).toBe("local");
  expect(process.env.PRIVATE_S3_BUCKET ?? "").toBe("");

  await mkdir(financeQaRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(financeQaRoot, "financial-source-browser-"));
  const backupDirectory = join(temporaryRoot, "encrypted-backup");
  const filename = basename(`synthetic-financial-source-${randomUUID()}.xlsx`);
  const originalBackupEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = sourceFixtureKey;

  try {
    const configuredPrivateObjectRoot = process.env.PRIVATE_OBJECT_ROOT ?? "";
    expect(isAbsolute(configuredPrivateObjectRoot)).toBe(true);
    const privateObjectRoot = resolve(configuredPrivateObjectRoot);
    expect(dirname(privateObjectRoot)).toBe(resolve(tmpdir()));
    expect(basename(privateObjectRoot)).toMatch(/^bombo-e2e-private-.+/);
    const privateObjectRootStat = await stat(privateObjectRoot);
    expect(privateObjectRootStat.isDirectory()).toBe(true);
    expect(privateObjectRootStat.mode & 0o777).toBe(0o700);
    const backup = await runSourceBackup(backupDirectory, databaseURL.toString(), privateObjectRoot);
    const safeBackupOutput = safeSourceBackupOutput({ ...backup, databaseUrl: databaseURL.toString() });
    expect(backup.code, safeBackupOutput).toBe(0);
    const backupSummary = JSON.parse(backup.stdout) as {
      mode: string;
      encrypted: boolean;
      scope: string;
      files: number;
      objectReuse: { sourceObjectReads: number; reusedDocuments: number };
    };
    expect(backupSummary).toMatchObject({
      mode: "backup",
      encrypted: true,
      scope: "confirmed-server-state-only",
    });
    expect(backupSummary.files).toBeGreaterThanOrEqual(1);
    expect(backupSummary.objectReuse.sourceObjectReads).toBe(1);
    expect(backupSummary.objectReuse.reusedDocuments).toBe(0);

    const bytes = await sourceFixtureWorkbook(randomUUID());
    const prepared = await prepareFinancialSourceStage(bytes, filename);
    expect(prepared.snapshot.fileHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(prepared.snapshot.sheets.map(sheet => sheet.name)).toEqual(["Movimiento_Nueva"]);
    expect(JSON.stringify(prepared)).not.toContain(sourcePiiSentinel);
    const staged = await stageFinancialSource(prepared, {
      filename,
      reviewManifest: createFinancialSourceReviewManifest(prepared.reconciliationManifest),
      backupReference: backupDirectory,
    });
    expect(staged.status).toBe("staged");
    expect(staged.recordCount).toBe(8);
    expect(staged.eligibleCount).toBe(3);
    expect(staged.excludedCount).toBe(5);

    const sourcePath = "/api/reports/operations/financial-source-reconciliation";
    const unauthenticated = await page.request.get(new URL(sourcePath, process.env.E2E_BASE_URL).toString());
    expect(unauthenticated.status()).toBe(401);

    await page.goto("/app/operations");
    await page.getByRole("button", { name: "Explorar club de demostración" }).click();
    await expect(page.locator(".ops-home-page")).toBeVisible();
    const sourceResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === sourcePath;
    });
    await page.goto("/app/finanzas?from=2026-08-01&to=2026-10-08&currency=ARS");
    const sourceResponse = await sourceResponsePromise;
    expect(sourceResponse.status()).toBe(200);
    const report = await sourceResponse.json();
    expect(report).toMatchObject({
      report: "operations-financial-source-reconciliation",
      cutoffDate: "2026-10-08",
      latestObservedDate: "2026-09-01",
      completeness: "technical-source-reconciled",
      sourceUnapproved: true,
      createsBalances: false,
      currentPeriodStatus: "unknown",
      periods: [
        { month: "2026-08", currency: "ARS", count: 2, inflowMinor: "12550", outflowMinor: "2525", netMovementMinor: "10025" },
        { month: "2026-09", currency: "USD", count: 1, inflowMinor: "1000", outflowMinor: "0", netMovementMinor: "1000" },
      ],
    });
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]).toMatchObject({
      filename,
      status: "staged",
      sourceReviewApproved: false,
      loadedCount: 8,
      eligibleCount: 3,
      excludedCount: 5,
      latestObservedDate: "2026-09-01",
      technicalReconciliation: "reconciled",
      controlComparison: { exact: true, scope: true, periods: true },
      exclusionCounts: {
        missingDate: 1,
        invalidDate: 0,
        futureDate: 1,
        nonNumericAmount: 2,
        negativeAmount: 0,
        invalidMovementType: 0,
        invalidCurrency: 0,
        blankCashBox: 1,
        duplicateIdentity: 2,
      },
    });
    expect(JSON.stringify(report)).not.toContain(sourcePiiSentinel);

    const sourceCard = page.locator(".financial-source-card");
    const sourceSnapshot = sourceCard.locator(".financial-source-snapshot");
    await expect(sourceSnapshot).toBeVisible();
    await expect(sourceSnapshot.locator(".financial-source-status")).toContainText("STAGED · sin aprobación humana");
    const periodRows = sourceSnapshot.locator(".financial-source-table tbody tr");
    await expect(periodRows).toHaveCount(2);
    await expect(periodRows.nth(0).locator("td")).toHaveText(["ARS", "2", "ARS 125,50", "ARS 25,25", "ARS 100,25"]);
    await expect(periodRows.nth(1).locator("td")).toHaveText(["USD", "1", "USD 10,00", "USD 0,00", "USD 10,00"]);
    const exclusionDetails = sourceSnapshot.locator(".financial-source-exclusions");
    await exclusionDetails.locator("summary").click();
    await expect(exclusionDetails.locator("li").filter({ hasText: "Identidad duplicada" }).locator("strong")).toHaveText("2");

    await mkdir(join(repositoryRoot, ".local/finance-qa"), { recursive: true });
    const desktopWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(desktopWidth.viewport).toBe(1280);
    expect(desktopWidth.document).toBeLessThanOrEqual(desktopWidth.viewport);
    await sourceCard.screenshot({ path: ".local/finance-qa/financial-source-staged-desktop.png", animations: "disabled" });

    await sourceCard.getByRole("button", { name: "Ver último período con datos" }).click();
    await expect(page.getByLabel("Desde")).toHaveValue("2026-09-01");
    await expect(page.getByLabel("Hasta")).toHaveValue("2026-09-30");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(mobileWidth.viewport).toBe(390);
    expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
    await sourceCard.screenshot({ path: ".local/finance-qa/financial-source-staged-mobile.png", animations: "disabled" });
  } finally {
    if (originalBackupEncryptionKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = originalBackupEncryptionKey;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("finance workspace records manual payables coverage and keeps a reader without the form", async ({ page }) => {
  expect(process.env.BOMBO_E2E_ISOLATED).toBe("1");
  const databaseURL = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]", "::1"]).toContain(databaseURL.hostname);
  expect(databaseURL.searchParams.get("schema")).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(process.env.E2E_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await page.setViewportSize({ width: 1280, height: 900 });

  const isProjectionReport = (response: import("@playwright/test").Response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/reports/operations/summary"
      && url.searchParams.get("area") === "obligations-13-weeks";
  };
  async function switchDemoActor(id: "owner" | "viewer" | "gio") {
    const response = await page.request.post("/api/auth/demo", {
      data: { id },
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(response.status(), await response.text()).toBe(200);
  }

  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();

  // Give a non-admin demo viewer finance/report read access in the isolated fixture.
  // The finance profile includes write capabilities; role-based attestation control must still hide the form.
  await switchDemoActor("owner");
  const accessGrant = await page.request.post("/api/operations/commands", {
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId: randomUUID(),
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
      command: "AccessGranted",
      data: { userId: "viewer", profile: "finance", additional: [], scope: {} },
    },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(accessGrant.status(), await accessGrant.text()).toBe(200);

  const ownerReportPromise = page.waitForResponse(isProjectionReport);
  await page.goto("/app/operations?section=finance");
  await expect(page.getByRole("heading", { name: "Documentar cobertura de obligaciones" })).toBeVisible();
  expect((await ownerReportPromise).status()).toBe(200);

  const viewerAttestationPosts: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/decision-inputs/attestations")
      viewerAttestationPosts.push(request.url());
  });
  await switchDemoActor("viewer");
  const viewerReportPromise = page.waitForResponse(isProjectionReport);
  await page.goto("/app/operations?section=finance");
  await expect(page.getByRole("heading", { name: "Obligaciones verificadas y pendientes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documentar cobertura de obligaciones" })).toHaveCount(0);
  await expect(page.getByText("La lectura del informe sigue disponible. Solo un propietario o administrador puede registrar esta declaración.", { exact: true })).toBeVisible();
  const viewerReportResponse = await viewerReportPromise;
  expect(viewerReportResponse.status()).toBe(200);
  expect(viewerAttestationPosts).toHaveLength(0);

  await switchDemoActor("gio");
  const initialReportPromise = page.waitForResponse(isProjectionReport);
  await page.goto("/app/operations?section=finance");
  const initialReportResponse = await initialReportPromise;
  expect(initialReportResponse.status()).toBe(200);
  const initialReport = await initialReportResponse.json() as {
    summary: { metrics: { horizon: { from: string; through: string } } };
  };
  const horizon = initialReport.summary.metrics.horizon;
  const shiftedHorizonAnchor = new Date(`${horizon.from}T00:00:00Z`);
  shiftedHorizonAnchor.setUTCDate(shiftedHorizonAnchor.getUTCDate() - 7);
  const shiftedSelectedDate = shiftedHorizonAnchor.toISOString().slice(0, 10);

  const fromField = page.getByLabel("Desde · inicio del horizonte de 13 semanas", { exact: true });
  const throughField = page.getByLabel("Hasta · cierre del horizonte de 13 semanas", { exact: true });
  const sourceField = page.getByRole("textbox", { name: /^Referencia humana de la fuente/ });
  const completeCheckbox = page.getByLabel("Declaro que esta fuente incluye todas las obligaciones entre las fechas indicadas.", { exact: true });
  const reviewCheckbox = page.getByLabel("Revisé el período y la fuente citada.", { exact: true });
  const coverageForm = page.locator(".finance-attestation-form");
  await expect(page.getByRole("heading", { name: "Documentar cobertura de obligaciones" })).toBeVisible();
  await expect(fromField).toHaveValue(horizon.from);
  await expect(throughField).toHaveValue(horizon.through);
  const draftReference = `Borrador de vencimientos pendiente de nueva revisión ${randomUUID()}`;
  await sourceField.fill(draftReference);
  await completeCheckbox.check();
  await reviewCheckbox.check();

  const shiftedReportPromise = page.waitForResponse(response => isProjectionReport(response)
    && new URL(response.url()).searchParams.get("to") === shiftedSelectedDate);
  await page.evaluate(date => {
    const url = new URL(window.location.href);
    url.searchParams.set("to", date);
    window.history.pushState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, shiftedSelectedDate);
  const shiftedReportResponse = await shiftedReportPromise;
  expect(shiftedReportResponse.status()).toBe(200);
  const shiftedReport = await shiftedReportResponse.json() as {
    summary: { metrics: { horizon: { from: string; through: string } } };
  };
  const currentHorizon = shiftedReport.summary.metrics.horizon;
  expect(currentHorizon).not.toEqual(horizon);
  await expect(fromField).toHaveValue(currentHorizon.from);
  await expect(throughField).toHaveValue(currentHorizon.through);
  await expect(sourceField).toHaveValue(draftReference);
  await expect(completeCheckbox).not.toBeChecked();
  await expect(reviewCheckbox).not.toBeChecked();
  await expect(coverageForm.getByRole("status")).toContainText("Cambió el horizonte: actualicé las fechas y conservé la referencia.");

  await completeCheckbox.check();
  await reviewCheckbox.check();

  const rejectedReference = "Bearer SYNTHETIC_FINANCE_COVERAGE_CANARY_123";
  await sourceField.fill(rejectedReference);
  const rejectedPostPromise = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/decision-inputs/attestations");
  await page.getByRole("button", { name: "Guardar declaración de cobertura", exact: true }).click();
  const rejectedPost = await rejectedPostPromise;
  expect(rejectedPost.status()).toBe(400);
  expect(rejectedPost.request().postDataJSON()).toMatchObject({
    domain: "payables",
    scenario: null,
    fromDate: currentHorizon.from,
    throughDate: currentHorizon.through,
    complete: true,
    sourceReference: rejectedReference,
  });
  await expect(coverageForm.getByRole("alert")).toBeVisible();
  await expect(fromField).toHaveValue(currentHorizon.from);
  await expect(throughField).toHaveValue(currentHorizon.through);
  await expect(sourceField).toHaveValue(rejectedReference);
  await expect(completeCheckbox).toBeChecked();
  await expect(reviewCheckbox).toBeChecked();

  const sourceReference = `Planilla sintética de vencimientos verificada en E2E ${randomUUID()}`;
  await sourceField.fill(sourceReference);
  const clientAttestationPayloads: Record<string, unknown>[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/decision-inputs/attestations")
      clientAttestationPayloads.push(request.postDataJSON() as Record<string, unknown>);
  });
  let committedResponse: { status: number; receipt: { id: string; complete: boolean } } | null = null;
  let firstRequestIntercepted = false;
  await page.route("**/api/decision-inputs/attestations", async route => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    if (!firstRequestIntercepted && payload.sourceReference === sourceReference) {
      firstRequestIntercepted = true;
      const actualResponse = await route.fetch();
      committedResponse = {
        status: actualResponse.status(),
        receipt: await actualResponse.json() as { id: string; complete: boolean },
      };
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "synthetic response interruption after server commit" }),
      });
      return;
    }
    await route.continue();
  });
  const uncertainPostPromise = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/decision-inputs/attestations"
    && response.request().postDataJSON().sourceReference === sourceReference);
  const uncertainReportPromise = page.waitForResponse(isProjectionReport);
  await page.getByRole("button", { name: "Guardar declaración de cobertura", exact: true }).click();
  const [uncertainPost, uncertainRefreshResponse] = await Promise.all([uncertainPostPromise, uncertainReportPromise]);
  expect(uncertainPost.status()).toBe(503);
  expect(uncertainRefreshResponse.status()).toBe(200);
  expect(committedResponse?.status).toBe(201);
  const firstCommitReceipt = committedResponse?.receipt;
  expect(firstCommitReceipt?.complete).toBe(true);
  const retryCheckbox = page.getByLabel("Confirmo reintentar exactamente el mismo período, referencia y declaración con el mismo ID.", { exact: true });
  await expect(coverageForm.getByRole("alert")).toContainText("Conservé los datos y el mismo ID");
  await expect(fromField).toHaveValue(currentHorizon.from);
  await expect(throughField).toHaveValue(currentHorizon.through);
  await expect(sourceField).toHaveValue(sourceReference);
  await expect(completeCheckbox).toBeChecked();
  await expect(reviewCheckbox).toBeChecked();
  await expect(fromField).toBeDisabled();
  await expect(throughField).toBeDisabled();
  await expect(sourceField).toBeDisabled();
  await expect(retryCheckbox).not.toBeChecked();
  const retryButton = page.getByRole("button", { name: "Reintentar la misma declaración", exact: true });
  await expect(retryButton).toBeDisabled();

  await retryCheckbox.check();
  const replayPromise = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/decision-inputs/attestations"
    && response.request().postDataJSON().sourceReference === sourceReference);
  const refreshedReportPromise = page.waitForResponse(isProjectionReport);
  await retryButton.click();
  const [replayResponse, refreshedReportResponse] = await Promise.all([replayPromise, refreshedReportPromise]);
  expect(replayResponse.status()).toBe(201);
  const replayReceipt = await replayResponse.json() as { id: string; complete: boolean };
  expect(replayReceipt.complete).toBe(true);

  const submittedCoverage = replayResponse.request().postDataJSON() as Record<string, unknown>;
  expect(submittedCoverage).toMatchObject({
    domain: "payables",
    scenario: null,
    fromDate: currentHorizon.from,
    throughDate: currentHorizon.through,
    complete: true,
    sourceReference,
  });
  expect(submittedCoverage.requestId).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
  expect(firstCommitReceipt?.id).toBe(submittedCoverage.requestId);
  expect(replayReceipt.id).toBe(submittedCoverage.requestId);
  const sameDeclarationAttempts = clientAttestationPayloads.filter(payload => payload.sourceReference === sourceReference);
  expect(sameDeclarationAttempts).toHaveLength(2);
  expect(sameDeclarationAttempts[1]).toEqual(sameDeclarationAttempts[0]);

  expect(refreshedReportResponse.status()).toBe(200);
  const refreshedReport = await refreshedReportResponse.json() as {
    summary: { metrics: { attestation: { present: boolean; sourceReference?: string; fromDate?: string; throughDate?: string } } };
  };
  expect(refreshedReport.summary.metrics.attestation).toMatchObject({
    present: true,
    sourceReference,
    fromDate: currentHorizon.from,
    throughDate: currentHorizon.through,
  });
  await expect(page.locator(".finance-projection-coverage-grid")).toContainText("Informada");
  await expect(page.locator(".finance-projection-coverage-grid")).toContainText(sourceReference);
  await expect(coverageForm.getByRole("status")).toContainText("Declaración completa registrada.");
});
