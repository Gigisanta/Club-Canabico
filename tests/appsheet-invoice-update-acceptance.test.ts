import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { Prisma, PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../shared/operations/appsheet-history.js";
import {
  APPSHEET_INVOICE_RULE_VERSION_V1,
  APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1,
} from "../shared/operations/appsheet-invoice-rules.js";
import { canonicalJson } from "../shared/operations/exact.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("replacement invoices enforce AppSheet quantity and availability, acceptance, Moto fees and stock rollback", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const baseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(baseUrl.pathname, /^\/bombo_ui_(?:[a-z0-9_-]+)$/i, "usar una base sintética bombo_ui_ dedicada");
  baseUrl.searchParams.delete("schema");
  const schema = `invoice_update_acceptance_${randomUUID().replaceAll("-", "")}`;
  const scopedUrl = new URL(baseUrl);
  scopedUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: scopedUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: `invoice-update-test-${randomUUID()}-secret-more-than-32-characters`,
    ALLOWED_ORIGIN: "http://invoice-update.test",
  });

  const bootstrapDb = new PrismaClient({ datasourceUrl: baseUrl.toString() });
  let migrationDb: PrismaClient | undefined;
  let appDb: { $disconnect(): Promise<void> } | undefined;
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await bootstrapDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    migrationDb = new PrismaClient({ datasourceUrl: scopedUrl.toString() });
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await migrationDb.$executeRawUnsafe(statement);
    }
    await migrationDb.$disconnect();
    migrationDb = undefined;

    const { db } = await import("../server/db.js");
    appDb = db;
    const { app } = await import("../server/app.js");

    const ownerId = `invoice-update-owner-${randomUUID()}`;
    const memberId = `invoice-update-member-${randomUUID()}`;
    const skuId = `invoice-update-sku-${randomUUID()}`;
    const replacementSkuId = `invoice-update-replacement-sku-${randomUUID()}`;
    const locationId = `invoice-update-location-${randomUUID()}`;
    const lotId = `invoice-update-lot-${randomUUID()}`;
    const balanceId = `invoice-update-balance-${randomUUID()}`;
    const replacementLotId = `invoice-update-replacement-lot-${randomUUID()}`;
    const replacementBalanceId = `invoice-update-replacement-balance-${randomUUID()}`;
    const passwordText = randomUUID();
    const password = await bcrypt.hash(passwordText, 4);
    await db.user.create({ data: {
      id: ownerId,
      name: "Synthetic invoice owner",
      email: `${ownerId}@invoice-update.test`,
      password,
      role: "owner",
    } });
    await db.operationMember.create({ data: { id: memberId, name: "Synthetic native member", address: {}, preferences: {} } });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const validUntil = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await db.memberPermission.create({ data: {
      memberId,
      kind: "operations",
      status: "verified",
      validFrom: today,
      validUntil,
    } });
    await db.catalogSku.create({ data: { id: skuId, code: skuId, name: "Synthetic invoice product", variety: "Fixture", category: "Fixture", unit: "g", appSheet: { availability: "Sí" } } });
    await db.catalogSku.create({ data: { id: replacementSkuId, code: replacementSkuId, name: "Synthetic replacement product", variety: "Fixture", category: "Fixture", unit: "g", appSheet: { availability: "Sí" } } });
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic invoice location" } });
    await db.inventoryLot.create({ data: {
      id: lotId,
      skuId,
      label: "Synthetic invoice lot",
      unit: "g",
      unitCost: "1",
      costCurrency: "ARS",
      receivedAt: new Date(),
    } });
    await db.stockBalance.create({ data: {
      id: balanceId,
      lotId,
      locationId,
      custodianId: ownerId,
      unit: "g",
      quantity: "100",
      reserved: "0",
    } });
    await db.inventoryLot.create({ data: {
      id: replacementLotId,
      skuId: replacementSkuId,
      label: "Synthetic replacement lot",
      unit: "g",
      unitCost: "1",
      costCurrency: "ARS",
      receivedAt: new Date(),
    } });
    await db.stockBalance.create({ data: {
      id: replacementBalanceId,
      lotId: replacementLotId,
      locationId,
      custodianId: ownerId,
      unit: "g",
      quantity: "100",
      reserved: "0",
    } });

    // This local fixture satisfies only the invoice-number reservation FK and
    // stable-capture check. It is not cutover or source-verification evidence.
    const captureNow = new Date(Date.now() - 60_000);
    const manifestHash = digest(`synthetic-invoice-update-capture-${randomUUID()}`);
    const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
    const spreadsheetId = `synthetic-spreadsheet-${captureId}`;
    const dataHash = digest(`synthetic-invoice-update-data-${randomUUID()}`);
    await db.appSheetCaptureManifest.create({ data: {
      captureId,
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sourceId: spreadsheetId,
      spreadsheetId,
      metadataHash: digest("synthetic metadata"),
      headersHash: digest("synthetic headers"),
      manifestHash,
      dataHash,
      definitionHash: null,
      stability: { stable: true },
      firstReadAt: new Date(captureNow.getTime() - 4_000),
      verificationStartedAt: new Date(captureNow.getTime() - 3_000),
      verificationCompletedAt: new Date(captureNow.getTime() - 2_000),
      cutoffAt: captureNow,
      dataCoverage: { syntheticTestFixture: true },
      pageManifest: [],
      definitionCoverage: Prisma.DbNull,
      dataSheetCount: 0,
      dataPageCount: 0,
      dataRecordCount: 0,
      dataFormulaCount: 0,
      dataUnresolvedFormulaCount: 0,
      definitionTableCount: null,
      definitionColumnCount: null,
      definitionSliceCount: null,
      definitionViewCount: null,
      definitionActionCount: null,
      definitionBotCount: null,
      definitionWorkflowRuleCount: null,
      definitionFormatRuleCount: null,
    } });
    const snapshotId = `synthetic-invoice-update-history-${randomUUID()}`;
    await db.legacyImportSnapshot.create({ data: {
      id: snapshotId,
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      filename: "synthetic-invoice-update-history",
      fileHash: manifestHash,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      status: "reviewed",
      createdBy: ownerId,
      reviewedBy: `${ownerId}-independent-fixture-reviewer`,
      reviewedAt: captureNow,
      controls: { syntheticTestFixture: true },
      coverage: { syntheticTestFixture: true },
      captureManifestId: captureId,
    } });
    await db.appSheetInvoiceSequence.create({ data: {
      namespace: captureId,
      captureId,
      manifestHash,
      dataHash,
      snapshotId,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      publicationFingerprint: digest("synthetic invoice publication"),
      sourceBindingHash: digest("synthetic invoice source binding"),
      lastValue: 40n,
      seededValue: 40n,
      invoiceRecordCount: 40,
      numberedInvoiceCount: 40,
      unnumberedInvoiceCount: 0,
      duplicateInvoiceNumberCount: 0,
      duplicateHiddenIdCount: 0,
      seedEvidence: { syntheticTestFixture: true },
      seededBy: ownerId,
      seededAt: captureNow,
    } });
    await db.operationAuthority.upsert({
      where: { id: "operations" },
      create: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: captureId },
      update: { mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: captureId },
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://invoice-update.test";
    let cookie = "";
    const loginResponse = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${ownerId}@invoice-update.test`, password: passwordText }),
    });
    assert.equal(loginResponse.status, 200, await loginResponse.text());
    cookie = loginResponse.headers.get("set-cookie")!.split(";")[0]!;

    const call = async (request: unknown) => {
      const response = await fetch(`${base}/operations/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { response, body: await response.json() as Record<string, any> };
    };
    const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0) => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    const input = (options: { quantity: string; preorder: boolean; skuId?: string; productPaymentMethod?: "cash" | "transfer" | "mercado_pago"; totalMinor?: string }) => ({
      memberId,
      invoiceDate: today,
      currency: "ARS",
      address: { city: "Salta" },
      note: "Synthetic acceptance-bound invoice",
      productPaymentMethod: options.productPaymentMethod ?? "transfer",
      lines: [{ id: `invoice-line-${randomUUID()}`, skuId: options.skuId ?? skuId, date: today, scale: "fixture", quantity: options.quantity, totalMinor: options.totalMinor ?? "10000" }],
      moto: {
        deliveryDate: today,
        paymentMethod: "mercado_pago",
        serviceType: "Fixture delivery",
        destination: "Synthetic destination",
        clientTariffMinor: "1000",
        adminTariffMinor: "100",
        totalTariffMinor: "1100",
        notes: "",
      },
      preorder: options.preorder,
    });
    const inputWithoutOptionalDefaults = (options: { quantity: string; preorder: boolean; skuId?: string; productPaymentMethod?: "cash" | "transfer" | "mercado_pago"; totalMinor?: string }) => {
      const value = input(options);
      return {
        memberId: value.memberId,
        invoiceDate: value.invoiceDate,
        currency: value.currency,
        productPaymentMethod: value.productPaymentMethod,
        lines: value.lines,
        preorder: value.preorder,
        moto: {
          deliveryDate: value.moto.deliveryDate,
          paymentMethod: value.moto.paymentMethod,
          serviceType: value.moto.serviceType,
          destination: value.moto.destination,
          clientTariffMinor: value.moto.clientTariffMinor,
          adminTariffMinor: value.moto.adminTariffMinor,
          totalTariffMinor: value.moto.totalTariffMinor,
        },
      };
    };
    const inputWithExplicitDefaults = (options: { quantity: string; preorder: boolean }) => {
      const value = input(options);
      return { ...value, address: {}, note: "", moto: { ...value.moto, notes: "" } };
    };
    const inputWithoutMoto = (options: { quantity: string; preorder: boolean; skuId?: string; totalMinor?: string }) => {
      const { moto: _moto, ...value } = input({ ...options, productPaymentMethod: "cash" });
      return value;
    };
    const countFinancialEffects = async () => ({
      ledgerEvents: await db.ledgerEvent.count(),
      ledgerLegs: await db.ledgerLeg.count(),
      cashEntries: await db.cashEntry.count(),
      collectionReports: await db.collectionReport.count(),
    });
    const readOrderState = async (orderId: string) => {
      const order = await db.operationOrder.findUniqueOrThrow({ where: { id: orderId } });
      const lines = await db.operationOrderLine.findMany({ where: { orderId }, orderBy: { id: "asc" } });
      const balance = await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } });
      const replacementBalance = await db.stockBalance.findUniqueOrThrow({ where: { id: replacementBalanceId } });
      return {
        order: {
          commercialState: order.commercialState,
          quoteVersion: order.quoteVersion,
          address: order.address,
          subtotalMinor: order.subtotalMinor.toString(),
          deliveryMinor: order.deliveryMinor.toString(),
          surchargeMinor: order.surchargeMinor.toString(),
          totalMinor: order.totalMinor.toString(),
          quote: order.quote,
        },
        objectVersion: (await db.operationObject.findUniqueOrThrow({ where: { id: orderId } })).version,
        lines: lines.map(line => ({ id: line.id, skuId: line.skuId, requested: line.requested, revenueMinor: line.revenueMinor.toString() })),
        stockQuantity: balance.quantity.toString(),
        reserved: balance.reserved.toString(),
        replacementStockQuantity: replacementBalance.quantity.toString(),
        replacementReserved: replacementBalance.reserved.toString(),
        reservations: await db.stockReservation.count({ where: { orderId } }),
        deliveries: await db.deliveryAssignment.count({ where: { orderId } }),
        sequenceValue: (await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } })).lastValue.toString(),
      };
    };

    const readReservationCounters = async () => ({
      stockQuantity: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).quantity.toString(),
      reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      replacementStockQuantity: (await db.stockBalance.findUniqueOrThrow({ where: { id: replacementBalanceId } })).quantity.toString(),
      replacementReserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: replacementBalanceId } })).reserved.toString(),
      stockReservations: await db.stockReservation.count(),
      deliveries: await db.deliveryAssignment.count(),
      sequenceValue: (await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } })).lastValue.toString(),
    });
    const assertRejectedNewInvoiceHasNoEffects = async (
      targetId: string,
      request: { requestId: string },
      countersBefore: Awaited<ReturnType<typeof readReservationCounters>>,
    ) => {
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: targetId } }), null);
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId: request.requestId } }), null);
      assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
      assert.deepEqual(await readReservationCounters(), countersBefore);
    };

    const fractionalId = `invoice-update-fractional-${randomUUID()}`;
    const beforeFractional = await readReservationCounters();
    const fractionalRequest = envelope(fractionalId, "InvoiceSaved", input({ quantity: "0.5", preorder: true }));
    const fractional = await call(fractionalRequest);
    assert.equal(fractional.response.status, 422, JSON.stringify(fractional.body));
    assert.equal(fractional.body.code, "APP_SHEET_INVOICE_QUANTITY_RANGE");
    await assertRejectedNewInvoiceHasNoEffects(fractionalId, fractionalRequest, beforeFractional);

    await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: {} } });
    const unknownAvailabilityId = `invoice-update-availability-unknown-${randomUUID()}`;
    const beforeUnknownAvailability = await readReservationCounters();
    const unknownAvailabilityRequest = envelope(unknownAvailabilityId, "InvoiceSaved", input({ quantity: "1", preorder: true }));
    const unknownAvailability = await call(unknownAvailabilityRequest);
    assert.equal(unknownAvailability.response.status, 422, JSON.stringify(unknownAvailability.body));
    assert.equal(unknownAvailability.body.code, "APP_SHEET_SKU_AVAILABILITY_UNVERIFIED");
    await assertRejectedNewInvoiceHasNoEffects(unknownAvailabilityId, unknownAvailabilityRequest, beforeUnknownAvailability);
    await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: { availability: "Sí" } } });

    const inactiveSkuId = `invoice-update-inactive-sku-${randomUUID()}`;
    const inactiveSkuSaveRequest = envelope(inactiveSkuId, "InvoiceSaved", input({ quantity: "1", preorder: true }));
    const inactiveSkuSaved = await call(inactiveSkuSaveRequest);
    assert.equal(inactiveSkuSaved.response.status, 200, JSON.stringify(inactiveSkuSaved.body));
    const inactiveSkuSavedState = await readOrderState(inactiveSkuId);
    await db.catalogSku.update({ where: { id: skuId }, data: { active: false, unit: "kg" } });
    const beforeInactiveSkuConfirm = await readReservationCounters();
    const inactiveSkuConfirmRequest = envelope(inactiveSkuId, "InvoiceConfirmed", { acceptance: { note: "Registro sintético del operador" } }, 1);
    const inactiveSkuConfirm = await call(inactiveSkuConfirmRequest);
    assert.equal(inactiveSkuConfirm.response.status, 422, JSON.stringify(inactiveSkuConfirm.body));
    assert.equal(inactiveSkuConfirm.body.code, "ORDER_SKU_UNAVAILABLE");
    assert.deepEqual(await readOrderState(inactiveSkuId), inactiveSkuSavedState, "el historial se verifica aunque el SKU ya esté inactivo, pero no se confirma con el SKU actual inactivo");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: inactiveSkuConfirmRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: inactiveSkuConfirmRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: inactiveSkuConfirmRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeInactiveSkuConfirm);

    const replacementSkuUpdateRequest = envelope(inactiveSkuId, "InvoiceUpdated", {
      ...inputWithoutOptionalDefaults({ quantity: "1", preorder: false, skuId: replacementSkuId }),
      acceptance: { note: "El operador registró la cotización vigente para el producto disponible" },
    }, 1);
    const replacementSkuUpdated = await call(replacementSkuUpdateRequest);
    assert.equal(replacementSkuUpdated.response.status, 200, JSON.stringify(replacementSkuUpdated.body));
    const replacementSkuState = await readOrderState(inactiveSkuId);
    assert.equal(replacementSkuState.order.commercialState, "confirmed");
    assert.equal(replacementSkuState.lines.length, 1);
    assert.equal(replacementSkuState.lines[0]!.skuId, replacementSkuId);
    assert.equal(replacementSkuState.reserved, "0", "la SKU histórica inactiva no consume stock al reemplazar la cotización");
    assert.equal(replacementSkuState.replacementReserved, "1", "sólo se reserva la SKU de la cotización actual");
    assert.equal(replacementSkuState.reservations, 1);
    assert.equal(replacementSkuState.deliveries, 1);
    assert.equal((replacementSkuState.order.quote as Record<string, any>).invoiceNumber, (inactiveSkuSavedState.order.quote as Record<string, any>).invoiceNumber, "editar conserva el número histórico reservado");
    await db.catalogSku.update({ where: { id: skuId }, data: { active: true, unit: "g" } });

    const boundaryId = `invoice-update-upper-bound-${randomUUID()}`;
    const boundarySaveRequest = envelope(boundaryId, "InvoiceSaved", input({ quantity: "99", preorder: true }));
    const boundarySaved = await call(boundarySaveRequest);
    assert.equal(boundarySaved.response.status, 200, JSON.stringify(boundarySaved.body));
    assert.equal((await readOrderState(boundaryId)).order.commercialState, "preorder");
    const boundaryUpdateRequest = envelope(boundaryId, "InvoiceUpdated", input({ quantity: "99", preorder: true }), 1);
    const boundaryUpdated = await call(boundaryUpdateRequest);
    assert.equal(boundaryUpdated.response.status, 200, JSON.stringify(boundaryUpdated.body));
    const boundaryState = await readOrderState(boundaryId);
    assert.equal(boundaryState.order.commercialState, "preorder");
    assert.equal(boundaryState.order.quoteVersion, 2);
    assert.equal(boundaryState.reserved, "0");
    assert.equal(boundaryState.reservations, 0);
    assert.equal(boundaryState.deliveries, 0);

    const preorderId = `invoice-update-preorder-${randomUUID()}`;
    const savedRequest = envelope(preorderId, "InvoiceSaved", input({ quantity: "1", preorder: true }));
    const saved = await call(savedRequest);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    const savedState = await readOrderState(preorderId);
    const savedQuote = savedState.order.quote as Record<string, any>;
    assert.equal(savedQuote.appSheetFormula.schemaVersion, "appsheet-invoice-calculation/v2");
    assert.equal(savedQuote.appSheetFormula.ruleVersion, "appsheet-invoice-rules/v2");
    assert.equal(savedQuote.appSheetFormula.results.Transferencia, "500");
    assert.equal(savedQuote.appSheetFormula.results.Transferencia_moto, "50");
    assert.equal(savedQuote.appSheetFormula.results.Tarifa_Moto_Cliente, "1050");
    assert.equal(savedQuote.appSheetFormula.results.Subtotal_Cliente_Moto, "1050");
    assert.equal(savedQuote.appSheetFormula.results.Total_Facturado, "11550");
    assert.equal(savedQuote.paymentComponents.products.totalMinor, "10500");
    assert.equal(savedQuote.paymentComponents.moto.clientSubtotalMinor, "1050");
    assert.equal(savedState.order.deliveryMinor, "1050");
    assert.equal(savedState.order.surchargeMinor, "500");
    assert.equal(savedState.order.totalMinor, "11550");
    assert.equal(savedState.order.commercialState, "preorder");
    assert.equal(savedState.objectVersion, 1);
    assert.equal(savedState.reserved, "0");
    assert.equal(savedState.reservations, 0);
    assert.equal(savedState.deliveries, 0);

    const memberEligibilityCountersBefore = await readReservationCounters();
    await db.operationMember.update({ where: { id: memberId }, data: {
      sourceSystem: "synthetic-unreviewed-source",
      sourceId: `unreviewed-${randomUUID()}`,
    } });
    const memberEligibilityRequest = envelope(preorderId, "InvoiceConfirmed", { acceptance: { note: "No confirmar una identidad no revisada" } }, 1);
    const memberEligibility = await call(memberEligibilityRequest);
    assert.equal(memberEligibility.response.status, 423, JSON.stringify(memberEligibility.body));
    assert.equal(memberEligibility.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    assert.deepEqual(await readOrderState(preorderId), savedState);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: memberEligibilityRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: memberEligibilityRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: memberEligibilityRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), memberEligibilityCountersBefore);
    await db.operationMember.update({ where: { id: memberId }, data: { sourceSystem: null, sourceId: null, legacyCustomerId: null } });

    const financialEffectsBefore = await countFinancialEffects();
    const unacceptedRequest = envelope(preorderId, "InvoiceUpdated", input({ quantity: "1", preorder: false }), 1);
    const unaccepted = await call(unacceptedRequest);
    assert.equal(unaccepted.response.status, 400, JSON.stringify(unaccepted.body));
    assert.match(String(unaccepted.body.error), /aceptación explícita/i);
    assert.deepEqual(await readOrderState(preorderId), savedState, "rechazar antes de reemplazar la cotización o reservar stock");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: unacceptedRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: unacceptedRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: unacceptedRequest.requestId } }), 0);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore);

    const beforeOutOfRangeUpdate = await readReservationCounters();
    const outOfRangeUpdateRequest = envelope(preorderId, "InvoiceUpdated", input({ quantity: "100", preorder: true }), 1);
    const outOfRangeUpdate = await call(outOfRangeUpdateRequest);
    assert.equal(outOfRangeUpdate.response.status, 422, JSON.stringify(outOfRangeUpdate.body));
    assert.equal(outOfRangeUpdate.body.code, "APP_SHEET_INVOICE_QUANTITY_RANGE");
    assert.deepEqual(await readOrderState(preorderId), savedState);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: outOfRangeUpdateRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: outOfRangeUpdateRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: outOfRangeUpdateRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeOutOfRangeUpdate);

    await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: { availability: "No" } } });
    const availabilityUpdateRequest = envelope(preorderId, "InvoiceUpdated", {
      ...inputWithoutOptionalDefaults({ quantity: "1", preorder: false }),
      acceptance: { note: "Aceptación sintética sólo para verificar disponibilidad actual" },
    }, 1);
    const availabilityUpdate = await call(availabilityUpdateRequest);
    assert.equal(availabilityUpdate.response.status, 422, JSON.stringify(availabilityUpdate.body));
    assert.equal(availabilityUpdate.body.code, "APP_SHEET_SKU_AVAILABILITY_UNVERIFIED");
    assert.deepEqual(await readOrderState(preorderId), savedState, "la verificación histórica tolera el cambio de disponibilidad, pero la cotización nueva no se escribe");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: availabilityUpdateRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: availabilityUpdateRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: availabilityUpdateRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeOutOfRangeUpdate);

    const confirmAvailabilityRequest = envelope(preorderId, "InvoiceConfirmed", { acceptance: { note: "Aceptación sintética para la comprobación actual" } }, 1);
    const confirmAvailability = await call(confirmAvailabilityRequest);
    assert.equal(confirmAvailability.response.status, 422, JSON.stringify(confirmAvailability.body));
    assert.equal(confirmAvailability.body.code, "APP_SHEET_SKU_AVAILABILITY_UNVERIFIED");
    assert.deepEqual(await readOrderState(preorderId), savedState, "la confirmación vuelve a validar la fuente antes de reservar stock");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: confirmAvailabilityRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: confirmAvailabilityRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: confirmAvailabilityRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeOutOfRangeUpdate);
    await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: { availability: "Sí" } } });

    // Recreate the exact persisted shape from the deployed v1 rule version.
    // This synthetic historical fixture lets the command boundary prove that
    // an old Moto-transfer quote cannot be confirmed with its missing 5% fee.
    const currentQuote = savedState.order.quote as Record<string, any>;
    const currentFormula = currentQuote.appSheetFormula as Record<string, any>;
    const { Transferencia_moto: _oldMotoTransfer, Subtotal_Cliente_Moto: _oldMotoSubtotal, ...legacyResults } = currentFormula.results;
    const { motoTransfer: _oldMotoCalculation, ...legacyFormula } = currentFormula;
    const legacyMotoComponent = { ...currentQuote.paymentComponents.moto } as Record<string, unknown>;
    delete legacyMotoComponent.transferMinor;
    delete legacyMotoComponent.clientSubtotalMinor;
    legacyMotoComponent.transferCalculationState = "pending_definition";
    const legacyQuote = {
      ...currentQuote,
      deliveryMinor: "1000",
      totalMinor: "11500",
      appSheetFormula: {
        ...legacyFormula,
        schemaVersion: "appsheet-invoice-calculation/v1",
        ruleVersion: APPSHEET_INVOICE_RULE_VERSION_V1,
        sourceExpressions: APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1,
        results: { ...legacyResults, Tarifa_Moto_Cliente: "1000", Total_Facturado: "11500" },
      },
      paymentComponents: { ...currentQuote.paymentComponents, moto: legacyMotoComponent },
    };
    await db.operationOrder.update({ where: { id: preorderId }, data: { quote: legacyQuote, deliveryMinor: 1000n, totalMinor: 11500n } });
    const savedReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: savedRequest.requestId } });
    const savedResponse = savedReceipt.response as Record<string, any>;
    const legacySnapshotHash = createHash("sha256").update(canonicalJson(legacyQuote), "utf8").digest("hex");
    await db.commandReceipt.update({ where: { requestId: savedRequest.requestId }, data: {
      response: { ...savedResponse, result: { ...savedResponse.result, snapshotHash: legacySnapshotHash } },
    } });
    const legacyV1State = await readOrderState(preorderId);
    const v1ConfirmRequest = envelope(preorderId, "InvoiceConfirmed", { acceptance: { note: "No confirmar la tarifa v1 incompleta" } }, 1);
    const v1Confirm = await call(v1ConfirmRequest);
    assert.equal(v1Confirm.response.status, 409, JSON.stringify(v1Confirm.body));
    assert.equal(v1Confirm.body.code, "APP_SHEET_MOTO_FORMULA_RECALCULATION_REQUIRED");
    assert.deepEqual(await readOrderState(preorderId), legacyV1State, "el rechazo v1 conserva el snapshot histórico intacto");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: v1ConfirmRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: v1ConfirmRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: v1ConfirmRequest.requestId } }), 0);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore);

    const rangedV1Id = `invoice-update-v1-out-of-range-${randomUUID()}`;
    const rangedV1SaveRequest = envelope(rangedV1Id, "InvoiceSaved", inputWithoutMoto({ quantity: "99", preorder: true, totalMinor: "990000" }));
    const rangedV1Saved = await call(rangedV1SaveRequest);
    assert.equal(rangedV1Saved.response.status, 200, JSON.stringify(rangedV1Saved.body));
    const rangedV1SavedState = await readOrderState(rangedV1Id);
    const rangedV1CurrentQuote = rangedV1SavedState.order.quote as Record<string, any>;
    const rangedV1CurrentFormula = rangedV1CurrentQuote.appSheetFormula as Record<string, any>;
    const rangedV1Line = { ...rangedV1CurrentQuote.lines[0], requested: "100", unitPrice: "99.000000000000" };
    const rangedV1Quote = {
      ...rangedV1CurrentQuote,
      input: { ...rangedV1CurrentQuote.input, lines: rangedV1CurrentQuote.input.lines.map((line: Record<string, unknown>) => ({ ...line, quantity: "100" })) },
      lines: [rangedV1Line],
      appSheetFormula: {
        ...rangedV1CurrentFormula,
        schemaVersion: "appsheet-invoice-calculation/v1",
        ruleVersion: APPSHEET_INVOICE_RULE_VERSION_V1,
        sourceExpressions: APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1,
        results: { ...rangedV1CurrentFormula.results, Cantidad_Gr: "100000" },
      },
    };
    await db.operationOrder.update({ where: { id: rangedV1Id }, data: { quote: rangedV1Quote } });
    await db.operationOrderLine.updateMany({ where: { orderId: rangedV1Id }, data: { requested: "100", unitPrice: "99.000000000000" } });
    const rangedV1Receipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: rangedV1SaveRequest.requestId } });
    const rangedV1Response = rangedV1Receipt.response as Record<string, any>;
    await db.commandReceipt.update({ where: { requestId: rangedV1SaveRequest.requestId }, data: {
      response: { ...rangedV1Response, result: { ...rangedV1Response.result, snapshotHash: digest(canonicalJson(rangedV1Quote)) } },
    } });
    const rangedV1State = await readOrderState(rangedV1Id);
    const beforeRangedV1Confirm = await readReservationCounters();
    const rangedV1ConfirmRequest = envelope(rangedV1Id, "InvoiceConfirmed", { acceptance: { note: "Evidencia sintética del operador" } }, 1);
    const rangedV1Confirm = await call(rangedV1ConfirmRequest);
    assert.equal(rangedV1Confirm.response.status, 422, JSON.stringify(rangedV1Confirm.body));
    assert.equal(rangedV1Confirm.body.code, "APP_SHEET_INVOICE_QUANTITY_RANGE", "v1 válida se vuelve a validar contra el rango actual antes de confirmar");
    assert.deepEqual(await readOrderState(rangedV1Id), rangedV1State, "el rechazo conserva intacto el snapshot histórico v1");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: rangedV1ConfirmRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: rangedV1ConfirmRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: rangedV1ConfirmRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeRangedV1Confirm);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore);

    const directConfirmId = `invoice-update-direct-confirm-${randomUUID()}`;
    const directSaveRequest = envelope(directConfirmId, "InvoiceSaved", inputWithoutMoto({ quantity: "1", preorder: true }));
    const directSaved = await call(directSaveRequest);
    assert.equal(directSaved.response.status, 200, JSON.stringify(directSaved.body));
    const directSavedState = await readOrderState(directConfirmId);
    const directSavedReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: directSaveRequest.requestId } });
    const directSavedResponse = directSavedReceipt.response as Record<string, any>;
    const directConfirmRequest = envelope(directConfirmId, "InvoiceConfirmed", { acceptance: { note: "El operador registra la cotización revisada" } }, 1);
    const directConfirm = await call(directConfirmRequest);
    assert.equal(directConfirm.response.status, 200, JSON.stringify(directConfirm.body));
    const directConfirmedState = await readOrderState(directConfirmId);
    const directConfirmedQuote = directConfirmedState.order.quote as Record<string, any>;
    assert.equal(directConfirmedState.order.commercialState, "confirmed");
    assert.equal(directConfirmedState.reservations, 1);
    assert.equal(directConfirmedState.deliveries, 0);
    assert.equal(directConfirmedQuote.acceptance.note, "El operador registra la cotización revisada");
    assert.equal(directConfirmedQuote.acceptance.acceptedBy, ownerId);
    assert.equal(directConfirmedQuote.acceptance.quoteVersion, 1);
    assert.equal(directConfirmedQuote.acceptance.snapshotHash, directSavedResponse.result.snapshotHash);
    assert.ok(Number.isFinite(Date.parse(directConfirmedQuote.acceptance.acceptedAt)));
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore, "confirmar no emite cobros ni asienta caja");

    const authorityObject = await db.operationObject.findUnique({ where: { id: "operations" }, select: { version: true } });
    const suspendReplacementRequest = envelope("operations", "AuthoritySuspended", {
      reason: "Synthetic lifecycle transition before legacy invoice compatibility coverage",
    }, authorityObject?.version ?? 0);
    const suspendReplacement = await call(suspendReplacementRequest);
    assert.equal(suspendReplacement.response.status, 200, JSON.stringify(suspendReplacement.body));
    const suspendedAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.equal(suspendedAuthority.mode, "shadow");
    assert.equal(suspendedAuthority.cutoverProfile, "appsheet-replacement");
    await db.operationAuthority.update({ where: { id: "operations" }, data: { cutoverProfile: "legacy", mode: "active" } });
    const legacyCompatibleId = `invoice-update-legacy-compatible-${randomUUID()}`;
    const legacyCompatibleSaveRequest = envelope(legacyCompatibleId, "InvoiceSaved", inputWithoutMoto({ quantity: "1", preorder: true }));
    const legacyCompatibleSave = await call(legacyCompatibleSaveRequest);
    assert.equal(legacyCompatibleSave.response.status, 200, JSON.stringify(legacyCompatibleSave.body));
    const legacyCompatibleState = await readOrderState(legacyCompatibleId);
    const legacyCompatibleQuote = legacyCompatibleState.order.quote as Record<string, unknown>;
    assert.equal(Object.hasOwn(legacyCompatibleQuote, "appSheetFormula"), false);
    assert.equal((legacyCompatibleQuote as Record<string, unknown>).invoiceNumber, null, "el historial legacy conserva su numeración sin asignación automática");
    const legacyCompatibleReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: legacyCompatibleSaveRequest.requestId } });
    const legacyCompatibleResponse = legacyCompatibleReceipt.response as Record<string, any>;
    const legacyCompatibleConfirmRequest = envelope(legacyCompatibleId, "InvoiceConfirmed", { acceptance: { note: "Evidencia operativa del flujo legacy" } }, 1);
    const legacyCompatibleConfirm = await call(legacyCompatibleConfirmRequest);
    assert.equal(legacyCompatibleConfirm.response.status, 200, JSON.stringify(legacyCompatibleConfirm.body));
    const legacyCompatibleConfirmed = await readOrderState(legacyCompatibleId);
    const legacyCompatibleConfirmedQuote = legacyCompatibleConfirmed.order.quote as Record<string, any>;
    assert.equal(legacyCompatibleConfirmed.order.commercialState, "confirmed", "el perfil legacy mantiene su compatibilidad");
    assert.equal(legacyCompatibleConfirmedQuote.acceptance.acceptedBy, ownerId);
    assert.equal(legacyCompatibleConfirmedQuote.acceptance.quoteVersion, 1);
    assert.equal(legacyCompatibleConfirmedQuote.acceptance.snapshotHash, legacyCompatibleResponse.result.snapshotHash);

    const pendingLegacyId = `invoice-update-legacy-pending-${randomUUID()}`;
    const pendingLegacySaveRequest = envelope(pendingLegacyId, "InvoiceSaved", inputWithoutMoto({ quantity: "1", preorder: true }));
    const pendingLegacySave = await call(pendingLegacySaveRequest);
    assert.equal(pendingLegacySave.response.status, 200, JSON.stringify(pendingLegacySave.body));
    const pendingLegacyState = await readOrderState(pendingLegacyId);
    const pendingLegacyQuote = pendingLegacyState.order.quote as Record<string, unknown>;
    assert.equal(Object.hasOwn(pendingLegacyQuote, "appSheetFormula"), false);
    assert.equal((pendingLegacyQuote as Record<string, unknown>).invoiceNumber, null);
    await db.operationAuthority.update({ where: { id: "operations" }, data: { cutoverProfile: "appsheet-replacement" } });
    const beforePendingLegacyConfirm = await readReservationCounters();
    const pendingLegacyConfirmRequest = envelope(pendingLegacyId, "InvoiceConfirmed", { acceptance: { note: "No reemplaza un cálculo pendiente" } }, 1);
    const pendingLegacyConfirm = await call(pendingLegacyConfirmRequest);
    assert.equal(pendingLegacyConfirm.response.status, 409, JSON.stringify(pendingLegacyConfirm.body));
    assert.equal(pendingLegacyConfirm.body.code, "INVOICE_SNAPSHOT_RECALCULATION_REQUIRED");
    assert.deepEqual(await readOrderState(pendingLegacyId), pendingLegacyState, "no recalcula, numera ni modifica el snapshot legacy al cambiar al perfil de reemplazo");
    assert.equal(await db.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: pendingLegacyId } }), null);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: pendingLegacyConfirmRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: pendingLegacyConfirmRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: pendingLegacyConfirmRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforePendingLegacyConfirm);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore);

    const unknownRuleQuote = { ...pendingLegacyQuote, appSheetFormula: { schemaVersion: "appsheet-invoice-calculation/v999", ruleVersion: "appsheet-invoice-rules/v999" } };
    await db.operationOrder.update({ where: { id: pendingLegacyId }, data: { quote: unknownRuleQuote } });
    const unknownRuleState = await readOrderState(pendingLegacyId);
    const beforeUnknownRuleConfirm = await readReservationCounters();
    const unknownRuleConfirmRequest = envelope(pendingLegacyId, "InvoiceConfirmed", { acceptance: { note: "Una versión no identificada también debe recalcularse" } }, 1);
    const unknownRuleConfirm = await call(unknownRuleConfirmRequest);
    assert.equal(unknownRuleConfirm.response.status, 409, JSON.stringify(unknownRuleConfirm.body));
    assert.equal(unknownRuleConfirm.body.code, "INVOICE_SNAPSHOT_RECALCULATION_REQUIRED");
    assert.deepEqual(await readOrderState(pendingLegacyId), unknownRuleState);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: unknownRuleConfirmRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: unknownRuleConfirmRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: unknownRuleConfirmRequest.requestId } }), 0);
    assert.deepEqual(await readReservationCounters(), beforeUnknownRuleConfirm);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore);
    assert.equal((await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).cutoverProfile, "appsheet-replacement");

    const acceptedInput = { ...inputWithoutOptionalDefaults({ quantity: "1", preorder: false }), acceptance: { note: "Aceptación sintética de la cotización mostrada" } };
    const acceptedRequest = envelope(preorderId, "InvoiceUpdated", acceptedInput, 1);
    const accepted = await call(acceptedRequest);
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.result.commercialState, "confirmed");
    assert.equal(accepted.body.result.reservations.length, 1);
    assert.ok(accepted.body.result.deliveryId);
    const confirmedState = await readOrderState(preorderId);
    const confirmedQuote = confirmedState.order.quote as Record<string, any>;
    assert.equal(confirmedState.order.commercialState, "confirmed");
    assert.equal(confirmedState.order.totalMinor, "11550");
    assert.equal(confirmedState.objectVersion, 2);
    assert.equal(confirmedState.reserved, "1");
    assert.equal(confirmedState.reservations, 1);
    assert.equal(confirmedState.deliveries, 1);
    assert.deepEqual(confirmedQuote.acceptance.note, "Aceptación sintética de la cotización mostrada");
    assert.equal(confirmedQuote.acceptance.acceptedBy, ownerId);
    assert.equal(confirmedQuote.acceptance.quoteVersion, 2);
    assert.match(confirmedQuote.acceptance.snapshotHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(confirmedState.order.address, {});
    assert.equal(confirmedQuote.note, "");
    assert.deepEqual(confirmedQuote.input.address, {});
    assert.equal(confirmedQuote.input.note, "");
    assert.equal(confirmedQuote.moto.notes, "");
    assert.equal(confirmedQuote.input.moto.notes, "");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: acceptedRequest.requestId } }) !== null, true);
    assert.deepEqual(await countFinancialEffects(), financialEffectsBefore, "confirmar una factura no registra cobros ni caja");

    const shortageId = `invoice-update-shortage-${randomUUID()}`;
    const shortageSaveRequest = envelope(shortageId, "InvoiceSaved", input({ quantity: "99", preorder: true }));
    const shortageSaved = await call(shortageSaveRequest);
    assert.equal(shortageSaved.response.status, 200, JSON.stringify(shortageSaved.body));
    const defaultFieldsUpdateRequest = envelope(shortageId, "InvoiceUpdated", inputWithExplicitDefaults({ quantity: "99", preorder: true }), 1);
    const defaultFieldsUpdate = await call(defaultFieldsUpdateRequest);
    assert.equal(defaultFieldsUpdate.response.status, 200, JSON.stringify(defaultFieldsUpdate.body));
    assert.equal((await readOrderState(shortageId)).stockQuantity, "100", "la cotización de 99 g se guarda mientras hay disponibilidad suficiente");
    // Model a later stock change between the saved quote and its confirmation.
    await db.stockBalance.update({ where: { id: balanceId }, data: { quantity: "50" } });
    const shortageBefore = await readOrderState(shortageId);
    const shortageQuote = shortageBefore.order.quote as Record<string, any>;
    assert.equal(shortageBefore.order.quoteVersion, 2);
    assert.deepEqual(shortageBefore.order.address, confirmedState.order.address);
    assert.equal(shortageQuote.note, confirmedQuote.note);
    assert.deepEqual(shortageQuote.input.address, confirmedQuote.input.address);
    assert.equal(shortageQuote.input.note, confirmedQuote.input.note);
    assert.equal(shortageQuote.moto.notes, confirmedQuote.moto.notes);
    assert.equal(shortageQuote.input.moto.notes, confirmedQuote.input.moto.notes);
    const effectsBeforeShortage = await countFinancialEffects();
    const shortageUpdateRequest = envelope(shortageId, "InvoiceUpdated", {
      ...inputWithoutOptionalDefaults({ quantity: "99", preorder: false }),
      acceptance: { note: "Aceptación sintética previa a validar disponibilidad" },
    }, 2);
    const shortage = await call(shortageUpdateRequest);
    assert.equal(shortage.response.status, 409, JSON.stringify(shortage.body));
    assert.equal(shortage.body.code, "STOCK_SHORTAGE");
    assert.deepEqual(await readOrderState(shortageId), shortageBefore, "el error de stock debe revertir el reemplazo del borrador y sus líneas");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: shortageUpdateRequest.requestId } }), null);
    assert.equal(await db.operationAudit.count({ where: { requestId: shortageUpdateRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: shortageUpdateRequest.requestId } }), 0);
    assert.deepEqual(await countFinancialEffects(), effectsBeforeShortage);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (appDb) await appDb.$disconnect();
    if (migrationDb) await migrationDb.$disconnect();
    if (schemaCreated) await bootstrapDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrapDb.$disconnect();
    for (const key of envKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});
