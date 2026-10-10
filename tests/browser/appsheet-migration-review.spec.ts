import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Page, Route } from "@playwright/test";
import type { CommandEnvelope } from "../../shared/operations/contracts.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../../shared/operations/appsheet-history.js";
import { appSheetDeliveryInvoiceReferenceMatches } from "../../shared/operations/appsheet-pending-import.js";
import { appSheetDatabaseDestinationIdentity } from "../../server/operations/appsheet-database-target.js";
import { prepareAppSheetHistoryProjection, stageAppSheetHistoryProjection } from "../../server/operations/appsheet-history.js";
import { prepareAppSheetPendingImportPlan, appSheetPendingOrderCommercialBasisHash } from "../../server/operations/appsheet-pending-import.js";
import { db } from "../../server/db.js";
import "../../server/operations/appsheet-history-review.js";
import "../../server/operations/finance.js";
import { syntheticPendingHistorySource } from "../support/appsheet-pending-import-fixture.js";
import { expect, getIsolatedE2EPassword, test } from "./isolated";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sha256Canonical = (value: unknown) => sha256(canonicalJson(value));

function assertFixtureIdsAvailable(condition: unknown): asserts condition {
  if (!condition) throw new Error("El escenario requiere identificadores sintéticos libres en el esquema E2E descartable.");
}

