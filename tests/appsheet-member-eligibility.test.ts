import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
import { canonicalJson } from "../shared/operations/exact.js";
import {
  APPSHEET_CANONICAL_IMPORTER_VERSION,
  APPSHEET_CANONICAL_MAPPING_ID,
  APPSHEET_CANONICAL_SCHEMA_VERSION,
  APPSHEET_CANONICAL_SOURCE_SYSTEM,
  prepareAppSheetCaptureManifest,
} from "../shared/operations/appsheet-canonical.js";
import {
  APPSHEET_EXPECTED_LIVE_APP_ID,
  appSheetAppliedDefinitionHash,
  appSheetCanonicalCurrentDestinationHash,
} from "../server/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { definitionInventory, project } from "./support/appsheet-canonical-fixture.js";
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

    const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
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
      assert.equal(denied.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
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
    assert.equal(mismatchedCursor.body.code, "PAGE_CURSOR");
    assert.equal((await call(`/operations/members/${nativeId}`)).response.status, 200);
    for (const path of [
      `/operations/members/${importedId}`,
      `/operations/members/${importedId}/history`,
      `/operations/members/${importedId}/clinical`,
      `/operations/members/${legacyId}`,
    ]) {
      const denied = await call(path);
      assert.equal(denied.response.status, 423, `${path}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    }

    const update = envelope(importedId, "MemberUpdated", { name: "Should not persist", email: "", phone: "", address: {}, preferences: {} });
    const deniedUpdate = await call("/operations/commands", update);
    assert.equal(deniedUpdate.response.status, 423, JSON.stringify(deniedUpdate.body));
    assert.equal(deniedUpdate.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
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
    assert.equal(deniedInvoice.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
    assert.equal(await db.appSheetInvoiceSequence.count(), 0, "el rechazo ocurre antes de reservar numeración");
    assert.equal(await db.operationOrder.count({ where: { id: importedInvoiceId } }), 0);
    assert.equal(await db.operationObject.count({ where: { id: importedInvoiceId } }), 0);
    assert.equal(await db.commandReceipt.count({ where: { requestId: importedInvoice.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: importedInvoice.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: importedInvoice.requestId } }), 0);

    // Synthetic, complete staged contract: the actual review/mutation/order
    // commands below create their own receipts and audits. This fixture is not
    // evidence that the AppSheet stage writer observed real bots or editor state.
    const canonicalProjection = project({ captureRevision: `member-eligibility-${randomUUID()}` });
    const canonicalManifest = canonicalProjection.capture;
    const pageRefs = canonicalManifest.pageManifest.map(page => ({ path: page.path, sheetId: page.sheetId, pageIndex: page.pageIndex,
      startRow: page.startRow, endRow: page.endRow, pageHash: page.pageHash, counts: page.counts }));
    const canonicalDataHash = hash(pageRefs);
    const captureSheets: Array<Record<string, unknown>> = canonicalManifest.pageManifest.map(page => ({ sheetId: page.sheetId, title: page.title,
      pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false }));
    captureSheets.push({ sheetId: 99, title: "T_Usuarios", pageCount: 0, verifiedPageCount: 0, stablePageCount: 0,
      changedPageCount: 0, bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted" });
    const canonicalCapture = prepareAppSheetCaptureManifest({
      schemaVersion: APPSHEET_CANONICAL_SCHEMA_VERSION,
      ...canonicalManifest,
      dataHash: canonicalDataHash,
      stability: { ...canonicalManifest.stability, cutoverEligible: true, missingPages: 0, unresolvedFormulaCount: 0,
        sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"] },
      coverage: { ...canonicalManifest.dataCoverage, metadataStable: true, headersStableAll: true, failedPages: 0,
        changedPages: 0, unresolvedFormulaCount: 0, dataRecordCount: canonicalManifest.dataRecordCount, sheets: captureSheets },
      pages: canonicalManifest.pageManifest,
    });
    await db.appSheetCaptureManifest.create({ data: {
      ...canonicalCapture,
      firstReadAt: new Date(canonicalCapture.firstReadAt),
      verificationStartedAt: new Date(canonicalCapture.verificationStartedAt),
      verificationCompletedAt: new Date(canonicalCapture.verificationCompletedAt),
      cutoffAt: new Date(canonicalCapture.cutoffAt),
    } });

    const stagerId = "appsheet-member-eligibility-stager";
    await db.user.create({ data: { id: stagerId, name: "Synthetic stage operator", email: `${stagerId}@appsheet-member.test`, password, role: "admin" } });
    const canonicalMemberDestination = canonicalProjection.destinations.find(destination => destination.type === "member");
    const canonicalSkuDestination = canonicalProjection.destinations.find(destination => destination.type === "sku");
    assert.ok(canonicalMemberDestination?.type === "member" && canonicalSkuDestination?.type === "sku");
    const canonicalMember = await db.operationMember.create({ data: { id: canonicalMemberDestination.id, ...canonicalMemberDestination.data } });
    const canonicalSku = await db.catalogSku.create({ data: { id: canonicalSkuDestination.id, ...canonicalSkuDestination.data } });
    for (const destination of [canonicalMemberDestination, canonicalSkuDestination]) {
      await db.operationObject.create({ data: { id: destination.id, kind: destination.type, version: 0, createdBy: stagerId } });
      await db.legacyIdentity.create({ data: {
        id: `synthetic-${destination.type}-identity-${randomUUID()}`,
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceTable: destination.sourceTable,
        sourceKey: destination.sourceKey,
        destinationType: destination.type,
        destinationId: destination.id,
        approvedBy: null,
      } });
    }
    assert.equal(canonicalProjection.summary.exceptionCount, 0, "el staged fixture debe estar libre de excepciones");

    const syntheticDefinition = definitionInventory();
    const definitionCoverage = (["tables", "columns", "slices", "views", "formatRules", "actions", "bots", "workflowRules", "security", "settings", "other"] as const)
      .map(category => ({ category, state: "matched_declared_count" as const, declaredCount: category === "bots" ? 1 : 0,
        observedCount: category === "bots" ? 1 : 0, missingCount: 0, redactedFieldCount: 0, ambiguousFieldCount: 0,
        evidenceCount: category === "bots" ? 1 : 0, note: "synthetic staged contract fixture" }));
    const definitionBase = {
      ...syntheticDefinition,
      app: { ...syntheticDefinition.app, id: APPSHEET_EXPECTED_LIVE_APP_ID, name: "Synthetic verified app" },
      declaredCounts: { bots: 1 },
      observedCounts: { bots: 1 },
      coverage: definitionCoverage,
      descriptorSha256: "",
    };
    const fullDefinition = { ...definitionBase, descriptorSha256: hash(definitionBase) };
    const appliedDefinitionHash = appSheetAppliedDefinitionHash(fullDefinition);
    const destinationIdentity = appSheetDatabaseDestinationIdentity("production", databaseUrl);
    const projectionHash = hash({
      schemaVersion: canonicalProjection.schemaVersion,
      projectionKind: canonicalProjection.projectionKind,
      mappingId: APPSHEET_CANONICAL_MAPPING_ID,
      importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
      captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash,
      dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null,
      appliedDefinitionHash,
      expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID,
      definitionIdentityState: "verified",
      definitionDescriptorSha256: fullDefinition.descriptorSha256,
      definitionSourceSha256: fullDefinition.source.sha256,
      stabilityMode: "stable",
      verifiedMasterPages: canonicalProjection.verifiedMasterPages,
      deltaPageHashes: [],
      tables: canonicalProjection.tableCoverage,
      records: canonicalProjection.records.map(record => ({
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        sourceRow: record.sourceRow,
        contentHash: record.contentHash,
        normalizedHash: hash(record.normalized),
        treatment: record.treatment,
        exceptions: record.exceptions,
        destination: record.destination ? { type: record.destination.type, id: record.destination.id, payloadHash: hash(record.destination.data) } : null,
      })),
    });
    const destinationFingerprints = [
      { destinationType: "member", sourceTable: canonicalMemberDestination.sourceTable, sourceKey: canonicalMemberDestination.sourceKey,
        destinationId: canonicalMember.id, dataHash: appSheetCanonicalCurrentDestinationHash(canonicalMember, "member"), operationVersion: 0 },
      { destinationType: "sku", sourceTable: canonicalSkuDestination.sourceTable, sourceKey: canonicalSkuDestination.sourceKey,
        destinationId: canonicalSku.id, dataHash: appSheetCanonicalCurrentDestinationHash(canonicalSku, "sku"), operationVersion: 0 },
    ];
    const backupEvidence = { manifestHash: hash("synthetic-backup"), snapshotAt: now.toISOString() };
    const technicalReview = {
      reviewKind: "independent-technical", approved: true, projectionHash, captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash, definitionHash: appliedDefinitionHash,
      importer: APPSHEET_CANONICAL_IMPORTER_VERSION, reviewer: "synthetic-independent-reviewer",
      reviewedAt: new Date(now.getTime() - 1_000).toISOString(), findingsCount: 0, commitSha: "1".repeat(40),
      target: "production", destinationIdentity,
    };
    const snapshotControls = { appSheetCanonical: {
      schemaVersion: 1, projectionKind: "masters", mappingId: APPSHEET_CANONICAL_MAPPING_ID,
      importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION, captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash, dataHash: canonicalCapture.dataHash, captureDefinitionHash: null,
      appliedDefinitionHash, expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID, definitionIdentityState: "verified",
      definitionInventory: fullDefinition, projectionHash, destinationFingerprints,
      botInventory: { state: "verified", evidenceSha256: hash("synthetic bot inventory fixture"), observedCount: 1 },
      stageContext: { target: "production", destinationIdentity, backupEvidence }, technicalReview,
      effects: { stock: false, cash: false, orders: false, deliveries: false, messaging: false, priceApproval: false },
    } };
    const snapshotCoverage = { appSheetCanonical: {
      captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null, identityState: "verified", projectionHash, appliedDefinitionHash,
      botInventory: snapshotControls.appSheetCanonical.botInventory,
      tables: canonicalProjection.tableCoverage,
    } };
    await db.legacyImportSnapshot.create({ data: {
      id: canonicalProjection.snapshotId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, filename: "synthetic-canonical-stage",
      fileHash: canonicalCapture.manifestHash, importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION, status: "staged",
      createdBy: stagerId, captureManifestId: canonicalCapture.captureId,
      controls: snapshotControls, coverage: snapshotCoverage,
    } });
    for (const record of canonicalProjection.records) {
      await db.legacySourceRecord.create({ data: {
        id: record.id,
        snapshotId: canonicalProjection.snapshotId,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        sourceRow: record.sourceRow,
        fileHash: record.fileHash,
        contentHash: record.contentHash,
        importerVersion: record.importerVersion,
        original: record.original,
        normalized: record.normalized,
        treatment: record.treatment,
      } });
    }
    await db.operationObject.create({ data: { id: canonicalProjection.snapshotId, kind: "legacyImport", version: 0, createdBy: stagerId } });
    await db.operationAudit.create({ data: {
      actorId: stagerId, action: "appsheet.canonical_masters_staged", objectId: canonicalProjection.snapshotId,
      details: {
        captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, projectionHash,
        destinationIdentity, target: "production", importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
        recordCount: canonicalProjection.summary.recordCount, destinationCount: canonicalProjection.destinations.length,
        exceptionCount: 0, reviewer: technicalReview.reviewer, reviewedAt: technicalReview.reviewedAt,
        commitSha: technicalReview.commitSha, backupManifestHash: backupEvidence.manifestHash, backupSnapshotAt: backupEvidence.snapshotAt,
      },
    } });
    await db.operationAuthority.update({
      where: { id: "operations" },
      data: { mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: canonicalCapture.captureId, epoch: 3, approvedBy: ownerId },
    });

    const canonicalReview = await successfulCommand(canonicalProjection.snapshotId, "AppSheetCanonicalIdentitiesReviewed", {
      captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, projectionHash,
      destinationCount: canonicalProjection.destinations.length, evidenceReference: "synthetic canonical review fixture",
    });
    assert.equal(canonicalReview.body.result.status, "reviewed");
    assert.equal((await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: canonicalProjection.snapshotId } })).reviewedBy, ownerId);
    assert.equal(await db.operationAudit.count({ where: { objectId: canonicalProjection.snapshotId, action: "appsheet.canonical_identities_reviewed" } }), 1);
    assert.equal(await db.operationAudit.count({ where: { objectId: { in: [canonicalMember.id, canonicalSku.id] }, action: "appsheet.canonical_identity_reviewed" } }), 2);
    assert.equal((await call(`/operations/members/${canonicalMember.id}`)).response.status, 200,
      "la auditoría real de revisión deja visible al socio canónico");

    const memberUpdate = envelope(canonicalMember.id, "MemberUpdated", {
      name: "Canonical member updated", email: canonicalMember.email, phone: canonicalMember.phone,
      address: canonicalMember.address, preferences: canonicalMember.preferences,
    });
    memberUpdate.expectedVersion = 0;
    const updatedCanonicalMember = await call("/operations/commands", memberUpdate);
    assert.equal(updatedCanonicalMember.response.status, 200, JSON.stringify(updatedCanonicalMember.body));
    const permissionDocumentId = randomUUID();
    await db.operationDocument.create({ data: {
      id: permissionDocumentId, memberId: canonicalMember.id, kind: "synthetic-permission", sensitivity: "commercial",
      state: "available", objectKey: "synthetic-permission-object", checksum: hash("synthetic-permission-bytes"),
      metadata: { fixture: true }, createdBy: ownerId,
    } });
    const permissionDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
    const permissionReview = await successfulCommand(canonicalMember.id, "PermissionVerified", {
      kind: "operations", validFrom: permissionDate, validUntil: `${Number(permissionDate.slice(0, 4)) + 1}${permissionDate.slice(4)}`,
      evidenceDocumentId: permissionDocumentId,
    }, 1);
    const permissionReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: permissionReview.request.requestId } });
    assert.ok(Date.parse((permissionReceipt.response as any).result.permission.reviewedAt) >= permissionReceipt.committedAt.getTime(),
      "la fecha semántica puede ser posterior al now() de inicio de transacción guardado por Postgres");
    const canonicalOrderId = `appsheet-member-eligibility-reviewed-order-${randomUUID()}`;
    const canonicalOrder = await successfulCommand(canonicalOrderId, "OrderCreated", {
      memberId: canonicalMember.id, channel: "local", currency: "ARS", address: {}, preorder: false,
    });
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).memberId, canonicalMember.id);
    assert.ok(await db.commandReceipt.findUnique({ where: { requestId: canonicalOrder.request.requestId } }));

    // The canonical SKU is identity-reviewed but has no AuthorityActivated
    // receipt. Exercise the real write entrypoints and prove fail-closed rejects
    // before either catalogue changes or commercial lines are persisted.
    const skuBefore = await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    const skuObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    const deniedSkuUpdate = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: skuBefore.code, name: skuBefore.name, variety: skuBefore.variety, category: skuBefore.category,
      unit: skuBefore.unit, minQuantity: skuBefore.minQuantity.toString(), minVarieties: skuBefore.minVarieties,
      active: skuBefore.active, evidence: { note: "Synthetic pre-activation denial" },
    });
    const deniedSkuMutation = await call("/operations/commands", deniedSkuUpdate);
    assert.equal(deniedSkuMutation.response.status, 423, JSON.stringify(deniedSkuMutation.body));
    assert.equal(deniedSkuMutation.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.deepEqual(await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } }), skuBefore);
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } })).version, skuObjectBefore.version);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);

    const deniedQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `canonical-quote-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic pre-activation denial" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    deniedQuote.expectedVersion = 1;
    const deniedCanonicalQuote = await call("/operations/commands", deniedQuote);
    assert.equal(deniedCanonicalQuote.response.status, 423, JSON.stringify(deniedCanonicalQuote.body));
    assert.equal(deniedCanonicalQuote.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.equal(await db.operationOrderLine.count({ where: { orderId: canonicalOrderId } }), 0);
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).quoteVersion, 1);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedQuote.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedQuote.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedQuote.requestId } }), 0);

    // Synthetic activation receipt fixture exercises the full reader binding.
    // It is not evidence that the blocked production gate can activate today.
    const skuFingerprint = destinationFingerprints.find(item => item.destinationType === "sku" && item.destinationId === canonicalSku.id);
    assert.ok(skuFingerprint);
    const activatedSku = await db.catalogSku.update({ where: { id: canonicalSku.id }, data: { active: true } });
    const activatedSkuVersion = await db.operationObject.update({ where: { id: canonicalSku.id }, data: { version: 1 } });
    assert.equal(activatedSkuVersion.version, 1);
    const activatedSnapshot = {
      id: activatedSku.id, code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety,
      category: activatedSku.category, unit: activatedSku.unit, active: activatedSku.active,
      sourceSystem: activatedSku.sourceSystem, sourceId: activatedSku.sourceId, appSheet: activatedSku.appSheet,
    };
    const activationEntry = {
      skuId: canonicalSku.id, sourceKey: canonicalSkuDestination.sourceKey,
      baselineHash: skuFingerprint.dataHash, baselineVersion: skuFingerprint.operationVersion,
      activatedHash: appSheetCanonicalCurrentDestinationHash(activatedSnapshot, "sku"), activatedVersion: 1,
    };
    const activationManifest = {
      schemaVersion: 1, captureId: canonicalCapture.captureId, snapshotId: canonicalProjection.snapshotId,
      projectionHash, destinationIdentity, entries: [activationEntry],
    };
    const authorityRequestId = randomUUID();
    const authorityResponse = {
      requestId: authorityRequestId, targetId: "operations", version: 1,
      result: { authority: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement",
        captureManifestId: canonicalCapture.captureId, epoch: 3, approvedBy: ownerId }, appSheetSkuActivation: activationManifest },
    };
    await db.operationObject.upsert({
      where: { id: "operations" },
      create: { id: "operations", kind: "authority", version: 1, createdBy: ownerId },
      update: { kind: "authority", version: 1, createdBy: ownerId },
    });
    await db.commandReceipt.create({ data: {
      requestId: authorityRequestId, actorId: ownerId, targetId: "operations", command: "AuthorityActivated",
      bodyHash: hash("synthetic AuthorityActivated request"), response: authorityResponse, resultingVersion: 1,
      authorityEpoch: 2, occurredAt: now,
    } });
    await db.operationAudit.create({ data: {
      actorId: ownerId, action: "AuthorityActivated", objectId: "operations", requestId: authorityRequestId, details: { version: 1 },
    } });
    await db.operationAudit.create({ data: {
      actorId: ownerId, action: "appsheet.canonical_sku_activated", objectId: canonicalSku.id, requestId: authorityRequestId,
      details: {
        schemaVersion: 1, captureId: canonicalCapture.captureId, snapshotId: canonicalProjection.snapshotId,
        projectionHash, destinationIdentity, ...activationEntry, snapshot: activatedSnapshot,
      },
    } });

    const approvedSkuUpdate = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: true, evidence: { note: "Synthetic post-activation chain" },
    });
    approvedSkuUpdate.expectedVersion = 1;
    const allowedSkuMutation = await call("/operations/commands", approvedSkuUpdate);
    assert.equal(allowedSkuMutation.response.status, 200, JSON.stringify(allowedSkuMutation.body));
    const cataloguePatch = envelope(canonicalSku.id, "CatalogueSheetSaved", { patch: { availability: "Sí" } });
    cataloguePatch.expectedVersion = 2;
    const allowedCatalogueMutation = await call("/operations/commands", cataloguePatch);
    assert.equal(allowedCatalogueMutation.response.status, 200, JSON.stringify(allowedCatalogueMutation.body));
    const deactivation = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: false, evidence: { note: "Synthetic reversible availability change" },
    });
    deactivation.expectedVersion = 3;
    assert.equal((await call("/operations/commands", deactivation)).response.status, 200);
    const reactivation = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: true, evidence: { note: "Synthetic SKU reactivation" },
    });
    reactivation.expectedVersion = 4;
    assert.equal((await call("/operations/commands", reactivation)).response.status, 200);

    const positiveQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `canonical-eligible-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic reviewed SKU" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    positiveQuote.expectedVersion = 1;
    const quotedEligibleSku = await call("/operations/commands", positiveQuote);
    assert.equal(quotedEligibleSku.response.status, 200, JSON.stringify(quotedEligibleSku.body));
    const quotedLinesBeforeTamper = await db.operationOrderLine.findMany({ where: { orderId: canonicalOrderId }, select: { id: true, skuId: true } });

    // A malformed parent receipt invalidates the same SKU before a second quote
    // can replace persisted lines or emit a receipt/audit/outbox row.
    const tamperedAuthorityResponse = structuredClone(authorityResponse);
    tamperedAuthorityResponse.result.appSheetSkuActivation.captureId = "appsreal-0000000000000000";
    await db.commandReceipt.update({ where: { requestId: authorityRequestId }, data: { response: tamperedAuthorityResponse } });
    const deniedTamperedQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `tampered-parent-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic parent receipt denial" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    deniedTamperedQuote.expectedVersion = 2;
    const deniedTamperedParent = await call("/operations/commands", deniedTamperedQuote);
    assert.equal(deniedTamperedParent.response.status, 423, JSON.stringify(deniedTamperedParent.body));
    assert.equal(deniedTamperedParent.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: canonicalOrderId }, select: { id: true, skuId: true } }), quotedLinesBeforeTamper);
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).quoteVersion, 2);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
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
