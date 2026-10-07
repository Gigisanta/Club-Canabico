import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("AppSheet invoices preserve exact line values and independent moto metadata while confirming atomically", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async t => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  const schema = `appsheet_invoice_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: "appsheet-invoice-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-invoice.test",
  });

  const { db } = await import("../server/db.js");
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const ownerId = "appsheet-invoice-owner";
    const deniedId = "appsheet-invoice-denied";
    const scopedId = "appsheet-invoice-scoped";
    const driverId = "appsheet-invoice-driver";
    const passwordText = randomUUID();
    const password = await bcrypt.hash(passwordText, 4);
    for (const [id, role] of [[ownerId, "owner"], [deniedId, "viewer"], [scopedId, "viewer"], [driverId, "viewer"]] as const) {
      await db.user.create({
        data: { id, name: "Synthetic invoice actor", email: `${id}@appsheet-invoice.test`, password, role },
      });
    }
    await db.operationAccess.create({
      data: { userId: scopedId, profile: "commercial", capabilities: ["orders.write"], scope: { memberIds: ["invoice-other-member"] } },
    });
    await db.operationAccess.create({
      data: { userId: driverId, profile: "driver", enabled: true, capabilities: ["delivery.report", "collections.report"] },
    });

    const memberId = "appsheet-invoice-member";
    const otherMemberId = "invoice-other-member";
    const unverifiedMemberId = "appsheet-invoice-unverified-member";
    await db.operationMember.create({ data: { id: memberId, name: "Synthetic member", address: {}, preferences: {} } });
    await db.operationMember.create({ data: { id: otherMemberId, name: "Other synthetic member", address: {}, preferences: {} } });
    await db.operationMember.create({ data: { id: unverifiedMemberId, name: "Unverified synthetic member", address: {}, preferences: {} } });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const validUntil = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await db.memberPermission.create({
      data: { memberId, kind: "operations", status: "verified", validFrom: today, validUntil },
    });

    const skuId = "appsheet-invoice-sku";
    const locationId = "appsheet-invoice-location";
    const lotId = "appsheet-invoice-lot";
    const balanceId = "appsheet-invoice-balance";
    await db.catalogSku.create({ data: { id: skuId, code: skuId, name: "Synthetic product", variety: "Fixture", category: "Fixture", unit: "g" } });
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic location" } });
    await db.inventoryLot.create({
      data: { id: lotId, skuId, label: "Synthetic lot", unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: new Date() },
    });
    await db.stockBalance.create({ data: { id: balanceId, lotId, locationId, custodianId: ownerId, unit: "g", quantity: "100", reserved: "0" } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://appsheet-invoice.test";
    const cookies: Record<string, string> = {};

    async function call(path: string, actor = ownerId, body?: unknown) {
      return fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function login(id: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@appsheet-invoice.test`, password: passwordText }),
      });
      assert.equal(response.status, 200, await response.text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    async function send(request: CommandEnvelope, actor = ownerId) {
      const response = await call("/operations/commands", actor, request);
      return { request, response, body: await response.json() as Record<string, any> };
    }
    async function command(request: CommandEnvelope, actor = ownerId) {
      const result = await send(request, actor);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      return result;
    }

    await login(ownerId);
    await login(deniedId);
    await login(scopedId);
    await login(driverId);

    const invoiceDate = today;
    const invoiceData = (options: { preorder?: boolean; lineTotal?: string; quantity?: string; withMoto?: boolean; lineId?: string } = {}) => ({
      memberId,
      invoiceNumber: "APP-2026-1042",
      invoiceDate,
      currency: "ARS",
      address: { street: "Calle sintética 123", city: "Salta" },
      note: "Aclaración de factura sintética",
      productPaymentMethod: "cash",
      lines: options.lineTotal === undefined && options.quantity === undefined && options.preorder
        ? []
        : [{ id: options.lineId ?? `appsheet-line-${randomUUID()}`, skuId, date: "2026-10-04", scale: "escala-3", quantity: options.quantity ?? "3", totalMinor: options.lineTotal ?? "1201" }],
      ...(options.withMoto ? {
        moto: {
          deliveryDate: "2026-10-06",
          paymentMethod: "mercado_pago",
          serviceType: "CABA",
          destination: "Av. San Martín 100",
          clientTariffMinor: "700",
          adminTariffMinor: "99",
          totalTariffMinor: "5050",
          notes: "Aclaración de moto sintética",
        },
      } : {}),
      preorder: options.preorder ?? false,
    });

    await t.test("capability and member scope reject before creating any invoice rows", async () => {
      for (const [actor, member, expectedCode] of [
        [deniedId, memberId, "CAPABILITY_REQUIRED"],
        [scopedId, memberId, "MEMBER_SCOPE"],
      ] as const) {
        const targetId = `appsheet-denied-${randomUUID()}`;
        const request = envelope(targetId, "InvoiceSaved", invoiceData({ withMoto: true, preorder: false }));
        const response = await call("/operations/commands", actor, request);
        const body = await response.json() as { code?: string };
        assert.equal(response.status, 403, JSON.stringify(body));
        assert.equal(body.code, expectedCode);
        assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
        assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
        assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
        assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
        assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      }
    });

    await t.test("unverified member rejects a confirmed invoice and rolls all tentative writes back", async () => {
      const targetId = `appsheet-unverified-${randomUUID()}`;
      const request = envelope(targetId, "InvoiceSaved", { ...invoiceData(), memberId: unverifiedMemberId });
      const response = await call("/operations/commands", ownerId, request);
      const body = await response.json() as { code?: string };
      assert.equal(response.status, 423, JSON.stringify(body));
      assert.equal(body.code, "MEMBER_PERMISSION_PENDING");
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
    });

    await t.test("unknown transfer formulas are rejected instead of being treated as editable charges", async () => {
      const targetId = `appsheet-transfer-unknown-${randomUUID()}`;
      const data = {
        ...invoiceData({ withMoto: true }),
        productTransferMinor: "17",
        moto: { ...(invoiceData({ withMoto: true }) as any).moto, transferMinor: "31" },
      };
      const request = envelope(targetId, "InvoiceSaved", data);
      const response = await call("/operations/commands", ownerId, request);
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /productTransferMinor|transferMinor/);
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
    });

    await t.test("save preserves the explicit non-divisible line total and independent product/moto fields", async () => {
      const [ledgerEventsBefore, ledgerLegsBefore, collectionsBefore, cashBefore] = await Promise.all([
        db.ledgerEvent.count(), db.ledgerLeg.count(), db.collectionReport.count(), db.cashEntry.count(),
      ]);
      const targetId = `appsheet-success-${randomUUID()}`;
      const request = envelope(targetId, "InvoiceSaved", invoiceData({ withMoto: true, lineId: "appsheet-line-1042" }));
      const saved = await command(request);
      assert.equal(saved.body.result.commercialState, "confirmed");
      assert.equal(saved.body.result.quoteFrozen, true);
      assert.equal(saved.body.result.deliveryId !== null, true);
      assert.equal(saved.body.replay, undefined);
      assert.deepEqual(await Promise.all([
        db.ledgerEvent.count(), db.ledgerLeg.count(), db.collectionReport.count(), db.cashEntry.count(),
      ]), [ledgerEventsBefore, ledgerLegsBefore, collectionsBefore, cashBefore]);

      const detailResponse = await call(`/operations/orders/${targetId}`);
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json() as any;
      assert.equal(detail.order.subtotalMinor, null);
      assert.equal(detail.order.capturedProductMinor, "1201");
      assert.equal(detail.order.subtotalCalculationState, "pending_definition");
      assert.equal(detail.order.deliveryMinor, "700");
      assert.equal(detail.order.surchargeMinor, "0");
      assert.equal(detail.order.financialState, "unpaid");
      assert.equal(detail.order.verifiedMinor, "0");
      assert.equal(detail.order.quote.invoiceNumber, "APP-2026-1042");
      assert.equal(detail.order.quote.invoiceDate, invoiceDate);
      assert.equal(detail.order.quote.note, "Aclaración de factura sintética");
      assert.equal(detail.order.quote.capturedBaseMinor, "1901");
      assert.equal(detail.order.quote.totalMinor, null);
      assert.equal(detail.order.quote.totalCalculationState, "pending_definition");
      assert.equal(detail.order.quote.lines[0].id, "appsheet-line-1042");
      assert.equal(detail.order.quote.lines[0].date, "2026-10-04");
      assert.equal(detail.order.quote.lines[0].scale, "escala-3");
      assert.equal(detail.order.quote.lines[0].explicitTotalMinor, "1201");
      assert.equal(detail.order.lines[0].revenueMinor, "1201");
      assert.equal(detail.order.lines[0].referenceMinor, "1201");
      assert.equal(detail.order.quote.paymentComponents.products.paymentMethod, "cash");
      assert.equal(detail.order.quote.paymentComponents.products.transferMinor, null);
      assert.equal(detail.order.quote.paymentComponents.products.transferCalculationState, "pending_definition");
      assert.equal(detail.order.quote.paymentComponents.products.totalMinor, "1201");
      assert.equal(detail.order.quote.moto.deliveryDate, "2026-10-06");
      assert.equal(detail.order.quote.moto.paymentMethod, "mercado_pago");
      assert.equal(detail.order.quote.moto.serviceType, "CABA");
      assert.equal(detail.order.quote.moto.destination, "Av. San Martín 100");
      assert.equal(detail.order.quote.moto.notes, "Aclaración de moto sintética");
      assert.equal(detail.order.quote.moto.clientTariffMinor, "700");
      assert.equal(detail.order.quote.moto.adminTariffMinor, "99");
      assert.equal(detail.order.quote.moto.totalTariffMinor, "5050");
      assert.equal(detail.order.quote.paymentComponents.moto.paymentMethod, "mercado_pago");
      assert.equal(detail.order.quote.paymentComponents.moto.transferMinor, null);
      assert.equal(detail.order.quote.paymentComponents.moto.transferCalculationState, "pending_definition");
      assert.equal(detail.order.quote.paymentComponents.moto.adminTariffMinor, "99");
      assert.equal(detail.order.quote.paymentComponents.moto.totalTariffMinor, "5050");
      assert.equal(detail.reservations.length, 1);
      assert.equal(detail.reservations[0].quantity, "3");
      assert.equal(detail.deliveries.length, 1);
      assert.equal(detail.deliveries[0].id, saved.body.result.deliveryId);
      assert.equal(detail.deliveries[0].address.motoDestination, "Av. San Martín 100");
      assert.equal(detail.deliveries[0].address.motoDeliveryDate, "2026-10-06");

      const storedCompatibilityOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } });
      assert.equal(storedCompatibilityOrder.totalMinor.toString(), "1901");
      assert.equal(detail.order.totalMinor, null);
      assert.equal(detail.order.capturedBaseMinor, "1901");
      assert.equal(detail.order.totalCalculationState, "pending_definition");

      const deliveryId = saved.body.result.deliveryId as string;
      await db.deliveryAssignment.update({ where: { id: deliveryId }, data: { driverId, status: "assigned" } });
      const deviceId = randomUUID();
      await db.operationDevice.create({ data: { id: deviceId, userId: driverId, name: "Synthetic certified device", storageCertified: true, storageCertifiedAt: new Date() } });
      const manifestResponse = await call(`/delivery/manifests/current?deviceId=${deviceId}`, driverId);
      assert.equal(manifestResponse.status, 200, await manifestResponse.clone().text());
      const manifest = await manifestResponse.json() as { leaseId: string; assignments: Array<{ orderId: string }> };
      assert.deepEqual(manifest.assignments, []);

      // A device can still hold an earlier lease that contained the assignment.
      await db.offlineLease.update({ where: { id: manifest.leaseId }, data: { assignments: [deliveryId] } });
      const offlineCollectionId = `appsheet-offline-receipt-${randomUUID()}`;
      const offlineReport = envelope(offlineCollectionId, "CollectionReported", {
        orderId: targetId, deliveryId, method: "cash", currency: "ARS", amountMinor: "500", custodianId: driverId,
        evidence: { source: "synthetic-stale-offline-lease" },
      });
      const syncResponse = await call("/delivery/sync", driverId, {
        leaseId: manifest.leaseId, deviceId, events: [{ ...offlineReport, sequence: 1 }],
      });
      assert.equal(syncResponse.status, 200);
      const syncBody = await syncResponse.json() as { results: Array<{ status: string; code?: string }> };
      assert.equal(syncBody.results[0]?.status, "rejected");
      assert.equal(syncBody.results[0]?.code, "INVOICE_TOTAL_DEFINITION_PENDING");
      assert.equal(await db.collectionReport.findUnique({ where: { id: offlineCollectionId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: offlineReport.requestId } }), 0);

      const revisionRequest = envelope(targetId, "OrderQuoteRevisionAccepted", {
        quote: {
          items: [{ id: `revision-line-${randomUUID()}`, skuId, quantity: "3", manualUnitPrice: "1", manualReason: "No reemplazar el total explícito AppSheet" }],
          packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
          promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
        },
        acceptance: { reference: "generic-revision-should-not-overwrite" }, reason: "Attempted generic quote revision",
      }, 1);
      // The InvoiceSaved receipt already confirms this object at version 1.
      const revisionRejected = await send(revisionRequest);
      assert.equal(revisionRejected.response.status, 409, JSON.stringify(revisionRejected.body));
      assert.equal(revisionRejected.body.code, "INVOICE_COMMAND_MISMATCH");
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 1);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
      assert.equal(await db.commandReceipt.count({ where: { requestId: revisionRequest.requestId } }), 0);

      const reportedCollectionId = `appsheet-reported-cash-${randomUUID()}`;
      const reportedRequest = envelope(reportedCollectionId, "CollectionReported", {
        orderId: targetId, method: "cash", currency: "ARS", amountMinor: "2500", evidence: { source: "synthetic-received-cash" },
      });
      const ledgerEventsBeforeReport = await db.ledgerEvent.count();
      const reported = await command(reportedRequest);
      assert.equal(reported.body.result.effect, "reported_only");
      assert.equal(reported.body.result.report.status, "reported");
      assert.equal(await db.ledgerEvent.count(), ledgerEventsBeforeReport);

      const verifyRequest = envelope(reportedCollectionId, "CollectionVerified", {
        accountId: "not-looked-up-before-total-gate", evidence: { source: "synthetic-verification-attempt" },
      }, 1);
      const verifyRejected = await send(verifyRequest);
      assert.equal(verifyRejected.response.status, 423, JSON.stringify(verifyRejected.body));
      assert.equal(verifyRejected.body.code, "INVOICE_TOTAL_DEFINITION_PENDING");
      const retainedReport = await db.collectionReport.findUniqueOrThrow({ where: { id: reportedCollectionId } });
      assert.equal(retainedReport.status, "reported");
      assert.equal(await db.ledgerEvent.count(), ledgerEventsBeforeReport);
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).verifiedMinor.toString(), "0");
      assert.equal(await db.commandReceipt.count({ where: { requestId: verifyRequest.requestId } }), 0);

      const creditCollectionId = `appsheet-blocked-credit-report-${randomUUID()}`;
      const creditReported = await command(envelope(creditCollectionId, "CollectionReported", {
        orderId: targetId, method: "cash", currency: "ARS", amountMinor: "200", evidence: { source: "synthetic-pending-credit-source" },
      }));
      assert.equal(creditReported.body.result.effect, "reported_only");
      const creditId = `appsheet-blocked-credit-${randomUUID()}`;
      await db.memberCredit.create({ data: { id: creditId, memberId, collectionId: creditCollectionId, currency: "ARS", amountMinor: 200n, treatment: "member_credit" } });
      await db.operationObject.create({ data: { id: creditId, kind: "credit", version: 1, createdBy: ownerId } });
      const applyCreditRequest = envelope(creditId, "MemberCreditApplied", {
        orderId: targetId, amountMinor: "100", evidence: { source: "synthetic-credit-application" },
      }, 1);
      const creditRejected = await send(applyCreditRequest);
      assert.equal(creditRejected.response.status, 423, JSON.stringify(creditRejected.body));
      assert.equal(creditRejected.body.code, "INVOICE_TOTAL_DEFINITION_PENDING");
      assert.equal((await db.memberCredit.findUniqueOrThrow({ where: { id: creditId } })).resolvedMinor.toString(), "0");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).verifiedMinor.toString(), "0");
      assert.equal(await db.commandReceipt.count({ where: { requestId: applyCreditRequest.requestId } }), 0);

      const refundRequest = envelope(targetId, "OrderRefunded", {
        accountId: "not-looked-up-before-total-gate", amountMinor: "100", lines: [], deliveryMinor: "0", surchargeMinor: "0",
        reason: "No cash refund before total definition", evidence: { source: "synthetic-refund-attempt" },
      }, 1);
      const refundRejected = await send(refundRequest);
      assert.equal(refundRejected.response.status, 423, JSON.stringify(refundRejected.body));
      assert.equal(refundRejected.body.code, "INVOICE_TOTAL_DEFINITION_PENDING");
      assert.equal(await db.ledgerEvent.count(), ledgerEventsBeforeReport);
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).refundedMinor.toString(), "0");
      assert.equal(await db.commandReceipt.count({ where: { requestId: refundRequest.requestId } }), 0);

      const appContext = await (await call("/operations/context")).json() as { commands: Array<{ command: string; kind: string }> };
      assert.ok(appContext.commands.some(item => item.command === "InvoiceTotalsConfirmed" && item.kind === "order"));
      const invalidTotals = [
        { actor: deniedId, data: { currency: "ARS", productsTotalMinor: "1500", motoClientTotalMinor: "800", evidence: { note: "Synthetic refusal" } }, status: 403, code: "CAPABILITY_REQUIRED" },
        { actor: ownerId, data: { currency: "USD", productsTotalMinor: "1500", motoClientTotalMinor: "800", evidence: { note: "Synthetic wrong currency" } }, status: 422, code: "INVOICE_TOTAL_CURRENCY" },
        { actor: ownerId, data: { currency: "ARS", productsTotalMinor: "9223372036854775807", motoClientTotalMinor: "1", evidence: { note: "Synthetic overflow" } }, status: 422, code: "MONEY_RANGE" },
        { actor: ownerId, data: { currency: "ARS", productsTotalMinor: 1500.5, motoClientTotalMinor: "800", evidence: { note: "Synthetic non-minor amount" } }, status: 400, code: undefined },
      ] as const;
      for (const invalid of invalidTotals) {
        const invalidRequest = envelope(targetId, "InvoiceTotalsConfirmed", invalid.data, 1);
        const rejected = await send(invalidRequest, invalid.actor);
        assert.equal(rejected.response.status, invalid.status, JSON.stringify(rejected.body));
        if (invalid.code) assert.equal(rejected.body.code, invalid.code);
        assert.equal(await db.commandReceipt.count({ where: { requestId: invalidRequest.requestId } }), 0);
      }
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 1);
      const unresolvedBeforeConfirmation = await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } });
      assert.equal((unresolvedBeforeConfirmation.quote as any).totalCalculationState, "pending_definition");
      assert.equal(unresolvedBeforeConfirmation.totalMinor.toString(), "1901");

      const rowsBeforeConfirmation = await db.operationOrderLine.findMany({ where: { orderId: targetId }, orderBy: { id: "asc" } });
      const reservationsBeforeConfirmation = await db.stockReservation.findMany({ where: { orderId: targetId }, orderBy: { id: "asc" } });
      const deliveryCountBeforeConfirmation = await db.deliveryAssignment.count({ where: { orderId: targetId } });
      const reservedBeforeConfirmation = (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved;
      const financialResolutionRequest = envelope(targetId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "1500", motoClientTotalMinor: "800",
        evidence: { note: "Importes transcritos de la factura sintética revisada por el staff" },
      }, 1);
      const financialResolution = await command(financialResolutionRequest);
      assert.equal(financialResolution.body.result.totalMinor, "2300");
      assert.equal(financialResolution.body.result.totalCalculationState, "staff_confirmed");
      assert.equal(financialResolution.body.result.totalCalculationSource, "staff_confirmation");
      const resolution = financialResolution.body.result.financialResolution;
      assert.deepEqual({
        kind: resolution.kind,
        currency: resolution.currency,
        productsTotalMinor: resolution.productsTotalMinor,
        motoClientTotalMinor: resolution.motoClientTotalMinor,
        totalMinor: resolution.totalMinor,
        evidence: resolution.evidence,
        actorId: resolution.actorId,
        quoteVersion: resolution.quoteVersion,
      }, {
        kind: "staff_confirmation", currency: "ARS", productsTotalMinor: "1500", motoClientTotalMinor: "800",
        totalMinor: "2300", evidence: { note: "Importes transcritos de la factura sintética revisada por el staff" },
        actorId: ownerId, quoteVersion: 1,
      });
      assert.match(resolution.snapshotHash, /^[a-f0-9]{64}$/);
      assert.ok(Number.isFinite(Date.parse(resolution.confirmedAt)));
      const resolvedDetailResponse = await call(`/operations/orders/${targetId}`);
      assert.equal(resolvedDetailResponse.status, 200);
      const resolvedDetail = await resolvedDetailResponse.json() as any;
      assert.equal(resolvedDetail.order.totalMinor, "2300");
      assert.equal(resolvedDetail.order.totalCalculationState, "staff_confirmed");
      assert.equal(resolvedDetail.order.totalCalculationSource, "staff_confirmation");
      assert.equal(resolvedDetail.order.financialResolution.snapshotHash, resolution.snapshotHash);
      assert.equal(resolvedDetail.order.subtotalMinor, null);
      assert.equal(resolvedDetail.order.subtotalCalculationState, "pending_definition");
      assert.equal(resolvedDetail.order.quote.totalMinor, "2300");
      assert.equal(resolvedDetail.order.quote.totalCalculationState, "staff_confirmed");
      assert.equal(resolvedDetail.order.quote.paymentComponents.products.totalMinor, "1500");
      assert.equal(resolvedDetail.order.quote.paymentComponents.moto.clientTotalMinor, "800");
      assert.equal(resolvedDetail.order.quote.moto.clientTariffMinor, "700");
      assert.equal(resolvedDetail.order.quote.moto.adminTariffMinor, "99");
      assert.equal(resolvedDetail.order.quote.moto.totalTariffMinor, "5050");
      assert.deepEqual(resolvedDetail.order.quote.input, unresolvedBeforeConfirmation.quote.input);
      assert.deepEqual(resolvedDetail.order.quote.lines, unresolvedBeforeConfirmation.quote.lines);
      assert.deepEqual(resolvedDetail.order.quote.moto, unresolvedBeforeConfirmation.quote.moto);
      assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: targetId }, orderBy: { id: "asc" } }), rowsBeforeConfirmation);
      assert.deepEqual(await db.stockReservation.findMany({ where: { orderId: targetId }, orderBy: { id: "asc" } }), reservationsBeforeConfirmation);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), deliveryCountBeforeConfirmation);
      assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(), reservedBeforeConfirmation.toString());
      assert.equal(await db.ledgerEvent.count(), ledgerEventsBeforeReport);
      assert.equal(await db.ledgerLeg.count(), ledgerLegsBefore);
      assert.equal(await db.collectionReport.count(), collectionsBefore + 2);
      assert.equal(await db.cashEntry.count(), cashBefore);

      const staleResolution = envelope(targetId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "1500", motoClientTotalMinor: "800", evidence: { note: "Synthetic stale attempt" },
      }, 1);
      const staleRejected = await send(staleResolution);
      assert.equal(staleRejected.response.status, 409, JSON.stringify(staleRejected.body));
      assert.equal(staleRejected.body.code, "VERSION_CONFLICT");
      assert.equal(await db.commandReceipt.count({ where: { requestId: staleResolution.requestId } }), 0);
      const secondResolution = envelope(targetId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "1500", motoClientTotalMinor: "800", evidence: { note: "Synthetic second close" },
      }, 2);
      const secondResolutionRejected = await send(secondResolution);
      assert.equal(secondResolutionRejected.response.status, 409, JSON.stringify(secondResolutionRejected.body));
      assert.equal(secondResolutionRejected.body.code, "INVOICE_TOTAL_ALREADY_RESOLVED");
      assert.equal(await db.commandReceipt.count({ where: { requestId: secondResolution.requestId } }), 0);
      const resolutionReplay = await command(financialResolutionRequest);
      assert.equal(resolutionReplay.body.replay, true);
      assert.equal(await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } }).then(row => row.totalMinor), 2300n);

      const resolvedManifestResponse = await call(`/delivery/manifests/current?deviceId=${deviceId}`, driverId);
      assert.equal(resolvedManifestResponse.status, 200, await resolvedManifestResponse.clone().text());
      const resolvedManifest = await resolvedManifestResponse.json() as { assignments: Array<{ orderId: string; totalMinor: string; currency: string }> };
      assert.deepEqual(resolvedManifest.assignments.map(item => ({ orderId: item.orderId, totalMinor: item.totalMinor, currency: item.currency })), [
        { orderId: targetId, totalMinor: "2300", currency: "ARS" },
      ]);

      const resolutionCashId = "appsheet-resolution-cash";
      await command(envelope(resolutionCashId, "AccountCreated", {
        name: "Synthetic invoice cash", currency: "ARS", kind: "cash", holder: "Fixture", purpose: "AppSheet exact ledger test",
      }));
      await command(envelope(resolutionCashId, "AccountVerified", { evidence: { note: "Synthetic account identity review" } }, 1));
      await command(envelope(resolutionCashId, "AccountOpeningApproved", {
        amountMinor: "0", preparedBy: scopedId, evidence: { note: "Synthetic zero opening approved by independent staff" },
      }, 2));
      const verifyAfterResolutionRequest = envelope(reportedCollectionId, "CollectionVerified", {
        accountId: resolutionCashId, evidence: { source: "synthetic-exact-ledger-after-close" },
      }, 1);
      const verifiedAfterResolution = await command(verifyAfterResolutionRequest);
      assert.equal(verifiedAfterResolution.body.result.appliedMinor, "2300");
      assert.equal(verifiedAfterResolution.body.result.excessMinor, "200");
      const collectionLedger = await db.ledgerEvent.findFirstOrThrow({
        where: { kind: "collection", sourceObjectId: reportedCollectionId }, include: { legs: true },
      });
      assert.equal(collectionLedger.legs.length, 1);
      assert.equal(collectionLedger.legs[0]!.accountId, resolutionCashId);
      assert.equal(collectionLedger.legs[0]!.currency, "ARS");
      assert.equal(collectionLedger.legs[0]!.amountMinor, 2500n);
      assert.equal((collectionLedger.metadata as any).appliedMinor, "2300");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).verifiedMinor, 2300n);
      const createdCredits = await db.memberCredit.findMany({ where: { collectionId: reportedCollectionId } });
      assert.equal(createdCredits.length, 1);
      assert.equal(createdCredits[0]!.id, verifiedAfterResolution.body.result.creditId);
      assert.equal(createdCredits[0]!.amountMinor, 200n);
      assert.equal(createdCredits[0]!.resolvedMinor, 0n);
      const verifiedReplay = await command(verifyAfterResolutionRequest);
      assert.equal(verifiedReplay.body.replay, true);
      assert.equal(await db.ledgerEvent.count({ where: { kind: "collection", sourceObjectId: reportedCollectionId } }), 1);
      assert.equal(await db.memberCredit.count({ where: { collectionId: reportedCollectionId } }), 1);
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).verifiedMinor, 2300n);

      const genericOrderId = `appsheet-total-generic-${randomUUID()}`;
      await command(envelope(genericOrderId, "OrderCreated", { memberId, channel: "local", currency: "ARS", address: {}, preorder: false }));
      const genericClose = envelope(genericOrderId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "100", motoClientTotalMinor: "0", evidence: { note: "Synthetic generic target" },
      }, 1);
      const genericCloseRejected = await send(genericClose);
      assert.equal(genericCloseRejected.response.status, 409, JSON.stringify(genericCloseRejected.body));
      assert.equal(genericCloseRejected.body.code, "INVOICE_COMMAND_MISMATCH");
      assert.equal(await db.commandReceipt.count({ where: { requestId: genericClose.requestId } }), 0);

      const replay = await command(request);
      assert.equal(replay.body.replay, true);
      assert.equal(await db.operationOrder.count({ where: { id: targetId } }), 1);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 1);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 1);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId, status: "active" } }), 1);
      const sideEffectsBeforeInvoiceReplay = await Promise.all([
        await db.ledgerEvent.count(), await db.ledgerLeg.count(), await db.collectionReport.count(), await db.cashEntry.count(),
      ]);
      assert.deepEqual(sideEffectsBeforeInvoiceReplay, [ledgerEventsBeforeReport + 2, ledgerLegsBefore + 2, collectionsBefore + 2, cashBefore]);
    });

    await t.test("stock shortage rolls invoice, reservation and moto delivery back together", async () => {
      const targetId = `appsheet-shortage-${randomUUID()}`;
      const request = envelope(targetId, "InvoiceSaved", invoiceData({ quantity: "101", lineTotal: "40400", withMoto: true }));
      const before = {
        orders: await db.operationOrder.count(),
        lines: await db.operationOrderLine.count(),
        reservations: await db.stockReservation.count(),
        deliveries: await db.deliveryAssignment.count(),
        reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      };
      const response = await call("/operations/commands", ownerId, request);
      const body = await response.json() as { code?: string };
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, "STOCK_SHORTAGE");
      assert.deepEqual({
        orders: await db.operationOrder.count(),
        lines: await db.operationOrderLine.count(),
        reservations: await db.stockReservation.count(),
        deliveries: await db.deliveryAssignment.count(),
        reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      }, before);
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
    });

    await t.test("minimal preorder remains editable, then confirmation rechecks and freezes its exact snapshot once", async () => {
      const targetId = `appsheet-preorder-${randomUUID()}`;
      const savedRequest = envelope(targetId, "InvoiceSaved", invoiceData({ preorder: true }));
      const saved = await command(savedRequest);
      assert.equal(saved.body.result.commercialState, "preorder");
      assert.equal(saved.body.result.quoteFrozen, false);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);

      const emptyConfirmation = envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "blank-preorder-rejected" } }, 1);
      const emptyRejected = await send(emptyConfirmation);
      assert.equal(emptyRejected.response.status, 409, JSON.stringify(emptyRejected.body));
      assert.equal(emptyRejected.body.code, "INVOICE_SNAPSHOT_INVALID");
      assert.equal(await db.commandReceipt.count({ where: { requestId: emptyConfirmation.requestId } }), 0);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 1);

      const completedData = invoiceData({ preorder: true, lineTotal: "1001", quantity: "2" });
      const updateRequest = envelope(targetId, "InvoiceUpdated", completedData, 1);
      const updated = await command(updateRequest);
      assert.equal(updated.body.result.commercialState, "preorder");
      assert.equal(updated.body.result.quoteFrozen, false);
      assert.equal(updated.body.result.quoteVersion, 2);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);

      const genericQuote = envelope(targetId, "OrderQuoted", {
        items: [{ id: `generic-line-${randomUUID()}`, skuId, quantity: "2", manualUnitPrice: "1", manualReason: "No reemplazar el total explícito AppSheet" }],
        packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
        promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
      }, 2);
      const genericRejected = await send(genericQuote);
      assert.equal(genericRejected.response.status, 409, JSON.stringify(genericRejected.body));
      assert.equal(genericRejected.body.code, "INVOICE_COMMAND_MISMATCH");
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 1);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
      assert.equal(await db.commandReceipt.count({ where: { requestId: genericQuote.requestId } }), 0);

      await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: { availability: "NO" } } });
      const unavailableConfirm = envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "availability-recheck" } }, 2);
      const unavailableRejected = await send(unavailableConfirm);
      assert.equal(unavailableRejected.response.status, 422, JSON.stringify(unavailableRejected.body));
      assert.equal(unavailableRejected.body.code, "ORDER_SKU_UNAVAILABLE");
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.commandReceipt.count({ where: { requestId: unavailableConfirm.requestId } }), 0);
      await db.catalogSku.update({ where: { id: skuId }, data: { appSheet: { availability: "Sí" } } });

      const storedOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } });
      const originalQuote = structuredClone(storedOrder.quote as Record<string, unknown>);
      await db.operationOrder.update({ where: { id: targetId }, data: { quote: { ...originalQuote, note: "Alteración directa" } } });
      const tamperedConfirm = envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "tampered-snapshot" } }, 2);
      const tamperedRejected = await send(tamperedConfirm);
      assert.equal(tamperedRejected.response.status, 409, JSON.stringify(tamperedRejected.body));
      assert.equal(tamperedRejected.body.code, "INVOICE_SNAPSHOT_CHANGED");
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.commandReceipt.count({ where: { requestId: tamperedConfirm.requestId } }), 0);
      await db.operationOrder.update({ where: { id: targetId }, data: { quote: originalQuote as any } });

      await db.memberPermission.updateMany({ where: { memberId, kind: "operations" }, data: { status: "pending" } });
      const confirmOnUpdateRequest = envelope(targetId, "InvoiceUpdated", invoiceData({ preorder: false, lineTotal: "1001", quantity: "2" }), 2);
      const updatePermissionRejected = await send(confirmOnUpdateRequest);
      assert.equal(updatePermissionRejected.response.status, 423, JSON.stringify(updatePermissionRejected.body));
      assert.equal(updatePermissionRejected.body.code, "MEMBER_PERMISSION_PENDING");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).commercialState, "preorder");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).totalMinor.toString(), "1001");
      assert.equal((await db.operationOrderLine.findMany({ where: { orderId: targetId } }))[0]?.revenueMinor.toString(), "1001");
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.commandReceipt.count({ where: { requestId: confirmOnUpdateRequest.requestId } }), 0);

      const permissionConfirm = envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "permission-recheck" } }, 2);
      const permissionRejected = await send(permissionConfirm);
      assert.equal(permissionRejected.response.status, 423, JSON.stringify(permissionRejected.body));
      assert.equal(permissionRejected.body.code, "MEMBER_PERMISSION_PENDING");
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).commercialState, "preorder");
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 2);
      assert.equal(await db.commandReceipt.count({ where: { requestId: permissionConfirm.requestId } }), 0);
      await db.memberPermission.updateMany({ where: { memberId, kind: "operations" }, data: { status: "verified" } });

      const confirmRequest = envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "preorder-completion" } }, 2);
      const confirmed = await command(confirmRequest);
      assert.equal(confirmed.body.result.commercialState, "confirmed");
      assert.equal(confirmed.body.result.quoteFrozen, true);
      assert.equal(confirmed.body.result.deliveryId, null);
      const detail = await (await call(`/operations/orders/${targetId}`)).json() as any;
      assert.equal(detail.order.quote.lines[0].explicitTotalMinor, "1001");
      assert.equal(detail.order.lines[0].revenueMinor, "1001");
      assert.equal(detail.order.lines[0].requested, "2");
      assert.equal(detail.reservations.length, 1);
      assert.equal(detail.reservations[0].quantity, "2");
      assert.equal(detail.deliveries.length, 0);

      const invalidNoMotoClose = envelope(targetId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "1001", motoClientTotalMinor: "1", evidence: { note: "Synthetic moto amount without moto" },
      }, 3);
      const noMotoRejected = await send(invalidNoMotoClose);
      assert.equal(noMotoRejected.response.status, 422, JSON.stringify(noMotoRejected.body));
      assert.equal(noMotoRejected.body.code, "INVOICE_MOTO_TOTAL_WITHOUT_MOTO");
      assert.equal(await db.commandReceipt.count({ where: { requestId: invalidNoMotoClose.requestId } }), 0);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: targetId } })).version, 3);

      const noMotoClose = envelope(targetId, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "1001", motoClientTotalMinor: "0", evidence: { note: "Synthetic product total confirmed by staff" },
      }, 3);
      const noMotoResolved = await command(noMotoClose);
      assert.equal(noMotoResolved.body.result.totalMinor, "1001");
      assert.equal(noMotoResolved.body.result.financialResolution.motoClientTotalMinor, "0");
      const noMotoDetail = await (await call(`/operations/orders/${targetId}`)).json() as any;
      assert.equal(noMotoDetail.order.totalMinor, "1001");
      assert.equal(noMotoDetail.order.quote.paymentComponents.products.totalMinor, "1001");
      assert.equal(noMotoDetail.order.quote.paymentComponents.moto, null);
      assert.equal(noMotoDetail.order.quote.moto, null);
      assert.equal(noMotoDetail.reservations.length, 1);
      assert.equal(noMotoDetail.deliveries.length, 0);

      const replay = await command(confirmRequest);
      assert.equal(replay.body.replay, true);
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId, status: "active" } }), 1);
      const secondConfirmation = await send(envelope(targetId, "InvoiceConfirmed", { acceptance: { reference: "second-confirmation" } }, 4));
      assert.equal(secondConfirmation.response.status, 409, JSON.stringify(secondConfirmation.body));
      assert.equal(secondConfirmation.body.code, "INVOICE_NOT_PREORDER");
      assert.equal(await db.deliveryAssignment.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.stockReservation.count({ where: { orderId: targetId, status: "active" } }), 1);
    });

    await t.test("explicit catalogue availability NO, inactive, and non-gram SKUs cannot be sold", async () => {
      const unavailableId = "appsheet-invoice-unavailable-sku";
      const inactiveId = "appsheet-invoice-inactive-sku";
      const discreteId = "appsheet-invoice-discrete-sku";
      await db.catalogSku.create({
        data: { id: unavailableId, code: unavailableId, name: "Unavailable fixture", variety: "Fixture", category: "Fixture", unit: "g", appSheet: { availability: "NO" } },
      });
      await db.catalogSku.create({
        data: { id: inactiveId, code: inactiveId, name: "Inactive fixture", variety: "Fixture", category: "Fixture", unit: "g", active: false },
      });
      await db.catalogSku.create({
        data: { id: discreteId, code: discreteId, name: "Discrete fixture", variety: "Fixture", category: "Fixture", unit: "ud" },
      });
      for (const [sku, code] of [[unavailableId, "ORDER_SKU_UNAVAILABLE"], [inactiveId, "ORDER_SKU_UNAVAILABLE"], [discreteId, "ORDER_SKU_UNAVAILABLE"]] as const) {
        const targetId = `appsheet-catalogue-${randomUUID()}`;
        const data = { ...invoiceData(), lines: [{ id: `line-${randomUUID()}`, skuId: sku, date: today, scale: "escala-1", quantity: "1", totalMinor: "100" }] };
        const rejected = await send(envelope(targetId, "InvoiceSaved", data));
        assert.equal(rejected.response.status, 422, JSON.stringify(rejected.body));
        assert.equal(rejected.body.code, code);
        assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
        assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
        assert.equal(await db.commandReceipt.count({ where: { requestId: rejected.request.requestId } }), 0);
      }
    });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