function command(targetId: string, name: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope {
  const requestId = randomUUID();
  return {
    schemaVersion: 1,
    requestId,
    targetId,
    command: name,
    data,
    expectedVersion,
    occurredAt: new Date().toISOString(),
  };
}

async function executeAs(actorId: string, envelope: CommandEnvelope) {
  const { executeCommand } = await import("../../server/operations/core.js");
  const actor = await db.user.findUniqueOrThrow({ where: { id: actorId } });
  return executeCommand(actor, envelope);
}

async function loginAs(page: Page, email: string) {
  await page.goto("/app");
  const response = await page.request.post("/api/auth/login", {
    data: { email, password: getIsolatedE2EPassword() },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto("/app/operations?section=imports");
  await expect(page.getByRole("heading", { name: "Importar libro legado", exact: true })).toBeVisible();
}

async function createDestinationReviewScenario() {
  const databaseURL = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"], "La spec sólo puede escribir en loopback").toContain(databaseURL.hostname);
  const schema = databaseURL.searchParams.get("schema") ?? "";
  expect(schema).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(process.env.BOMBO_E2E_ISOLATED).toBe("1");

  const suffix = randomUUID();
  const actorIds = {
    importer: `appsheet-importer-${suffix}`,
    sourceReviewer: `appsheet-source-reviewer-${suffix}`,
    destinationReviewer: `appsheet-destination-reviewer-${suffix}`,
    writerOnly: `appsheet-writer-only-${suffix}`,
    technicalReviewer: `appsheet-technical-${suffix}`,
    member: `appsheet-member-${suffix}`,
  };
  const emails = Object.fromEntries(Object.entries(actorIds).filter(([key]) => key !== "technicalReviewer" && key !== "member")
    .map(([key, id]) => [key, `${id}@pending-import.test`])) as Record<"importer" | "sourceReviewer" | "destinationReviewer" | "writerOnly", string>;
  const users = [actorIds.importer, actorIds.sourceReviewer, actorIds.destinationReviewer, actorIds.writerOnly];
  const [existingUsers, existingAccess] = await Promise.all([
    db.user.count({ where: { id: { in: users } } }),
    db.operationAccess.count({ where: { userId: { in: users } } }),
  ]);
  assertFixtureIdsAvailable(existingUsers === 0 && existingAccess === 0);
  const password = getIsolatedE2EPassword();
  const passwordHash = await bcrypt.hash(password, 4);
  for (const id of users) {
    const email = id === actorIds.importer ? emails.importer
      : id === actorIds.sourceReviewer ? emails.sourceReviewer
        : id === actorIds.destinationReviewer ? emails.destinationReviewer : emails.writerOnly;
    await db.user.create({
      data: { id, name: "Synthetic AppSheet review actor", email, password: passwordHash, role: "admin" },
    });
    await db.operationAccess.create({
      data: {
        userId: id,
        profile: "admin",
        capabilities: id === actorIds.writerOnly ? ["imports.write"] : ["imports.write", "imports.review"],
        scope: {},
      },
    });
  }

  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseURL);
  const source = syntheticPendingHistorySource();
  const preparedHistory = prepareAppSheetHistoryProjection(source.capture, source.definition);
  const [existingCapture, existingSnapshot] = await Promise.all([
    db.appSheetCaptureManifest.findUnique({ where: { captureId: source.capture.manifest.captureId }, select: { captureId: true } }),
    db.legacyImportSnapshot.findUnique({ where: { id: preparedHistory.snapshotId }, select: { id: true } }),
  ]);
  assertFixtureIdsAvailable(!existingCapture && !existingSnapshot);
  const stageCommitSha = sha256("synthetic browser pending-import source commit").slice(0, 40);
  const backupSnapshotAt = new Date(Date.now() - 60_000).toISOString();
  const backupManifestHash = sha256("synthetic browser pending-import source backup");
  const technicalReview = {
    schemaVersion: 2,
    reviewKind: "independent-technical",
    captureId: source.capture.manifest.captureId,
    manifestHash: source.capture.manifest.manifestHash,
    definitionHash: source.definition.appliedDefinitionHash,
    projectionKind: "history",
    projectionHash: preparedHistory.projectionHash,
    commitSha: stageCommitSha,
    target: "isolated-test",
    destinationIdentity,
    importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    reviewer: actorIds.technicalReviewer,
    approved: true,
    reviewedAt: new Date(Date.now() - 120_000).toISOString(),
    findings: [],
  };
  const staged = await stageAppSheetHistoryProjection(preparedHistory, {
    actorId: actorIds.importer,
    technicalReview,
    commitSha: stageCommitSha,
    target: "isolated-test",
    destinationIdentity,
    backupEvidence: { manifestHash: sha256("synthetic source backup manifest"), snapshotAt: backupSnapshotAt },
  }, db);
  assertFixtureIdsAvailable(!staged.replay && staged.captureManifestId === source.capture.manifest.captureId);
  expect(staged.status).toBe("staged");
  expect(staged.metrics.recordCount).toBe(4);
  const snapshotId = staged.snapshotId;

  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetHistorySourceReviewed", {
    fileHash: source.capture.manifest.manifestHash,
    captureId: source.capture.manifest.captureId,
    dataHash: source.capture.manifest.dataHash,
    projectionHash: preparedHistory.projectionHash,
    evidenceReference: "Revisión humana sintética del fixture AppSheet estable.",
  }, 0));

  const existingMember = await db.operationMember.findUnique({ where: { id: actorIds.member }, select: { id: true } });
  assertFixtureIdsAvailable(!existingMember);
  await db.operationMember.create({ data: {
    id: actorIds.member,
    name: "Synthetic AppSheet pending-import member",
    address: { address: "Domicilio actual sintético no sustituye al histórico" },
    preferences: {},
  } });
  const orderId = `appsheet-pending-order-${suffix}`;
  const lineId = `appsheet-pending-order-line-${suffix}`;
  const skuId = `appsheet-pending-sku-${suffix}`;
  const existingOrder = await db.operationOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  const existingOrderObject = await db.operationObject.findUnique({ where: { id: orderId }, select: { id: true } });
  assertFixtureIdsAvailable(!existingOrder && !existingOrderObject);
  await db.operationOrder.create({ data: {
    id: orderId,
    memberId: actorIds.member,
    channel: "delivery",
    currency: "ARS",
    commercialState: "confirmed",
    quote: { schemaVersion: 1, source: "synthetic-test", lines: [{ skuId, requested: "1", unitPrice: "100" }] },
    quoteVersion: 1,
    subtotalMinor: 10_000n,
    totalMinor: 10_000n,
    verifiedMinor: 0n,
    refundedMinor: 0n,
    financialState: "unpaid",
    fulfillmentState: "unprepared",
    address: { address: "Domicilio actual sintético no sustituye al histórico" },
    createdBy: actorIds.importer,
    lines: { create: [{
      id: lineId,
      skuId,
      unit: "g",
      requested: "1",
      unitPrice: "100",
      referenceMinor: 10_000n,
      revenueMinor: 10_000n,
    }] },
  } });
  await db.operationObject.create({ data: { id: orderId, kind: "order", version: 1, createdBy: actorIds.importer } });
  const order = await db.operationOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
  const orderObject = await db.operationObject.findUniqueOrThrow({ where: { id: orderId } });
  const orderHash = sha256Canonical({
    id: order.id,
    currency: order.currency,
    totalMinor: order.totalMinor.toString(),
    verifiedMinor: order.verifiedMinor.toString(),
    refundedMinor: order.refundedMinor.toString(),
    commercialState: order.commercialState,
    financialState: order.financialState,
    version: orderObject.version,
  });
  expect(appSheetPendingOrderCommercialBasisHash(order)).toMatch(/^[a-f0-9]{64}$/);

  const planWithoutBinding = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
  const invoiceDisposition = planWithoutBinding.dispositions.find(row => row.sourceTable === "C_Facturacion" && row.dimension === "receivable");
  expect(invoiceDisposition?.sourceStatus).toBe("confirmed_pending");
  const snapshotObject = await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } });
  const identityId = sha256(`${APPSHEET_HISTORY_SOURCE_SYSTEM}\0C_Facturacion\0${source.invoiceSourceKey}\0order`);
  const existingIdentity = await db.legacyIdentity.findUnique({ where: { id: identityId }, select: { id: true } });
  assertFixtureIdsAvailable(!existingIdentity);
  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetPendingOrderIdentityReviewed", {
    sourceRecordId: invoiceDisposition!.sourceRecordId,
    sourceRecordHash: invoiceDisposition!.sourceRecordHash,
    reconciliationHash: invoiceDisposition!.reconciliationHash,
    mappingHash: invoiceDisposition!.mappingHash,
    operationOrderId: orderId,
    operationOrderVersion: orderObject.version,
    operationOrderHash: orderHash,
    evidence: "Vínculo sintético exacto entre captura y pedido preexistente.",
  }, snapshotObject.version));

  const invoiceRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Facturacion" } });
  const motoRecord = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "C_Moto" } });
  const sourceCell = async (sourceRecordId: string, header: string) => {
    const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
    const original = record.original as { columns?: Array<Record<string, unknown>> };
    const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
    const originalMatch = (original.columns ?? []).filter(column => column.header === header);
    const normalizedMatch = (normalized.columns ?? []).filter(column => column.header === header);
    expect(originalMatch).toHaveLength(1);
    expect(normalizedMatch).toHaveLength(1);
    expect(typeof normalizedMatch[0]!.value).toBe("string");
    return {
      sourceRecordId: record.id,
      sourceRecordHash: record.contentHash,
      coordinate: String(originalMatch[0]!.coordinate),
      header,
      valueHash: sha256Canonical(originalMatch[0]!.value),
    };
  };
  const capturedCellValue = async (sourceRecordId: string, header: string) => {
    const record = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } });
    const normalized = record.normalized as { columns?: Array<Record<string, unknown>> };
    const matches = (normalized.columns ?? []).filter(column => column.header === header);
    expect(matches).toHaveLength(1);
    expect(typeof matches[0]!.value).toBe("string");
    return matches[0]!.value as string;
  };
  const planBeforeDelivery = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, { snapshotId }));
  const motoDisposition = planBeforeDelivery.dispositions.find(row => row.sourceRecordId === motoRecord.id && row.dimension === "delivery");
  expect(motoDisposition?.sourceStatus).toBe("confirmed_pending");
  const [motoKeyCell, invoiceReferenceCell, invoiceKeyCell, invoiceAddressCell] = await Promise.all([
    sourceCell(motoRecord.id, "Id_Moto"),
    sourceCell(motoRecord.id, "N_Factura"),
    sourceCell(invoiceRecord.id, "N_factura"),
    sourceCell(invoiceRecord.id, "Domicilio"),
  ]);
  expect(await capturedCellValue(invoiceRecord.id, "N_factura")).toBe(source.invoiceNumber);
  expect(invoiceReferenceCell.valueHash).toBe(invoiceKeyCell.valueHash);
  const motoReference = await capturedCellValue(motoRecord.id, "N_Factura");
  const invoiceNumber = await capturedCellValue(invoiceRecord.id, "N_factura");
  expect(appSheetDeliveryInvoiceReferenceMatches(motoReference, invoiceNumber)).toBe(true);
  const currentSnapshotObject = await db.operationObject.findUniqueOrThrow({ where: { id: snapshotId } });
  await executeAs(actorIds.sourceReviewer, command(snapshotId, "AppSheetPendingDeliveryResolved", {
    sourceRecordId: motoDisposition!.sourceRecordId,
    sourceRecordHash: motoDisposition!.sourceRecordHash,
    reconciliationHash: motoDisposition!.reconciliationHash,
    mappingHash: motoDisposition!.mappingHash,
    sourceSpecHash: planBeforeDelivery.sourceSpecHash,
    invoiceRecordId: invoiceRecord.id,
    invoiceRecordHash: invoiceRecord.contentHash,
    motoKeyCell,
    invoiceReferenceCell,
    invoiceKeyCell,
    invoiceAddressCell,
    operationOrderId: orderId,
    operationOrderVersion: orderObject.version,
    operationOrderHash: orderHash,
    evidence: "Referencia sintética exacta y domicilio histórico conservado desde la factura.",
  }, currentSnapshotObject.version));

  const binding = {
    target: "isolated-test" as const,
    destinationIdentity,
    commitSha: sha256("synthetic browser pending-import destination commit").slice(0, 40),
    backupManifestHash: sha256("synthetic browser pending-import destination backup"),
    backupSnapshotAt: new Date().toISOString(),
  };
  const plan = await db.$transaction(tx => prepareAppSheetPendingImportPlan(tx, {
    snapshotId,
    binding: { ...binding, backupSnapshotAt: new Date(binding.backupSnapshotAt) },
  }));
  expect(plan.materializedSettlements).toHaveLength(1);
  expect(plan.materializedDeliveries).toHaveLength(1);
  const reviewObjectId = `appsheet-pending-plan-review:${plan.batchId}`;
  for (const delivery of plan.materializedDeliveries) {
    const [assignment, deliveryObject] = await Promise.all([
      db.deliveryAssignment.findUnique({ where: { id: delivery.destinationId }, select: { id: true } }),
      db.operationObject.findUnique({ where: { id: delivery.destinationId }, select: { id: true } }),
    ]);
    assertFixtureIdsAvailable(!assignment && !deliveryObject);
  }
  const existingBatch = await db.appSheetPendingImportBatch.findUnique({ where: { id: plan.batchId }, select: { id: true } });
  const existingReviewObject = await db.operationObject.findUnique({ where: { id: reviewObjectId }, select: { id: true } });
  assertFixtureIdsAvailable(!existingBatch && !existingReviewObject);
  const review = (reviewKind: "independent-pending-import-plan" | "independent-pending-import-destination") => ({
    schemaVersion: "appsheet-pending-import-review/v1" as const,
    reviewKind,
    captureId: plan.captureId,
    manifestHash: plan.manifestHash,
    dataHash: plan.dataHash,
    mappingHash: plan.mappingHash,
    sourceSpecHash: plan.sourceSpecHash,
    sourceCoverageHash: plan.sourceCoverageHash,
    dispositionHash: plan.dispositionHash,
    destinationHash: plan.destinationHash,
    destinationVersion: 1,
    projectionHash: plan.projectionHash,
    target: "isolated-test" as const,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    importer: actorIds.importer,
    reviewer: actorIds.destinationReviewer,
    approved: true as const,
    reviewedAt: new Date().toISOString(),
    findings: [],
  });
  const planReview = command(reviewObjectId, "AppSheetPendingImportPlanReviewed", {
    snapshotId,
    importerId: actorIds.importer,
    target: binding.target,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    review: review("independent-pending-import-plan"),
  }, 0);
  await executeAs(actorIds.destinationReviewer, planReview);
  const stage = command(plan.batchId, "AppSheetPendingImportStaged", {
    snapshotId,
    target: binding.target,
    destinationIdentity,
    commitSha: binding.commitSha,
    backupManifestHash: binding.backupManifestHash,
    backupSnapshotAt: binding.backupSnapshotAt,
    planReviewRequestId: planReview.requestId,
  }, 0);
  await executeAs(actorIds.importer, stage);

  return {
    actorIds,
    emails,
    snapshotId,
    batchId: plan.batchId,
    orderId,
    review: review("independent-pending-import-destination"),
  };
}

