import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("commercial quotes, payable links and management-period coverage preserve command atomicity", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  // Future/past payment assertions share one fixed civil date across the HTTP journey.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T15:00:00-03:00") });
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /bombo_ui_(test|ci|optimization)/i, "usar una base descartable bombo_ui_");
  const schema = `finreg_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.DEMO_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "finance-regression-test-secret-more-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://finance-regression.local";

  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  let server: ReturnType<(typeof import("node:http"))["createServer"]> | undefined;
  try {
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const password = await bcrypt.hash("Only-a-local-finance-123", 4);
    for (const [id, role] of [["owner", "owner"], ["reviewer", "admin"], ["scoped", "admin"]] as const) {
      await db.user.create({ data: { id, name: id, email: `${id}@finance-regression.local`, password, role } });
    }
    await db.operationAccess.createMany({ data: [
      { userId: "reviewer", profile: "finance", capabilities: ["imports.review", "payables.write", "orders.write"] },
      { userId: "scoped", profile: "finance", capabilities: ["imports.review"], scope: { memberIds: [] } },
    ] });
    await db.supplier.create({ data: { id: "supplier", name: "Synthetic supplier", key: "finance-regression-supplier" } });
    await db.operationMember.create({ data: { id: "member", name: "Synthetic member", address: {}, preferences: {} } });
    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const proof = { reference: "synthetic-finance-regression" };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const cookies: Record<string, string> = {};

    async function login(actor: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://finance-regression.local", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${actor}@finance-regression.local`, password: "Only-a-local-finance-123" }),
      });
      assert.equal(response.status, 200);
      cookies[actor] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function envelope(targetId: string, command: string, data: Record<string, unknown>): Promise<CommandEnvelope> {
      return {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId,
        command,
        data,
        expectedVersion: (await db.operationObject.findUnique({ where: { id: targetId } }))?.version ?? 0,
        occurredAt: new Date().toISOString(),
      };
    }
    async function send(actor: string, targetId: string, command: string, data: Record<string, unknown>, occurredAt?: string) {
      const request = await envelope(targetId, command, data);
      if (occurredAt) request.occurredAt = occurredAt;
      const response = await fetch(`${base}/operations/commands`, {
        method: "POST",
        headers: { Cookie: cookies[actor], Origin: "http://finance-regression.local", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { request, response, body: await response.json() as Record<string, any> };
    }
    async function command(actor: string, targetId: string, name: string, data: Record<string, unknown>, occurredAt?: string) {
      const result = await send(actor, targetId, name, data, occurredAt);
      assert.equal(result.response.status, 200, `${name} ${targetId}: ${JSON.stringify(result.body)}`);
      return result.body;
    }
    async function reject(actor: string, targetId: string, name: string, data: Record<string, unknown>, status: number, code: string) {
      const result = await send(actor, targetId, name, data);
      assert.equal(result.response.status, status, JSON.stringify(result.body));
      assert.equal(result.body.code, code);
      assert.equal(await db.commandReceipt.count({ where: { requestId: result.request.requestId } }), 0, "el rechazo no debe guardar receipt");
      assert.equal(await db.operationOutbox.count({ where: { requestId: result.request.requestId } }), 0, "el rechazo no debe emitir outbox");
      assert.equal(await db.operationAudit.count({ where: { requestId: result.request.requestId } }), 0, "el rechazo no debe auditar una escritura");
      return result;
    }

    for (const actor of ["owner", "reviewer", "scoped"]) await login(actor);
    try {
      await command("owner", "sku", "CatalogSkuCreated", { code: "FIN-REG-1", name: "Synthetic unit", variety: "Synthetic", category: "Test", unit: "ud", minQuantity: "0", minVarieties: 1, evidence: proof });

      const policy = async (id: string, version: number, deliveryBps: number) => {
        await command("owner", id, "PricePolicyProposed", {
          name: "Synthetic method rates", version, currency: "ARS", validFrom: today,
          definition: {
            tiers: [{ skuId: "sku", minQuantity: "1", unitPrice: "1000", scale: "single" }],
            paymentMethods: ["cash", "transfer"],
            paymentMethodRates: [
              { method: "cash", productSurchargeBps: 100, deliverySurchargeBps: deliveryBps },
              { method: "transfer", productSurchargeBps: 500, deliverySurchargeBps: 400 },
            ],
            segmentBenefits: { frequent: "100" }, deliverySegmentBenefits: { frequent: "250" }, evidence: proof,
          },
        });
        await command("owner", id, "PricePolicyApproved", { evidence: proof });
      };
      await t.test("method-rate matrices require every allowed method and reject disabled method keys", async () => {
        const definition = (rates: unknown[]) => ({
          tiers: [{ skuId: "sku", minQuantity: "1", unitPrice: "1000", scale: "single" }],
          paymentMethods: ["cash", "transfer"], paymentMethodRates: rates, evidence: proof,
        });
        for (const [id, rates] of [
          ["incomplete-method-rates", [{ method: "cash", productSurchargeBps: 100, deliverySurchargeBps: 200 }]],
          ["disabled-method-rates", [
            { method: "cash", productSurchargeBps: 100, deliverySurchargeBps: 200 },
            { method: "transfer", productSurchargeBps: 100, deliverySurchargeBps: 200 },
            { method: "card", productSurchargeBps: 100, deliverySurchargeBps: 200 },
          ]],
        ] as const) {
          const result = await send("owner", id, "PricePolicyProposed", {
            name: id, version: 1, currency: "ARS", validFrom: today, definition: definition(rates),
          });
          assert.equal(result.response.status, 400, JSON.stringify(result.body));
          assert.equal(await db.pricePolicy.findUnique({ where: { id } }), null);
          assert.equal(await db.commandReceipt.count({ where: { requestId: result.request.requestId } }), 0);
          assert.equal(await db.operationOutbox.count({ where: { requestId: result.request.requestId } }), 0);
          assert.equal(await db.operationAudit.count({ where: { requestId: result.request.requestId } }), 0);
        }
      });
      await policy("policy-a", 1, 100);
      await policy("policy-b", 2, 200);
      const quoteOrder = async (id: string) => command("owner", id, "OrderCreated", { memberId: "member", channel: "local", currency: "ARS" });

      await t.test("component payment rates and both benefit classes are frozen in the order quote", async () => {
        await quoteOrder("component-order");
        const result = await command("owner", "component-order", "OrderQuoted", {
          currency: "ARS", productPaymentMethod: "cash", deliveryPaymentMethod: "transfer", deliveryMinor: "10000",
          deliveryPolicyEvidence: proof,
          items: [{ id: "component-line", skuId: "sku", quantity: "1", policyId: "policy-a", scale: "single" }],
          segmentBenefit: { policyId: "policy-a", segment: "frequent", eligibilityEvidence: proof },
          deliveryBenefit: { policyId: "policy-a", segment: "frequent", eligibilityEvidence: proof },
        });
        const quote = result.result.quote;
        assert.deepEqual(quote.paymentComponents, {
          products: { paymentMethod: "cash", baseMinor: "100000", discountMinor: "100", surchargeMinor: "1000", totalMinor: "100900" },
          delivery: { paymentMethod: "transfer", baseMinor: "10000", discountMinor: "250", surchargeMinor: "400", totalMinor: "10150" },
        });
        assert.equal(quote.totalMinor, "111050");
        assert.equal(quote.deliveryDiscountMinor, "250");
        assert.equal(quote.segmentBenefitApplication.amountMinor, "100");
        assert.equal(quote.deliveryBenefitApplication.amountMinor, "250");
        const stored = await db.operationOrder.findUniqueOrThrow({ where: { id: "component-order" } });
        assert.equal((stored.quote as { paymentComponents: unknown }).paymentComponents !== undefined, true);
        assert.equal(stored.totalMinor, 111050n);
      });

      await t.test("a delivery benefit reduces recognized charges and the refundable delivery amount", async () => {
        // The quote above is created through the command API. Complete only the
        // synthetic fulfillment/payment fixtures needed to inspect its effects.
        await db.operationOrder.update({ where: { id: "component-order" }, data: {
          commercialState: "confirmed", fulfillmentState: "delivered", confirmedAt: new Date(), verifiedMinor: 111050n,
        } });
        await db.operationOrderLine.update({ where: { id: "component-line" }, data: { delivered: "1" } });
        const { queryOperationsReport } = await import("../server/operations/report-queries.js");
        const report = await queryOperationsReport("product-contribution", { from: today, to: today });
        assert.deepEqual((report.metrics as Record<string, unknown>).recognizedDeliveryAndSurchargeByCurrency,
          [{ currency: "ARS", minor: "11150" }], "the discounted delivery and both frozen surcharges must agree with the quote");
        await db.operationAccount.create({ data: {
          id: "refund-account", name: "Synthetic refund cash", currency: "ARS", kind: "cash", holder: "Fixture", purpose: "Regression",
          verified: true, openingApprovedBy: "reviewer", openingEvidence: proof,
        } });
        await db.ledgerEvent.create({ data: {
          id: "refund-opening", requestId: randomUUID(), kind: "opening", occurredAt: new Date(), actorId: "reviewer",
          sourceObjectId: "refund-account", description: "Synthetic verified opening", metadata: proof,
          legs: { create: [{ id: "refund-opening-leg", accountId: "refund-account", currency: "ARS", amountMinor: 111050n }] },
        } });
        const legCount = await db.ledgerLeg.count();
        const rejected = await reject("owner", "component-order", "OrderRefunded", {
          accountId: "refund-account", amountMinor: "10000", lines: [], deliveryMinor: "10000", reason: "Synthetic delivery refund", evidence: proof,
        }, 422, "REFUND_CHARGE_LIMIT");
        assert.equal(await db.commandReceipt.count({ where: { requestId: rejected.request.requestId } }), 0);
        assert.equal(await db.ledgerLeg.count(), legCount);
        assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "component-order" } })).refundedMinor, 0n);
        await command("owner", "component-order", "OrderRefunded", {
          accountId: "refund-account", amountMinor: "9750", lines: [], deliveryMinor: "9750", reason: "Synthetic net delivery refund", evidence: proof,
        });
        const after = await queryOperationsReport("product-contribution", { from: today, to: today });
        assert.deepEqual((after.metrics as Record<string, unknown>).recognizedDeliveryAndSurchargeByCurrency,
          [{ currency: "ARS", minor: "1400" }]);
        assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "component-order" } })).refundedDeliveryMinor, 9750n);
      });

      await t.test("legacy paymentMethod remains a fallback and policy-denied methods reject without writes", async () => {
        await quoteOrder("legacy-method-order");
        const accepted = await command("owner", "legacy-method-order", "OrderQuoted", {
          currency: "ARS", paymentMethod: "cash", deliveryMinor: "10000", deliveryPolicyEvidence: proof,
          items: [{ id: "legacy-method-line", skuId: "sku", quantity: "1", policyId: "policy-a", scale: "single" }],
        });
        assert.equal(accepted.result.quote.paymentComponents.products.paymentMethod, "cash");
        assert.equal(accepted.result.quote.paymentComponents.delivery.paymentMethod, "cash");
        assert.equal(accepted.result.quote.deliverySurchargeMinor, "100");
        await quoteOrder("denied-method-order");
        const before = await db.operationOrder.findUniqueOrThrow({ where: { id: "denied-method-order" } });
        await reject("owner", "denied-method-order", "OrderQuoted", {
          currency: "ARS", productPaymentMethod: "card", deliveryPaymentMethod: "cash", deliveryMinor: "10000", deliveryPolicyEvidence: proof,
          items: [{ id: "denied-method-line", skuId: "sku", quantity: "1", policyId: "policy-a", scale: "single" }],
        }, 422, "PAYMENT_POLICY");
        const after = await db.operationOrder.findUniqueOrThrow({ where: { id: "denied-method-order" } });
        assert.equal(after.version, before.version);
        assert.equal(after.quoteVersion, 0);
        assert.equal(await db.operationOrderLine.count({ where: { orderId: "denied-method-order" } }), 0);
      });

      await t.test("delivery surcharge selection is order-independent; ambiguous overrides are explicit and zero delivery is harmless", async () => {
        const data = (orderId: string, ids: string[], deliveryMinor: string, surcharge?: string, includeReason = true) => ({
          currency: "ARS", paymentMethod: "cash", deliveryMinor, ...(surcharge === undefined ? {} : { deliverySurchargeMinor: surcharge }),
          ...(surcharge === undefined || !includeReason ? {} : { surchargeOverrideReason: "Reviewed supplier quote" }),
          deliveryPolicyEvidence: proof,
          items: ids.map((id, index) => ({ id: `rate-${orderId}-line-${index}`, skuId: "sku", quantity: "1", policyId: id, scale: "single" })),
        });
        await quoteOrder("ambiguous-missing-order");
        await reject("owner", "ambiguous-missing-order", "OrderQuoted", data("ambiguous-missing-order", ["policy-a", "policy-b"], "10000"), 422, "DELIVERY_RATE_AMBIGUOUS");
        const results: string[] = [];
        for (const [orderId, ids] of [["rates-ab", ["policy-a", "policy-b"]], ["rates-ba", ["policy-b", "policy-a"]]] as const) {
          await quoteOrder(orderId);
          const quoted = await command("owner", orderId, "OrderQuoted", data(orderId, [...ids], "10000", "100"));
          results.push(quoted.result.quote.deliverySurchargeMinor);
          assert.equal(quoted.result.quote.totalMinor, "212100");
        }
        assert.deepEqual(results, ["100", "100"]);
        for (const [orderId, ids] of [["unauthorized-rates-ab", ["policy-a", "policy-b"]], ["unauthorized-rates-ba", ["policy-b", "policy-a"]]] as const) {
          await quoteOrder(orderId);
          await reject("reviewer", orderId, "OrderQuoted", data(orderId, [...ids], "10000", "100", false), 422, "SURCHARGE_POLICY_OVERRIDE");
          const unchanged = await db.operationOrder.findUniqueOrThrow({ where: { id: orderId } });
          assert.equal(unchanged.quoteVersion, 0);
          assert.equal(await db.operationOrderLine.count({ where: { orderId } }), 0);
        }
        await quoteOrder("zero-delivery-rates");
        const zero = await command("owner", "zero-delivery-rates", "OrderQuoted", data("zero-delivery-rates", ["policy-a", "policy-b"], "0"));
        assert.equal(zero.result.quote.deliverySurchargeMinor, "0");
      });

      await t.test("purchase payable links validate purchase, supplier and currency; unlinked legacy obligations remain valid", async () => {
        await command("owner", "purchase", "PurchaseOrderCreated", {
          supplierId: "supplier", agreementDate: today, currency: "ARS",
          items: [{ lineId: "purchase-line", skuId: "sku", unit: "ud", quantity: "1", unitCost: "1" }], evidence: proof,
        });
        const valid = await command("owner", "linked-payable", "PayableCreated", {
          purchaseId: "purchase", beneficiaryId: "supplier", kind: "purchase", currency: "ARS", amountMinor: "100", dueDate: today, evidence: proof,
        });
        assert.equal(valid.result.payable.purchaseId, "purchase");
        await reject("owner", "missing-purchase-payable", "PayableCreated", {
          purchaseId: "purchase-not-found", beneficiaryId: "supplier", kind: "purchase", currency: "ARS", amountMinor: "100", dueDate: today, evidence: proof,
        }, 422, "PURCHASE_PAYABLE_NOT_FOUND");
        await reject("owner", "wrong-kind-payable", "PayableCreated", {
          purchaseId: "purchase", beneficiaryId: "supplier", kind: "other", currency: "ARS", amountMinor: "100", dueDate: today, evidence: proof,
        }, 422, "PURCHASE_PAYABLE_KIND");
        await reject("owner", "wrong-supplier-payable", "PayableCreated", {
          purchaseId: "purchase", beneficiaryId: "another-supplier", kind: "purchase", currency: "ARS", amountMinor: "100", dueDate: today, evidence: proof,
        }, 422, "PURCHASE_PAYABLE_BENEFICIARY");
        await reject("owner", "wrong-currency-payable", "PayableCreated", {
          purchaseId: "purchase", beneficiaryId: "supplier", kind: "purchase", currency: "USD", amountMinor: "100", dueDate: today, evidence: proof,
        }, 422, "PURCHASE_PAYABLE_CURRENCY");
        const legacy = await command("owner", "legacy-payable", "PayableCreated", {
          beneficiaryId: "supplier", kind: "other", currency: "ARS", amountMinor: "100", dueDate: today, evidence: proof,
        });
        assert.equal(legacy.result.payable.purchaseId, null);
        assert.equal(await db.operationPayable.count({ where: { purchaseId: "purchase", kind: { not: "purchase" } } }), 0);
      });

      await t.test("period attestation accepts its stored proposal metadata and only independent, complete approvals", async () => {
        const { getManagementPeriodCoverageStatus } = await import("../server/operations/period-coverage.js");
        const missing = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-10" }));
        assert.equal(missing.state, "missing");
        assert.equal(missing.fingerprint, null, "sin aprobaciones no debe escanear ni hashear las poblaciones fuente");

        const proposal = await command("owner", "coverage-october", "PeriodCoverageProposed", {
          period: "2026-10", sourceReconciliationReference: "external-close-2026-10", evidence: proof,
        });
        assert.equal(proposal.result.configuration.state, "proposed");
        await reject("owner", "coverage-october", "PeriodCoverageApproved", { evidence: proof }, 409, "PERIOD_COVERAGE_INDEPENDENT_REVIEW_REQUIRED");
        assert.equal((await db.operationalConfiguration.findUniqueOrThrow({ where: { id: "coverage-october" } })).state, "proposed");
        await reject("scoped", "coverage-scoped", "PeriodCoverageProposed", {
          period: "2026-10", sourceReconciliationReference: "out-of-scope-close", evidence: proof,
        }, 403, "PERIOD_COVERAGE_FULL_SCOPE_REQUIRED");
        assert.equal(await db.operationalConfiguration.findUnique({ where: { id: "coverage-scoped" } }), null);

        await command("reviewer", "coverage-october", "PeriodCoverageApproved", { evidence: { reference: "independent-review" } });
        let status = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-10" }));
        assert.equal(status.state, "attested");
        assert.equal(status.sourcePeriodCompletenessAttested, true);
        assert.equal(status.attestationId, "coverage-october");
        assert.ok(status.fingerprint);
        status = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-10", scope: { memberIds: [] } }));
        assert.equal(status.state, "scope_excluded");
        assert.equal(status.sourcePeriodCompletenessAttested, false);

        await db.operationalConfiguration.update({ where: { id: "coverage-october" }, data: { approvedBy: "owner" } });
        status = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-10" }));
        assert.equal(status.state, "stale");
        assert.equal(status.reason, "approved-attestation-metadata-invalid");
      });

      await t.test("FX fees can be paid from the proceeds while every account preserves sufficient funds", async () => {
        async function account(id: string, currency: "ARS" | "USD", opening: string) {
          await command("owner", id, "AccountCreated", { name: id, currency, kind: "cash", holder: "Fixture", purpose: "FX funds regression" });
          await command("owner", id, "AccountVerified", { evidence: proof });
          await command("owner", id, "AccountOpeningApproved", { amountMinor: opening, preparedBy: "reviewer", evidence: proof });
        }
        await account("fx-source", "USD", "20000");
        await account("fx-proceeds", "ARS", "0");
        await account("fx-unfunded-fee", "ARS", "0");
        const fx = { fromAccountId: "fx-source", toAccountId: "fx-proceeds", fromMinor: "10000", toMinor: "15000000", rate: "1500", commissionMinor: "500", commissionAccountId: "fx-proceeds", evidence: proof };
        const exchanged = await command("owner", "fx-from-proceeds", "ForeignExchangeRecorded", fx);
        const legs = exchanged.result.event.legs as Array<{ accountId: string; amountMinor: string }>;
        assert.equal(legs.filter(leg => leg.accountId === "fx-proceeds").reduce((sum, leg) => sum + BigInt(leg.amountMinor), 0n), 14999500n);
        assert.equal((await db.ledgerLeg.aggregate({ where: { accountId: "fx-source" }, _sum: { amountMinor: true } }))._sum.amountMinor, 10000n);
        assert.equal((await db.ledgerLeg.aggregate({ where: { accountId: "fx-proceeds" }, _sum: { amountMinor: true } }))._sum.amountMinor, 14999500n);
        for (const [id, overrides] of [
          ["fx-separate-unfunded-fee", { commissionAccountId: "fx-unfunded-fee" }],
          ["fx-fee-exceeds-proceeds", { commissionMinor: "30000000" }],
          ["fx-source-exhausted", { fromMinor: "10001", toMinor: "15001500" }],
        ] as const) {
          const before = await db.ledgerLeg.count();
          const rejected = await reject("owner", id, "ForeignExchangeRecorded", { ...fx, ...overrides }, 422, "ACCOUNT_FUNDS");
          assert.equal(await db.ledgerLeg.count(), before);
          assert.equal(await db.commandReceipt.count({ where: { requestId: rejected.request.requestId } }), 0);
        }
      });

      await t.test("rendition route must identify the same driver and custody before any money moves", async () => {
        await command("owner", "rendition-custody", "AccountCreated", { name: "Driver custody", currency: "ARS", kind: "custody", custodianId: "driver-realism", holder: "Fixture", purpose: "Rendition regression" });
        await command("owner", "rendition-custody", "AccountVerified", { evidence: proof });
        await command("owner", "rendition-custody", "AccountOpeningApproved", { amountMinor: "1000", preparedBy: "reviewer", evidence: proof });
        await db.deliveryRoute.createMany({ data: [
          { id: "rendition-other-driver", driverId: "other-driver", shiftDate: today, custodianAccountId: "rendition-custody" },
          { id: "rendition-other-custody", driverId: "driver-realism", shiftDate: today, custodianAccountId: "other-custody" },
          { id: "rendition-matching-route", driverId: "driver-realism", shiftDate: today, custodianAccountId: "rendition-custody" },
        ] });
        const data = { driverId: "driver-realism", fromAccountId: "rendition-custody", toAccountId: "refund-account", grossMinor: "1000", deliveredMinor: "1000", mode: "gross", evidence: proof };
        const before = await db.ledgerLeg.count();
        for (const routeId of ["rendition-absent-route", "rendition-other-driver", "rendition-other-custody"]) {
          const rejected = await reject("owner", `invalid-${routeId}`, "RenditionAccepted", { ...data, routeId }, 422, "RENDITION_ROUTE_SCOPE");
          assert.equal(await db.ledgerLeg.count(), before);
          assert.equal(await db.rendition.count({ where: { id: rejected.request.targetId } }), 0);
          assert.equal(await db.commandReceipt.count({ where: { requestId: rejected.request.requestId } }), 0);
        }
        const accepted = await command("owner", "matching-rendition", "RenditionAccepted", { ...data, routeId: "rendition-matching-route" });
        assert.equal(accepted.result.rendition.routeId, "rendition-matching-route");
        assert.equal(accepted.result.rendition.driverId, "driver-realism");
        assert.equal((await db.ledgerLeg.aggregate({ where: { accountId: "rendition-custody" }, _sum: { amountMinor: true } }))._sum.amountMinor, 0n);
      });

      await t.test("an unapplied receipt creates credit without marking the order partially paid", async () => {
        await quoteOrder("credit-only-order");
        await db.operationOrder.update({ where: { id: "credit-only-order" }, data: { commercialState: "confirmed", totalMinor: 1000n, verifiedMinor: 0n } });
        await command("owner", "credit-only-receipt", "CollectionReported", { orderId: "credit-only-order", method: "cash", currency: "ARS", amountMinor: "500", evidence: proof });
        const verified = await command("owner", "credit-only-receipt", "CollectionVerified", { accountId: "refund-account", appliedMinor: "0", evidence: proof });
        assert.equal(verified.result.appliedMinor, "0");
        assert.equal(verified.result.excessMinor, "500");
        const stored = await db.operationOrder.findUniqueOrThrow({ where: { id: "credit-only-order" } });
        assert.equal(stored.verifiedMinor, 0n);
        assert.equal(stored.financialState, "unpaid");
        const credit = await db.memberCredit.findUniqueOrThrow({ where: { id: verified.result.creditId } });
        assert.equal(credit.amountMinor, 500n);
        assert.equal(credit.currency, "ARS");
      });

      await t.test("verifying a later excess receipt preserves an existing refund state", async () => {
        const before = await db.operationOrder.findUniqueOrThrow({ where: { id: "component-order" } });
        assert.equal(before.financialState, "partially_refunded");
        await command("owner", "post-refund-receipt", "CollectionReported", { orderId: before.id, method: "cash", currency: "ARS", amountMinor: "500", evidence: proof });
        const verified = await command("owner", "post-refund-receipt", "CollectionVerified", { accountId: "refund-account", evidence: proof });
        assert.equal(verified.result.appliedMinor, "0");
        assert.equal(verified.result.excessMinor, "500");
        const after = await db.operationOrder.findUniqueOrThrow({ where: { id: before.id } });
        assert.equal(after.financialState, "partially_refunded");
        assert.equal(after.verifiedMinor, before.verifiedMinor);
        assert.equal(after.refundedMinor, before.refundedMinor);
      });

      await t.test("a receipt reported before cancellation becomes credit rather than payment for a cancelled order", async () => {
        await quoteOrder("cancelled-receipt-order");
        await command("owner", "cancelled-receipt-order", "OrderQuoted", { currency: "ARS", paymentMethod: "cash", deliveryPolicyEvidence: proof, items: [{ id: "cancelled-receipt-line", skuId: "sku", quantity: "1", policyId: "policy-a", scale: "single" }] });
        await db.operationOrder.update({ where: { id: "cancelled-receipt-order" }, data: { commercialState: "confirmed", confirmedAt: new Date() } });
        await command("owner", "cancelled-receipt-report", "CollectionReported", { orderId: "cancelled-receipt-order", method: "cash", currency: "ARS", amountMinor: "500", evidence: proof });
        await command("owner", "cancelled-receipt-order", "OrderCancelled", { reason: "Synthetic cancellation before verifying the receipt", evidence: proof });
        const before = await db.ledgerLeg.count();
        const verified = await command("owner", "cancelled-receipt-report", "CollectionVerified", { accountId: "refund-account", excessTreatment: "refund_due", evidence: proof });
        assert.equal(verified.result.appliedMinor, "0");
        assert.equal(verified.result.excessMinor, "500");
        const order = await db.operationOrder.findUniqueOrThrow({ where: { id: "cancelled-receipt-order" } });
        assert.equal(order.commercialState, "cancelled");
        assert.equal(order.verifiedMinor, 0n);
        const credit = await db.memberCredit.findUniqueOrThrow({ where: { id: verified.result.creditId } });
        assert.equal(credit.amountMinor, 500n);
        assert.equal(credit.treatment, "refund_due");
        assert.equal(await db.ledgerLeg.count(), before + 1);
        const event = await db.ledgerEvent.findFirstOrThrow({ where: { sourceObjectId: "cancelled-receipt-report", kind: "collection" }, include: { legs: true } });
        assert.equal(event.legs[0]!.amountMinor, 500n);
      });

      await t.test("cross-currency equivalents outside closed-money precision cannot consume funds or resolve debt", async () => {
        await command("owner", "tiny-payment", "PayableCreated", { beneficiaryId: "supplier", kind: "other", currency: "USD", amountMinor: "100", dueDate: today, evidence: proof });
        await command("owner", "tiny-payment", "PayableVerified", { evidence: proof });
        const before = await db.ledgerLeg.count();
        const rejectedPayment = await reject("owner", "tiny-payment", "PayablePaid", { accountId: "refund-account", amountMinor: "1", exchangeRate: "1500", date: today, evidence: proof }, 422, "CROSS_CURRENCY_EQUIVALENT_ZERO");
        assert.equal(await db.ledgerLeg.count(), before);
        assert.equal(await db.payablePayment.count({ where: { payableId: "tiny-payment" } }), 0);
        assert.equal((await db.operationPayable.findUniqueOrThrow({ where: { id: "tiny-payment" } })).paidMinor, 0n);
        assert.equal(await db.commandReceipt.count({ where: { requestId: rejectedPayment.request.requestId } }), 0);
        await quoteOrder("tiny-receipt-order");
        await db.operationOrder.update({ where: { id: "tiny-receipt-order" }, data: { commercialState: "confirmed", currency: "USD", totalMinor: 100n } });
        for (const [id, amountMinor, exchangeRate, code] of [
          ["tiny-receipt", "1", "1500", "CROSS_CURRENCY_EQUIVALENT_ZERO"],
          ["overflow-receipt", "10000000", "0.000000000001", "CROSS_CURRENCY_EQUIVALENT_RANGE"],
        ]) {
          await command("owner", id, "CollectionReported", { orderId: "tiny-receipt-order", method: "cash", currency: "ARS", amountMinor, evidence: proof });
          const rejectedReceipt = await reject("owner", id, "CollectionVerified", { accountId: "refund-account", exchangeRate, evidence: proof }, 422, code!);
          assert.equal(await db.ledgerLeg.count(), before);
          assert.equal((await db.collectionReport.findUniqueOrThrow({ where: { id } })).status, "reported");
          assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "tiny-receipt-order" } })).verifiedMinor, 0n);
          assert.equal(await db.memberCredit.count({ where: { collectionId: id } }), 0);
          assert.equal(await db.commandReceipt.count({ where: { requestId: rejectedReceipt.request.requestId } }), 0);
        }
      });

      await t.test("declared payment dates preserve daily cash and cannot rewrite closed or unfunded history", async () => {
        const date = "2025-01-10";
        async function account(id: string, opening: string, openingAt = "2020-01-01T12:00:00-03:00") {
          await command("owner", id, "AccountCreated", { name: id, currency: "ARS", kind: "cash", holder: "Fixture", purpose: "Payment dates regression" });
          await command("owner", id, "AccountVerified", { evidence: proof });
          await command("owner", id, "AccountOpeningApproved", { amountMinor: opening, preparedBy: "reviewer", evidence: proof }, openingAt);
        }
        async function payable(id: string) {
          await command("owner", id, "PayableCreated", { beneficiaryId: "supplier", kind: "other", currency: "ARS", amountMinor: "1000", dueDate: date, evidence: proof });
          await command("owner", id, "PayableVerified", { evidence: proof });
        }
        await account("dated-cash", "5000");
        await payable("dated-payment");
        const paid = await send("owner", "dated-payment", "PayablePaid", { accountId: "dated-cash", amountMinor: "1000", date, evidence: proof });
        assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
        const { accountBalance } = await import("../server/operations/finance.js");
        assert.equal(await db.$transaction(tx => accountBalance(tx, "dated-cash", date)), 4000n, "la caja del día declarado debe incluir el pago");
        const { queryOperationsReport } = await import("../server/operations/report-queries.js");
        const report = await queryOperationsReport("cash-ledger", { from: date, to: date }, { accountIds: ["dated-cash"] });
        assert.equal((report.metrics.accounts as Array<{ accountId: string; periodNetMovementMinor: string }>)[0]!.periodNetMovementMinor, "-1000");
        const event = await db.ledgerEvent.findUniqueOrThrow({ where: { id: paid.body.result.payment.eventId } });
        const metadata = event.metadata as Record<string, unknown>;
        assert.equal(metadata.declaredDate, date);
        assert.equal(metadata.timestampPrecision, "civil_date");
        assert.equal(metadata.reportedOccurredAt, paid.request.occurredAt);
        assert.equal((await db.commandReceipt.findUniqueOrThrow({ where: { requestId: paid.request.requestId } })).occurredAt.toISOString(), paid.request.occurredAt);
        const replay = await fetch(`${base}/operations/commands`, { method: "POST", headers: { Cookie: cookies.owner!, Origin: "http://finance-regression.local", "Content-Type": "application/json" }, body: JSON.stringify(paid.request) });
        assert.equal(replay.status, 200);
        assert.equal(await db.payablePayment.count({ where: { payableId: "dated-payment" } }), 1);

        await account("future-cash", "5000");
        await account("late-opening-cash", "5000", "2025-01-11T12:00:00-03:00");
        await account("later-funded-cash", "0");
        await command("owner", "later-funding", "OwnerContributionRecorded", { accountId: "later-funded-cash", amountMinor: "5000", contributor: "Fixture", evidence: proof }, "2025-01-11T12:00:00-03:00");
        await account("closed-cash", "5000");
        await command("owner", "closed-cash", "AccountReconciled", { date, countedMinor: "5000", evidence: proof });
        await account("intermediate-cash", "1000");
        await command("owner", "intermediate-cash", "AccountTransferred", { toAccountId: "future-cash", amountMinor: "1000", reason: "Known later expense of funds" }, "2025-01-11T23:30:00-03:00");
        await command("owner", "replacement-funding", "OwnerContributionRecorded", { accountId: "intermediate-cash", amountMinor: "1000", contributor: "Fixture", evidence: proof }, "2025-01-12T10:00:00-03:00");
        const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
        for (const [id, accountId, declaredDate, status, code] of [
          ["future-payment", "future-cash", tomorrow, 422, "PAYMENT_FUTURE_DATE"],
          ["preopening-payment", "late-opening-cash", date, 422, "PAYMENT_BEFORE_OPENING"],
          ["unfunded-past-payment", "later-funded-cash", date, 422, "PAYMENT_HISTORICAL_FUNDS"],
          ["closed-day-payment", "closed-cash", date, 409, "PAYMENT_RECONCILED_DATE"],
          ["intermediate-deficit-payment", "intermediate-cash", date, 422, "PAYMENT_HISTORICAL_FUNDS"],
        ] as const) {
          await payable(id);
          const before = await db.ledgerLeg.count();
          await reject("owner", id, "PayablePaid", { accountId, amountMinor: "1000", date: declaredDate, evidence: proof }, status, code);
          assert.equal(await db.ledgerLeg.count(), before);
          assert.equal(await db.payablePayment.count({ where: { payableId: id } }), 0);
          assert.equal((await db.operationPayable.findUniqueOrThrow({ where: { id } })).paidMinor, 0n);
        }
      });

      await t.test("approval rejects a changed source population and leaves proposal, receipt, audit and outbox untouched", async () => {
        await command("owner", "coverage-november", "PeriodCoverageProposed", {
          period: "2026-11", sourceReconciliationReference: "external-close-2026-11", evidence: proof,
        });
        await command("reviewer", "november-cost", "PayableCreated", {
          beneficiaryId: "courier", kind: "courier_fee", currency: "ARS", amountMinor: "500", dueDate: today,
          accrualPeriod: "2026-11", evidence: proof,
        });
        await reject("reviewer", "coverage-november", "PeriodCoverageApproved", { evidence: proof }, 409, "PERIOD_COVERAGE_STALE");
        assert.equal((await db.operationalConfiguration.findUniqueOrThrow({ where: { id: "coverage-november" } })).state, "proposed");
        const { getManagementPeriodCoverageStatus } = await import("../server/operations/period-coverage.js");
        const status = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-11" }));
        assert.equal(status.state, "missing", "el rechazo deja la propuesta pendiente y no fabrica una aprobación obsoleta");
        assert.equal(status.sourcePeriodCompletenessAttested, false);

        await command("owner", "coverage-december", "PeriodCoverageProposed", {
          period: "2026-12", sourceReconciliationReference: "external-close-2026-12", evidence: proof,
        });
        await command("reviewer", "coverage-december", "PeriodCoverageApproved", { evidence: proof });
        await command("reviewer", "december-cost", "PayableCreated", {
          beneficiaryId: "courier", kind: "courier_fee", currency: "ARS", amountMinor: "700", dueDate: today,
          accrualPeriod: "2026-12", evidence: proof,
        });
        const stale = await db.$transaction((tx) => getManagementPeriodCoverageStatus(tx, { period: "2026-12" }));
        assert.equal(stale.state, "stale", "una fuente nueva posterior a una aprobación debe invalidar la huella");
        assert.equal(stale.sourcePeriodCompletenessAttested, false);
      });
    } finally {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
