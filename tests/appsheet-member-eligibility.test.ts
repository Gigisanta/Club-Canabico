import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
import { APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../shared/operations/appsheet-canonical.js";
import { splitSqlStatements } from "./migration-sql.js";

test("active AppSheet replacement exposes native members and rejects unreviewed imports before reads or writes", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  const schema = `appsheet_member_eligibility_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: "appsheet-member-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-member.test",
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

    const ownerId = "appsheet-member-eligibility-owner";
    const passwordText = randomUUID();
    const password = await bcrypt.hash(passwordText, 4);
    await db.user.create({ data: { id: ownerId, name: "Synthetic owner", email: `${ownerId}@appsheet-member.test`, password, role: "owner" } });

    const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    const manifestHash = hash(`invalid-stable-manifest-${randomUUID()}`);
    const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
    const now = new Date();
    // This manifest is deliberately incomplete. It satisfies the authority FK, while the
    // replacement boundary must fail closed because it cannot establish a stable capture.
    await db.appSheetCaptureManifest.create({ data: {
      captureId,
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
      sourceId: "synthetic-spreadsheet",
      spreadsheetId: "synthetic-spreadsheet",
      metadataHash: hash("metadata"),
      headersHash: hash("headers"),
      manifestHash,
      dataHash: hash("data"),
      definitionHash: null,
      stability: {},
      firstReadAt: now,
      verificationStartedAt: now,
      verificationCompletedAt: now,
      cutoffAt: now,
      dataCoverage: {},
      pageManifest: [],
      definitionCoverage: null,
      dataSheetCount: 0,
      dataPageCount: 0,
      dataRecordCount: 0,
      dataFormulaCount: 0,
      dataUnresolvedFormulaCount: 0,
    } });
    await db.operationAuthority.create({
      data: { id: "operations", mode: "suspended", cutoverProfile: "legacy", captureManifestId: captureId, epoch: 1 },
    });

    const importedId = "appsheet-member-eligibility-imported";
    await db.operationMember.create({
      data: { id: importedId, name: "Imported but unreviewed", address: {}, preferences: {},
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: "source-17", legacyCustomerId: "source-17" },
    });
    await db.operationObject.create({ data: { id: importedId, kind: "member", version: 0, createdBy: ownerId } });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
    const validUntil = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await db.memberPermission.create({
      data: { memberId: importedId, kind: "operations", status: "verified", validFrom: today, validUntil },
    });
    const legacyId = "appsheet-member-eligibility-legacy";
    await db.operationMember.create({
      data: { id: legacyId, name: "Old import", address: {}, preferences: {}, sourceSystem: "legacy-archive", sourceId: "archive-8", legacyCustomerId: "archive-8" },
    });
    await db.operationObject.create({ data: { id: legacyId, kind: "member", version: 0, createdBy: ownerId } });

    const skuId = "appsheet-member-eligibility-sku";
    const locationId = "appsheet-member-eligibility-location";
    const lotId = "appsheet-member-eligibility-lot";
    const balanceId = "appsheet-member-eligibility-balance";
    await db.catalogSku.create({ data: { id: skuId, code: skuId, name: "Synthetic order product", variety: "Fixture", category: "Fixture", unit: "g" } });
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic order location" } });
    await db.inventoryLot.create({
      data: { id: lotId, skuId, label: "Synthetic order lot", unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: now },
    });
    await db.stockBalance.create({ data: { id: balanceId, lotId, locationId, custodianId: ownerId, unit: "g", quantity: "100", reserved: "0" } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://appsheet-member.test";
    let cookie = "";
    async function call(path: string, body?: unknown) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, body: await response.json() as Record<string, any> };
    }
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${ownerId}@appsheet-member.test`, password: passwordText }),
    });
    assert.equal(login.status, 200, await login.text());
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const envelope = (targetId: string, command: string, data: Record<string, unknown>): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
    });

    const quoteData = (lineId: string) => ({
      items: [{ id: lineId, skuId, quantity: "1", manualUnitPrice: "1", manualReason: "Synthetic eligibility boundary" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    async function successfulCommand(targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0) {
      const request = { ...envelope(targetId, command, data), expectedVersion };
      const result = await call("/operations/commands", request);
      assert.equal(result.response.status, 200, `${command}: ${JSON.stringify(result.body)}`);
      return { request, ...result };
    }
    async function createAndQuote(targetId: string, channel: "local" | "delivery", lineId: string) {
      await successfulCommand(targetId, "OrderCreated", { memberId: importedId, channel, currency: "ARS", address: {}, preorder: false });
      await successfulCommand(targetId, "OrderQuoted", quoteData(lineId), 1);
    }

    // Build real persisted drafts under the legacy profile. They represent work
    // already in progress when the replacement authority is activated below.
    const staleQuoteId = `appsheet-member-eligibility-stale-quote-${randomUUID()}`;
    await successfulCommand(staleQuoteId, "OrderCreated", { memberId: importedId, channel: "local", currency: "ARS", address: {}, preorder: false });
    const staleConfirmId = `appsheet-member-eligibility-stale-confirm-${randomUUID()}`;
    await createAndQuote(staleConfirmId, "delivery", `stale-confirm-line-${randomUUID()}`);
    const staleRevisionId = `appsheet-member-eligibility-stale-revision-${randomUUID()}`;
    await createAndQuote(staleRevisionId, "delivery", `stale-revision-line-${randomUUID()}`);
    await successfulCommand(staleRevisionId, "OrderConfirmed", {
      quoteVersion: 1, acceptance: { note: "Synthetic accepted quote before cutover" },
    }, 2);
    await db.operationAuthority.update({
      where: { id: "operations" },
      data: { mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: captureId, epoch: 2 },
    });

    const deniedEffects = async (request: CommandEnvelope, targetId: string, expectedVersion: number | null) => {
      const denied = await call("/operations/commands", request);
      assert.equal(denied.response.status, 423, `${request.command}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error?.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }).then(row => row?.version ?? null), expectedVersion);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      return denied;
    };

    const importedOrderId = `appsheet-member-eligibility-imported-order-${randomUUID()}`;
    const importedOrder = envelope(importedOrderId, "OrderCreated", {
      memberId: importedId, channel: "delivery", currency: "ARS", address: {}, preorder: false,
    });
    await deniedEffects(importedOrder, importedOrderId, null);
    assert.equal(await db.operationOrder.findUnique({ where: { id: importedOrderId } }), null);

    const staleQuoteBefore = await db.operationOrder.findUniqueOrThrow({ where: { id: staleQuoteId } });
    const staleQuoteVersionBefore = (await db.operationObject.findUniqueOrThrow({ where: { id: staleQuoteId } })).version;
    const staleQuoteRequest = envelope(staleQuoteId, "OrderQuoted", quoteData(`denied-quote-line-${randomUUID()}`));
    staleQuoteRequest.expectedVersion = staleQuoteVersionBefore;
    await deniedEffects(staleQuoteRequest, staleQuoteId, staleQuoteVersionBefore);
    assert.deepEqual(await db.operationOrder.findUniqueOrThrow({ where: { id: staleQuoteId } }), staleQuoteBefore);
    assert.equal(await db.operationOrderLine.count({ where: { orderId: staleQuoteId } }), 0);

    const staleConfirmBefore = await db.operationOrder.findUniqueOrThrow({ where: { id: staleConfirmId } });
    const staleConfirmLineBefore = await db.operationOrderLine.findMany({ where: { orderId: staleConfirmId } });
    const staleConfirmObjectVersion = (await db.operationObject.findUniqueOrThrow({ where: { id: staleConfirmId } })).version;
    const staleConfirmStockBefore = {
      reservations: await db.stockReservation.count({ where: { orderId: staleConfirmId } }),
      reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      deliveries: await db.deliveryAssignment.count({ where: { orderId: staleConfirmId } }),
    };
    const staleConfirmRequest = envelope(staleConfirmId, "OrderConfirmed", {
      quoteVersion: 1, acceptance: { note: "Synthetic stale draft confirmation" },
    });
    staleConfirmRequest.expectedVersion = staleConfirmObjectVersion;
    await deniedEffects(staleConfirmRequest, staleConfirmId, staleConfirmObjectVersion);
    assert.deepEqual(await db.operationOrder.findUniqueOrThrow({ where: { id: staleConfirmId } }), staleConfirmBefore);
    assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: staleConfirmId } }), staleConfirmLineBefore);
    assert.deepEqual({
      reservations: await db.stockReservation.count({ where: { orderId: staleConfirmId } }),
      reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      deliveries: await db.deliveryAssignment.count({ where: { orderId: staleConfirmId } }),
    }, staleConfirmStockBefore);

    const staleRevisionBefore = await db.operationOrder.findUniqueOrThrow({ where: { id: staleRevisionId } });
    const staleRevisionLineBefore = await db.operationOrderLine.findMany({ where: { orderId: staleRevisionId } });
    const staleRevisionObjectVersion = (await db.operationObject.findUniqueOrThrow({ where: { id: staleRevisionId } })).version;
    const staleRevisionStockBefore = {
      reservations: await db.stockReservation.count({ where: { orderId: staleRevisionId } }),
      reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      deliveries: await db.deliveryAssignment.count({ where: { orderId: staleRevisionId } }),
    };
    const staleRevisionRequest = envelope(staleRevisionId, "OrderQuoteRevisionAccepted", {
      quote: quoteData(`denied-revision-line-${randomUUID()}`),
      acceptance: { note: "Synthetic stale revision acceptance" }, reason: "Synthetic eligibility boundary",
    });
    staleRevisionRequest.expectedVersion = staleRevisionObjectVersion;
    await deniedEffects(staleRevisionRequest, staleRevisionId, staleRevisionObjectVersion);
    assert.deepEqual(await db.operationOrder.findUniqueOrThrow({ where: { id: staleRevisionId } }), staleRevisionBefore);
    assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: staleRevisionId } }), staleRevisionLineBefore);
    assert.deepEqual({
      reservations: await db.stockReservation.count({ where: { orderId: staleRevisionId } }),
      reserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } })).reserved.toString(),
      deliveries: await db.deliveryAssignment.count({ where: { orderId: staleRevisionId } }),
    }, staleRevisionStockBefore);

    const nativeId = "appsheet-member-eligibility-native";
    const native = envelope(nativeId, "MemberCreated", { name: "Native after cutover", address: {}, preferences: {} });
    const nativeCreated = await call("/operations/commands", native);
    assert.equal(nativeCreated.response.status, 200, JSON.stringify(nativeCreated.body));
    const nativeOrderId = `appsheet-member-eligibility-native-order-${randomUUID()}`;
    const nativeOrder = await call("/operations/commands", envelope(nativeOrderId, "OrderCreated", {
      memberId: nativeId, channel: "local", currency: "ARS", address: {}, preorder: false,
    }));
    assert.equal(nativeOrder.response.status, 200, JSON.stringify(nativeOrder.body));
    const secondNativeId = "appsheet-member-eligibility-native-page-two";
    const secondNative = envelope(secondNativeId, "MemberCreated", { name: "Native page two", address: {}, preferences: {} });
    const secondNativeCreated = await call("/operations/commands", secondNative);
    assert.equal(secondNativeCreated.response.status, 200, JSON.stringify(secondNativeCreated.body));

    const list = await call("/operations/members?limit=1&q=native");
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.items.map((member: { id: string }) => member.id), [nativeId]);
    assert.equal(list.body.hasMore, true, "la elegibilidad se aplica antes de cortar la primera página");
    const nextPage = await call(`/operations/members?limit=1&q=native&cursor=${encodeURIComponent(nativeId)}`);
    assert.equal(nextPage.response.status, 200, JSON.stringify(nextPage.body));
    assert.deepEqual(nextPage.body.items.map((member: { id: string }) => member.id), [secondNativeId]);
    assert.equal(nextPage.body.hasMore, false);
    const filteredImports = await call("/operations/members?limit=1&q=imported");
    assert.equal(filteredImports.response.status, 200, JSON.stringify(filteredImports.body));
    assert.deepEqual(filteredImports.body.items, []);
    const mismatchedCursor = await call(`/operations/members?limit=1&q=imported&cursor=${encodeURIComponent(nativeId)}`);
    assert.equal(mismatchedCursor.response.status, 400, JSON.stringify(mismatchedCursor.body));
    assert.equal(mismatchedCursor.body.error?.code, "PAGE_CURSOR");
    assert.equal((await call(`/operations/members/${nativeId}`)).response.status, 200);
    for (const path of [
      `/operations/members/${importedId}`,
      `/operations/members/${importedId}/history`,
      `/operations/members/${importedId}/clinical`,
      `/operations/members/${legacyId}`,
    ]) {
      const denied = await call(path);
      assert.equal(denied.response.status, 423, `${path}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error?.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    }

    const update = envelope(importedId, "MemberUpdated", { name: "Should not persist", email: "", phone: "", address: {}, preferences: {} });
    const deniedUpdate = await call("/operations/commands", update);
    assert.equal(deniedUpdate.response.status, 423, JSON.stringify(deniedUpdate.body));
    assert.equal(deniedUpdate.body.error?.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    assert.equal((await db.operationMember.findUnique({ where: { id: importedId } }))?.name, "Imported but unreviewed");
    assert.equal((await db.operationObject.findUnique({ where: { id: importedId } }))?.version, 0);
    assert.equal(await db.commandReceipt.count({ where: { requestId: update.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: update.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: update.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { objectId: importedId, action: "clinical.read" } }), 0);

    const importedInvoiceId = "appsheet-member-eligibility-imported-invoice";
    const importedInvoice = envelope(importedInvoiceId, "InvoiceSaved", {
      memberId: importedId,
      invoiceDate: now.toISOString().slice(0, 10),
      currency: "ARS",
      address: {},
      note: "",
      productPaymentMethod: "cash",
      lines: [],
      preorder: true,
    });
    const deniedInvoice = await call("/operations/commands", importedInvoice);
    assert.equal(deniedInvoice.response.status, 423, JSON.stringify(deniedInvoice.body));
    assert.equal(deniedInvoice.body.error?.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    assert.equal(await db.appSheetInvoiceSequence.count(), 0, "el rechazo ocurre antes de reservar numeración");
    assert.equal(await db.operationOrder.count({ where: { id: importedInvoiceId } }), 0);
    assert.equal(await db.operationObject.count({ where: { id: importedInvoiceId } }), 0);
    assert.equal(await db.commandReceipt.count({ where: { requestId: importedInvoice.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: importedInvoice.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: importedInvoice.requestId } }), 0);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