async function pendingEffects(orderId: string) {
  return {
    orders: await db.operationOrder.findMany({
      orderBy: { id: "asc" },
      select: { id: true, verifiedMinor: true, refundedMinor: true, financialState: true, fulfillmentState: true, totalMinor: true },
    }),
    orderObject: await db.operationObject.findUnique({ where: { id: orderId }, select: { kind: true, version: true } }),
    deliveryAssignments: await db.deliveryAssignment.count(),
    stockFacts: await db.stockFact.count(),
    stockBalances: await db.stockBalance.count(),
    ledgerEvents: await db.ledgerEvent.count(),
    cashEntries: await db.cashEntry.count(),
    collectionReports: await db.collectionReport.count(),
    payablePayments: await db.payablePayment.count(),
    invoiceSequences: await db.appSheetInvoiceSequence.count(),
    invoiceReservations: await db.appSheetInvoiceNumberReservation.count(),
  };
}

async function destinationState(batchId: string, snapshotId: string, orderId: string) {
  const batch = await db.appSheetPendingImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  return {
    snapshot: await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, select: { status: true, reviewedBy: true } }),
    batch: { status: batch.status, reviewedBy: batch.reviewedBy, destinationVersion: batch.destinationVersion, reviewEvidence: batch.reviewEvidence },
    batchObject: await db.operationObject.findUniqueOrThrow({ where: { id: batchId }, select: { kind: true, version: true } }),
    settlements: await db.appSheetLegacySettlement.findMany({
      where: { batchId }, orderBy: { id: "asc" },
      select: { id: true, status: true, reviewedBy: true, dueMinor: true, legacyPaidMinor: true, remainingMinor: true, currency: true },
    }),
    assignments: await db.deliveryAssignment.findMany({
      where: { orderId }, orderBy: { id: "asc" },
      select: { id: true, status: true, routeId: true, driverId: true, dispatchedAt: true, deliveredAt: true, address: true },
    }),
    receiptCount: await db.commandReceipt.count(),
    outboxCount: await db.operationOutbox.count(),
    auditCount: await db.operationAudit.count(),
    effects: await pendingEffects(orderId),
  };
}

async function createReceiptFailureTrigger(requestId: string) {
  const schema = new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "";
  expect(schema).toMatch(/^bombo_e2e_[a-z0-9_]+$/i);
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
  const token = randomUUID().replaceAll("-", "");
  const functionName = `synthetic_destination_fail_${token}`;
  const triggerName = `synthetic_destination_fail_${token}`;
  await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}"."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."requestId" = '${requestId}'::uuid THEN
        RAISE EXCEPTION 'synthetic destination review rollback';
      END IF;
      RETURN NEW;
    END;
  $$`);
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${schema}"."CommandReceipt"
      FOR EACH ROW EXECUTE FUNCTION "${schema}"."${functionName}"()`);
  } catch (error) {
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${functionName}"()`);
    throw error;
  }
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."CommandReceipt"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${schema}"."${functionName}"()`);
  };
}

function destinationEnvelope(batchId: string, expectedVersion: number, review: Record<string, unknown>) {
  return { command: "AppSheetPendingImportDestinationReviewed", targetId: batchId, expectedVersion, data: { review } };
}

async function selectReviewFile(page: Page, filename: string, envelope: unknown) {
  const previewResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname.includes("/review-preview");
  });
  await page.getByLabel("Plan JSON de revisión (máximo 100 KB)").setInputFiles({
    name: filename,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(envelope), "utf8"),
  });
  return previewResponse;
}

test("la revisión de destino AppSheet muestra vista previa, bloquea planes obsoletos y materializa una sola entrega pendiente", async ({ page }) => {
  test.setTimeout(150_000);
  const scenario = await createDestinationReviewScenario();
  const commandPosts: Array<Record<string, unknown>> = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/operations/commands") {
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        commandPosts.push(body);
      } catch {
        // Request observation is best-effort; it must not change the UI test outcome.
      }
    }
  });
  const stateBefore = await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId);

  await loginAs(page, scenario.emails.writerOnly);
  await expect(page.getByRole("heading", { name: "Revisión humana autenticada" })).toHaveCount(0);
  await expect(page.getByLabel("Plan JSON de revisión (máximo 100 KB)")).toHaveCount(0);
  const writerPreview = await page.request.get(`/api/operations/appsheet-pending-imports/${encodeURIComponent(scenario.batchId)}/review-preview`);
  expect(writerPreview.status()).toBe(403);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  await loginAs(page, scenario.emails.destinationReviewer);
  await expect(page.getByRole("heading", { name: "Revisión humana autenticada" })).toBeVisible();
  const submit = page.getByRole("button", { name: "Revisar destino y crear entregas pendientes", exact: true });

  const wrongHashPlan = destinationEnvelope(scenario.batchId, 1, {
    ...scenario.review,
    destinationHash: sha256("hash distinto del destino vigente"),
  });
  const wrongHashPreview = await selectReviewFile(page, "synthetic-wrong-destination-hash.json", wrongHashPlan);
  expect((await wrongHashPreview).status()).toBe(200);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("El plan no coincide con el destino actual", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  const staleVersionPlan = destinationEnvelope(scenario.batchId, 0, scenario.review);
  const staleVersionPreview = await selectReviewFile(page, "synthetic-stale-destination-version.json", staleVersionPlan);
  expect((await staleVersionPreview).status()).toBe(200);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("El plan no coincide con el destino actual", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  const failingPreview = async (route: Route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Synthetic preview unavailable" }),
  });
  const previewPath = `**/api/operations/appsheet-pending-imports/${scenario.batchId}/review-preview`;
  await page.route(previewPath, failingPreview);
  const unavailablePreview = await selectReviewFile(page, "synthetic-preview-unavailable.json",
    destinationEnvelope(scenario.batchId, 1, scenario.review));
  expect((await unavailablePreview).status()).toBe(503);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("No se pudo verificar el destino", { exact: false })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);
  await page.unroute(previewPath, failingPreview);

  const validEnvelope = destinationEnvelope(scenario.batchId, 1, scenario.review);
  const validPreview = await selectReviewFile(page, "synthetic-current-destination-review.json", validEnvelope);
  const previewResponse = await validPreview;
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json() as Record<string, unknown>;
  expect(preview).toMatchObject({
    batchId: scenario.batchId,
    status: "staged",
    expectedVersion: 1,
    captureId: scenario.review.captureId,
    manifestHash: scenario.review.manifestHash,
    dataHash: scenario.review.dataHash,
    projectionHash: scenario.review.projectionHash,
    dispositionHash: scenario.review.dispositionHash,
    destinationHash: scenario.review.destinationHash,
    legacySettlementCount: 1,
    pendingDeliveryAssignmentCount: 1,
  });
  await expect(submit).toBeEnabled();
  await expect(page.getByText("La misma persona puede revisar el plan y el destino; debe ser distinta de quienes prepararon la carga o revisaron el origen y sus vínculos.", { exact: true })).toBeVisible();
  expect(commandPosts).toHaveLength(0);
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);

  let rollbackRequestId = "";
  const rollbackDestinationReview = async (route: Route) => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith("/api/operations/commands")) return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.command !== "AppSheetPendingImportDestinationReviewed") return route.continue();
    rollbackRequestId = String(body.requestId ?? "");
    const dropTrigger = await createReceiptFailureTrigger(rollbackRequestId);
    try {
      const response = await route.fetch();
      expect(response.status()).toBeGreaterThanOrEqual(500);
      await route.fulfill({ response });
    } finally {
      await dropTrigger();
    }
  };
  await page.route("**/api/operations/commands", rollbackDestinationReview);
  const rollbackResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") &&
    response.request().postDataJSON().command === "AppSheetPendingImportDestinationReviewed");
  await submit.click();
  const rollbackResponse = await rollbackResponsePromise;
  expect(rollbackResponse.status()).toBeGreaterThanOrEqual(500);
  await page.unroute("**/api/operations/commands", rollbackDestinationReview);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(submit).toBeEnabled();
  expect(rollbackRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await db.commandReceipt.findUnique({ where: { requestId: rollbackRequestId } })).toBeNull();
  expect(await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId)).toEqual(stateBefore);
  expect(commandPosts).toHaveLength(1);

  let firstAcknowledgementRequestId = "";
  let committedResponse: Record<string, unknown> | undefined;
  const loseDestinationAcknowledgement = async (route: Route) => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith("/api/operations/commands")) return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.command !== "AppSheetPendingImportDestinationReviewed") return route.continue();
    firstAcknowledgementRequestId = String(body.requestId ?? "");
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committedResponse = await response.json() as Record<string, unknown>;
    await route.abort("failed");
  };
  await page.route("**/api/operations/commands", loseDestinationAcknowledgement);
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("el mismo UUID mientras esta vista siga abierta");
  expect(committedResponse).toBeDefined();
  expect(commandPosts).toHaveLength(2);
  await page.unroute("**/api/operations/commands", loseDestinationAcknowledgement);

  const replayResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/operations/commands") &&
    response.request().postDataJSON().command === "AppSheetPendingImportDestinationReviewed");
  await submit.click();
  const replayResponse = await replayResponsePromise;
  expect(replayResponse.status()).toBe(200, await replayResponse.text());
  const replay = await replayResponse.json() as Record<string, unknown>;
  expect(replay.replay).toBe(true);
  expect(replay.requestId).toBe(firstAcknowledgementRequestId);
  expect(commandPosts).toHaveLength(3);
  expect(commandPosts[1]!.requestId).toBe(firstAcknowledgementRequestId);
  expect(commandPosts[2]!.requestId).toBe(firstAcknowledgementRequestId);

  const receipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: firstAcknowledgementRequestId } });
  expect(receipt.actorId).toBe(scenario.actorIds.destinationReviewer);
  expect(await db.operationOutbox.count({ where: { requestId: firstAcknowledgementRequestId } })).toBe(1);
  const requestAudits = await db.operationAudit.findMany({
    where: { requestId: firstAcknowledgementRequestId },
    select: { action: true, actorId: true, objectId: true },
  });
  expect(requestAudits).toHaveLength(2);
  expect(requestAudits).toEqual(expect.arrayContaining([
    { action: "AppSheetPendingImportDestinationReviewed", actorId: scenario.actorIds.destinationReviewer, objectId: scenario.batchId },
    { action: "appsheet.pending_import_destination_reviewed", actorId: scenario.actorIds.destinationReviewer, objectId: scenario.batchId },
  ]));
  expect(requestAudits.filter(row => row.action === "appsheet.pending_import_destination_reviewed")).toHaveLength(1);
  expect(await db.operationAudit.count({
    where: {
      objectId: scenario.batchId,
      action: "appsheet.pending_import_destination_reviewed",
    },
  })).toBe(1);
  const finalState = await destinationState(scenario.batchId, scenario.snapshotId, scenario.orderId);
  expect(finalState.snapshot.status).toBe("reviewed");
  expect(finalState.snapshot.reviewedBy).toBe(scenario.actorIds.sourceReviewer);
  expect(finalState.snapshot).toEqual(stateBefore.snapshot);
  expect(finalState.batch.status).toBe("reviewed");
  expect(finalState.batch.reviewedBy).toBe(scenario.actorIds.destinationReviewer);
  expect(finalState.batchObject).toEqual({ kind: "legacyImport", version: 2 });
  expect(finalState.settlements).toHaveLength(1);
  expect(finalState.settlements[0]).toMatchObject({
    status: "reviewed",
    reviewedBy: scenario.actorIds.destinationReviewer,
    dueMinor: 10_000n,
    legacyPaidMinor: 4_000n,
    remainingMinor: 6_000n,
    currency: "ARS",
  });
  expect(finalState.assignments).toHaveLength(1);
  expect(finalState.assignments[0]).toMatchObject({
    status: "pending",
    routeId: null,
    driverId: null,
    dispatchedAt: null,
    deliveredAt: null,
    address: expect.objectContaining({
      address: "Dirección histórica sintética 123, Salta",
      source: "appsheet-pending-import",
    }),
  });
  expect(finalState.effects).toEqual({ ...stateBefore.effects, deliveryAssignments: stateBefore.effects.deliveryAssignments + 1 });
  await expect(page.getByRole("status")).toContainText("1 asignación de entrega pendiente");
});
