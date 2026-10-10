import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import { cutoverGateIds, type CommandEnvelope } from "../shared/operations/contracts.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION, APPSHEET_CANONICAL_MAPPING_ID, APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../shared/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../shared/operations/appsheet-history.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { formatAppSheetInvoiceNumberForYear } from "../shared/operations/appsheet-invoice-rules.js";
import { appSheetSourceLotCaptureFixture } from "./support/appsheet-source-lot-fixture.js";

test("AppSheet invoices preserve exact line values and independent moto metadata while confirming atomically", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async t => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  const schema = `appsheet_invoice_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseUrl);
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
  const { AppSheetCanonicalError, stageAppSheetCanonicalMasters } = await import("../server/operations/appsheet-canonical.js");
  const { project: syntheticCanonicalProject, technicalReview: syntheticCanonicalReview } = await import("./support/appsheet-canonical-fixture.js");
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
    const invoiceData = (options: { preorder?: boolean; lineTotal?: string; quantity?: string; withMoto?: boolean; lineId?: string; pricePerGramMinor?: string } = {}) => ({
      memberId,
      invoiceNumber: "APP-2026-1042",
      invoiceDate,
      currency: "ARS",
      address: { street: "Calle sintética 123", city: "Salta" },
      note: "Aclaración de factura sintética",
      productPaymentMethod: "cash",
      lines: options.lineTotal === undefined && options.quantity === undefined && options.preorder
        ? []
        : [{
          id: options.lineId ?? `appsheet-line-${randomUUID()}`, skuId, date: "2026-10-04", scale: "escala-3",
          quantity: options.quantity ?? "3", totalMinor: options.lineTotal ?? "1201",
          ...(options.pricePerGramMinor === undefined ? {} : { pricePerGramMinor: options.pricePerGramMinor }),
        }],
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
    let preCaptureLegacyInvoice: CommandEnvelope | undefined;

    await t.test("legacy invoices and gates remain available before a canonical AppSheet capture", async () => {
      assert.equal(await db.appSheetCaptureManifest.count({ where: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM } }), 0);
      const invoiceNumber = `APP-2026-${randomUUID().slice(0, 8).toUpperCase()}`;
      preCaptureLegacyInvoice = envelope(`legacy-before-appsheet-${randomUUID()}`, "InvoiceSaved", { ...invoiceData({ preorder: true }), invoiceNumber });
      const savedInvoice = await send(preCaptureLegacyInvoice);
      assert.equal(savedInvoice.response.status, 200, JSON.stringify(savedInvoice.body));
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId: preCaptureLegacyInvoice.requestId } }) !== null, true);

      const gateId = cutoverGateIds[0]!;
      const legacyGate = await send(envelope(gateId, "CutoverGateReviewed", {
        gateId, cutoverProfile: "legacy", authorId: deniedId, evidence: { note: "Synthetic legacy gate before AppSheet capture" },
      }));
      assert.equal(legacyGate.response.status, 200, JSON.stringify(legacyGate.body));
      assert.equal(legacyGate.body.result.cutoverProfile, "legacy");
      assert.equal(legacyGate.body.result.captureId, null);
    });

    await t.test("a preliminary canonical snapshot blocks legacy operations without a capture manifest", async () => {
      assert.ok(preCaptureLegacyInvoice, "the positive legacy command must exist before any AppSheet source is staged");
      const snapshotWhere = { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION };
      assert.equal(await db.legacyImportSnapshot.count({ where: snapshotWhere }), 0);
      assert.equal(await db.appSheetCaptureManifest.count({ where: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM } }), 0);
      const originalAuthority = await db.operationAuthority.findUnique({ where: { id: "operations" } });
      const originalGates = await db.cutoverGate.findMany();
      const originalGateObjects = await db.operationObject.findMany({ where: { id: { in: [...cutoverGateIds, "operations"] } } });

      const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
      const fileHash = digest(`synthetic-appsheet-preliminary-${randomUUID()}`);
      const dataHash = digest(`synthetic-appsheet-preliminary-data-${randomUUID()}`);
      const captureId = `appsreal-${fileHash.slice(0, 16)}`;
      const snapshotId = `appsheet-preliminary-${randomUUID()}`;
      const snapshotIds = [snapshotId];
      const accountId = `appsheet-preliminary-cash-${randomUUID()}`;
      const stockLotId = `appsheet-preliminary-stock-${randomUUID()}`;
      const attemptedRequests: CommandEnvelope[] = [];
      const approvalFlagBefore = process.env.CLUB_OPERATIONS_APPROVED;
      process.env.CLUB_OPERATIONS_APPROVED = "true";
      try {
      await db.legacyImportSnapshot.create({ data: {
        id: snapshotId,
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        filename: "appsheet-live-capture",
        fileHash,
        importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
        status: "staged",
        createdBy: ownerId,
        reviewedBy: null,
        reviewedAt: null,
        captureManifestId: null,
        controls: { appSheetCanonical: {
          schemaVersion: 1,
          projectionKind: "masters",
          mappingId: APPSHEET_CANONICAL_MAPPING_ID,
          importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
          captureId,
          manifestHash: fileHash,
          dataHash,
          stabilityMode: "staged-delta",
          globalDelta: { globallyStable: false, unresolvedChangedPageCount: 1 },
        } },
        coverage: { schemaVersion: 1, appSheetCanonical: {
          captureId,
          sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
          manifestHash: fileHash,
          dataHash,
          stabilityMode: "staged-delta",
          delta: { globallyStable: false, unresolvedChangedPageCount: 1, changedPages: [{ sheetId: 1, pageIndex: 0 }] },
        } },
      } });
      assert.equal(await db.appSheetCaptureManifest.count({ where: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM } }), 0,
        "the real preliminary producer stores the source snapshot without an AppSheetCaptureManifest row");
      await db.operationAuthority.upsert({
        where: { id: "operations" },
        create: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null },
        update: { mode: "shadow", cutoverProfile: "legacy", captureManifestId: null },
      });
      await db.operationAccount.create({ data: {
        id: accountId, name: "Synthetic preliminary cash", currency: "ARS", kind: "cash", holder: "Fixture",
        purpose: "Preliminary snapshot guard", verified: true,
      } });
      await db.operationObject.create({ data: { id: accountId, kind: "account", version: 2, createdBy: ownerId } });

      const effects = async () => ({
        receipts: await db.commandReceipt.count(),
        audits: await db.operationAudit.count(),
        outbox: await db.operationOutbox.count(),
      });
      const assertRejectedWithoutEffects = async (request: CommandEnvelope, expectedCode: string) => {
        attemptedRequests.push(request);
        const before = await effects();
        const rejected = await send(request);
        assert.equal(rejected.response.status, 423, JSON.stringify(rejected.body));
        assert.equal(rejected.body.code, expectedCode);
        assert.deepEqual(await effects(), before);
        if (request.requestId !== preCaptureLegacyInvoice!.requestId)
          assert.equal(await db.commandReceipt.findUnique({ where: { requestId: request.requestId } }), null);
        return rejected;
      };

      const accountBefore = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
      const cashEffectsBefore = { events: await db.ledgerEvent.count(), legs: await db.ledgerLeg.count(), entries: await db.cashEntry.count() };
      const cashRequest = envelope(accountId, "AccountOpeningApproved", {
        amountMinor: "1200", preparedBy: deniedId, evidence: { note: "Source-less cash opening with a preliminary AppSheet snapshot" },
      }, 2);
      const cashRejected = await assertRejectedWithoutEffects(cashRequest, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(cashRejected.body.details?.blockers, ["opening_source_record_required"]);
      assert.equal(cashRejected.body.details?.captureId, captureId);
      assert.equal(cashRejected.body.details?.snapshotId, snapshotId);
      const accountAfter = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
      assert.equal(accountAfter.openingMinor, accountBefore.openingMinor);
      assert.equal(accountAfter.openingApprovedBy, accountBefore.openingApprovedBy);
      assert.deepEqual({ events: await db.ledgerEvent.count(), legs: await db.ledgerLeg.count(), entries: await db.cashEntry.count() }, cashEffectsBefore);

      const stockEffectsBefore = { lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() };
      const stockRequest = envelope(stockLotId, "StockOpeningRecorded", {
        skuId,
        label: "Synthetic source-less stock opening",
        quantity: "5",
        unitCost: "10",
        costCurrency: "ARS",
        receivedDate: today,
        locationId,
        preparedBy: deniedId,
        evidence: { note: "Source-less stock opening with a preliminary AppSheet snapshot" },
      });
      await assertRejectedWithoutEffects(stockRequest, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual({ lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() }, stockEffectsBefore);
      assert.equal(await db.inventoryLot.findUnique({ where: { id: stockLotId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: stockLotId } }), null);

      for (const gateId of cutoverGateIds) await db.cutoverGate.upsert({
        where: { id: gateId },
        create: { id: gateId, status: "approved", evidence: { note: "Synthetic generic legacy approval" }, approvedBy: deniedId,
          reviewedBy: ownerId, approvedAt: new Date() },
        update: { status: "approved", evidence: { note: "Synthetic generic legacy approval" }, approvedBy: deniedId,
          reviewedBy: ownerId, approvedAt: new Date(), captureManifestId: null },
      });
      const legacyGateId = cutoverGateIds[0]!;
      const legacyGateBefore = await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } });
      const legacyGateObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } });
      const legacyGateRequest = envelope(legacyGateId, "CutoverGateReviewed", {
        gateId: legacyGateId, cutoverProfile: "legacy", authorId: deniedId, evidence: { note: "Legacy gate after preliminary capture" },
      }, legacyGateObjectBefore.version);
        await assertRejectedWithoutEffects(legacyGateRequest, "APPSHEET_REPLACEMENT_REQUIRED");
        assert.deepEqual(await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } }), legacyGateBefore);
        assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } }), legacyGateObjectBefore);

        const activationRequest = envelope("operations", "AuthorityActivated", {
          cutoverProfile: "legacy", evidence: { note: "Legacy activation after preliminary capture" },
        });
        await assertRejectedWithoutEffects(activationRequest, "APPSHEET_REPLACEMENT_REQUIRED");
        const authorityAfterActivation = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
        assert.equal(authorityAfterActivation.mode, "shadow");
        assert.equal(authorityAfterActivation.cutoverProfile, "legacy");

        assert.equal((await db.operationAuthority.deleteMany({ where: { id: "operations" } })).count, 1);
        await db.operationAuthority.create({ data: { id: "operations", mode: "active", cutoverProfile: "legacy", captureManifestId: null } });
        const authorityBeforeReplay = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
        const replayOrderBefore = await db.operationOrder.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } });
        const replayObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } });
        const replayedInvoice = await assertRejectedWithoutEffects(preCaptureLegacyInvoice!, "APPSHEET_REPLACEMENT_REQUIRED");
        assert.notEqual(replayedInvoice.body.replay, true);
        assert.ok(await db.commandReceipt.findUnique({ where: { requestId: preCaptureLegacyInvoice!.requestId } }));
        assert.deepEqual(await db.operationOrder.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } }), replayOrderBefore);
        assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } }), replayObjectBefore);
        assert.equal((await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).epoch, authorityBeforeReplay.epoch);

        const newInvoiceRequest = envelope(`appsheet-legacy-after-preliminary-${randomUUID()}`, "InvoiceSaved", {
          ...invoiceData({ preorder: true }), invoiceNumber: `APP-2026-${randomUUID().slice(0, 8).toUpperCase()}`,
        });
        await assertRejectedWithoutEffects(newInvoiceRequest, "APPSHEET_REPLACEMENT_REQUIRED");
        assert.equal(await db.operationOrder.findUnique({ where: { id: newInvoiceRequest.targetId } }), null);
        assert.equal(await db.operationObject.findUnique({ where: { id: newInvoiceRequest.targetId } }), null);

        await db.legacyImportSnapshot.delete({ where: { id: snapshotId } });
        const metadataFreeSnapshotId = `appsheet-preliminary-metadata-free-${randomUUID()}`;
        snapshotIds.push(metadataFreeSnapshotId);
        await db.legacyImportSnapshot.create({ data: {
          id: metadataFreeSnapshotId,
          sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
          filename: "appsheet-live-capture",
          fileHash: digest(`synthetic-appsheet-preliminary-metadata-free-${randomUUID()}`),
          importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
          status: "staged",
          createdBy: ownerId,
          captureManifestId: null,
          controls: {},
          coverage: {},
        } });
        assert.equal((await db.operationAuthority.deleteMany({ where: { id: "operations" } })).count, 1);
        await db.operationAuthority.create({ data: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null } });
        const metadataFreeCashRequest = envelope(accountId, "AccountOpeningApproved", {
          amountMinor: "1200", preparedBy: deniedId, evidence: { note: "Source-less opening with canonical source metadata omitted" },
        }, 2);
        const metadataFreeCashRejected = await assertRejectedWithoutEffects(metadataFreeCashRequest, "APPSHEET_REPLACEMENT_NOT_READY");
        assert.deepEqual(metadataFreeCashRejected.body.details?.blockers, ["opening_source_record_required"]);
        assert.equal(metadataFreeCashRejected.body.details?.captureId, undefined);
        assert.equal(metadataFreeCashRejected.body.details?.snapshotId, metadataFreeSnapshotId);

        await db.legacyImportSnapshot.delete({ where: { id: metadataFreeSnapshotId } });
        const supportedHistoryImporters = [
          APPSHEET_HISTORY_IMPORTER_VERSION,
          "bombo-appsheet-history/1.1.0",
          "bombo-appsheet-history/1.0.0",
        ] as const;
        for (const importerVersion of supportedHistoryImporters) {
          const historyFileHash = digest(`synthetic-history-preliminary-${importerVersion}-${randomUUID()}`);
          const historyDataHash = digest(`synthetic-history-data-${randomUUID()}`);
          const historyCaptureId = `appsreal-${historyFileHash.slice(0, 16)}`;
          const historySnapshotId = `appsheet-history-preliminary-${randomUUID()}`;
          snapshotIds.push(historySnapshotId);
          const historyMappingId = importerVersion === APPSHEET_HISTORY_IMPORTER_VERSION
            ? APPSHEET_HISTORY_MAPPING_ID
            : "appsheet-live-history-v1";
          await db.legacyImportSnapshot.create({ data: {
            id: historySnapshotId,
            sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
            filename: "appsheet-live-capture",
            fileHash: historyFileHash,
            importerVersion,
            status: "staged",
            createdBy: ownerId,
            captureManifestId: null,
            controls: { appSheetHistoryStage: {
              schemaVersion: "appsheet-history-stage/v1",
              projectionKind: "history",
              sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
              mappingId: historyMappingId,
              importerVersion,
              captureId: historyCaptureId,
              manifestHash: historyFileHash,
              dataHash: historyDataHash,
              captureDefinitionHash: null,
              mode: "preliminary-delta",
              status: "staged",
            } },
            coverage: {
              schemaVersion: "appsheet-history-coverage/v1",
              projectionKind: "history",
              sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
              captureId: historyCaptureId,
              manifestHash: historyFileHash,
              dataHash: historyDataHash,
              captureDefinitionHash: null,
              appliedDefinitionHash: digest("synthetic-history-definition"),
              mode: "preliminary-delta",
              stability: { stable: false, cutoverEligible: false },
              pages: [],
              deltaEvidence: [],
            },
          } });
          assert.equal(await db.appSheetCaptureManifest.count({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM } }), 0,
            "history-only preliminary snapshots do not have capture manifests");

          const historyCashRequest = envelope(accountId, "AccountOpeningApproved", {
            amountMinor: "1200", preparedBy: deniedId, evidence: { note: `Source-less opening with history importer ${importerVersion}` },
          }, 2);
          const historyCashRejected = await assertRejectedWithoutEffects(historyCashRequest, "APPSHEET_REPLACEMENT_NOT_READY");
          assert.deepEqual(historyCashRejected.body.details?.blockers, ["opening_source_record_required"]);
          assert.equal(historyCashRejected.body.details?.captureId, historyCaptureId);
          assert.equal(historyCashRejected.body.details?.snapshotId, historySnapshotId);

          const historyStockLotId = `appsheet-history-stock-${randomUUID()}`;
          const historyStockRequest = envelope(historyStockLotId, "StockOpeningRecorded", {
            skuId, label: "Synthetic history-only source-less stock opening", quantity: "5", unitCost: "10", costCurrency: "ARS",
            receivedDate: today, locationId, preparedBy: deniedId,
            evidence: { note: `Source-less stock opening with history importer ${importerVersion}` },
          });
          const stockEffectsBefore = { lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() };
          const historyStockRejected = await assertRejectedWithoutEffects(historyStockRequest, "APPSHEET_REPLACEMENT_NOT_READY");
          assert.equal(historyStockRejected.body.details?.captureId, historyCaptureId);
          assert.equal(historyStockRejected.body.details?.snapshotId, historySnapshotId);
          assert.deepEqual({ lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() }, stockEffectsBefore);
          assert.equal(await db.inventoryLot.findUnique({ where: { id: historyStockLotId } }), null);
          assert.equal(await db.operationObject.findUnique({ where: { id: historyStockLotId } }), null);

          const historyGateBefore = await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } });
          const historyGateObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } });
          const historyGateRequest = envelope(legacyGateId, "CutoverGateReviewed", {
            gateId: legacyGateId, cutoverProfile: "legacy", authorId: deniedId,
            evidence: { note: `Legacy gate after history importer ${importerVersion}` },
          }, historyGateObjectBefore.version);
          const historyGateRejected = await assertRejectedWithoutEffects(historyGateRequest, "APPSHEET_REPLACEMENT_REQUIRED");
          assert.equal(historyGateRejected.body.details?.captureId, historyCaptureId);
          assert.equal(historyGateRejected.body.details?.snapshotId, historySnapshotId);
          assert.deepEqual(await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } }), historyGateBefore);
          assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } }), historyGateObjectBefore);

          const historyActivationRequest = envelope("operations", "AuthorityActivated", {
            cutoverProfile: "legacy", evidence: { note: `Legacy activation after history importer ${importerVersion}` },
          });
          const historyActivationRejected = await assertRejectedWithoutEffects(historyActivationRequest, "APPSHEET_REPLACEMENT_REQUIRED");
          assert.equal(historyActivationRejected.body.details?.captureId, historyCaptureId);
          assert.equal(historyActivationRejected.body.details?.snapshotId, historySnapshotId);
          assert.equal((await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).mode, "shadow");

          await db.operationAuthority.delete({ where: { id: "operations" } });
          await db.operationAuthority.create({ data: { id: "operations", mode: "active", cutoverProfile: "legacy", captureManifestId: null } });
          const activeLegacyAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
          const historyReplay = await assertRejectedWithoutEffects(preCaptureLegacyInvoice!, "APPSHEET_REPLACEMENT_REQUIRED");
          assert.equal(historyReplay.body.details?.captureId, historyCaptureId);
          assert.equal(historyReplay.body.details?.snapshotId, historySnapshotId);
          assert.notEqual(historyReplay.body.replay, true);
          assert.equal((await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).epoch, activeLegacyAuthority.epoch);
          await db.operationAuthority.delete({ where: { id: "operations" } });
          await db.operationAuthority.create({ data: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null } });
          await db.legacyImportSnapshot.delete({ where: { id: historySnapshotId } });
        }

        for (const variant of [
          { label: "missing", controls: {} },
          { label: "invalid", controls: { appSheetHistoryStage: {
            schemaVersion: "appsheet-history-stage/v1", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
            importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, captureId: `appsreal-${"0".repeat(16)}`,
            manifestHash: "f".repeat(64), mode: "preliminary-delta", status: "staged",
          } } },
        ]) {
          const metadataFileHash = digest(`synthetic-history-${variant.label}-metadata-${randomUUID()}`);
          const metadataSnapshotId = `appsheet-history-${variant.label}-metadata-${randomUUID()}`;
          snapshotIds.push(metadataSnapshotId);
          await db.legacyImportSnapshot.create({ data: {
            id: metadataSnapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "appsheet-live-capture",
            fileHash: metadataFileHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "staged", createdBy: ownerId,
            captureManifestId: null, controls: variant.controls, coverage: {},
          } });
          const historyMetadataFreeCashRequest = envelope(accountId, "AccountOpeningApproved", {
            amountMinor: "1200", preparedBy: deniedId, evidence: { note: `History source with ${variant.label} metadata` },
          }, 2);
          const historyMetadataFreeRejected = await assertRejectedWithoutEffects(historyMetadataFreeCashRequest, "APPSHEET_REPLACEMENT_NOT_READY");
          assert.deepEqual(historyMetadataFreeRejected.body.details?.blockers, ["opening_source_record_required"]);
          assert.equal(historyMetadataFreeRejected.body.details?.captureId, undefined);
          assert.equal(historyMetadataFreeRejected.body.details?.snapshotId, metadataSnapshotId);
          await db.legacyImportSnapshot.delete({ where: { id: metadataSnapshotId } });
        }
      } finally {
        if (approvalFlagBefore === undefined) delete process.env.CLUB_OPERATIONS_APPROVED;
        else process.env.CLUB_OPERATIONS_APPROVED = approvalFlagBefore;
        const requestIds = attemptedRequests.map(request => request.requestId).filter(requestId => requestId !== preCaptureLegacyInvoice?.requestId);
        await db.ledgerLeg.deleteMany({ where: { accountId } });
        await db.ledgerEvent.deleteMany({ where: { requestId: { in: requestIds } } });
        await db.stockFact.deleteMany({ where: { requestId: { in: requestIds } } });
        await db.stockBalance.deleteMany({ where: { lotId: stockLotId } });
        await db.inventoryLot.deleteMany({ where: { id: stockLotId } });
        await db.operationOutbox.deleteMany({ where: { requestId: { in: requestIds } } });
        await db.operationAudit.deleteMany({ where: { requestId: { in: requestIds } } });
        await db.commandReceipt.deleteMany({ where: { requestId: { in: requestIds } } });
        await db.operationObject.deleteMany({ where: { id: { in: [...cutoverGateIds, "operations", accountId, stockLotId] } } });
        for (const object of originalGateObjects) await db.operationObject.create({ data: {
          id: object.id, kind: object.kind, version: object.version, createdBy: object.createdBy,
        } });
        await db.operationAccount.deleteMany({ where: { id: accountId } });
        await db.operationAuthority.deleteMany({ where: { id: "operations" } });
        if (originalAuthority) await db.operationAuthority.create({ data: {
          id: originalAuthority.id,
          mode: originalAuthority.mode,
          cutoverProfile: originalAuthority.cutoverProfile,
          captureManifestId: originalAuthority.captureManifestId,
          epoch: originalAuthority.epoch,
          firstRealWriteAt: originalAuthority.firstRealWriteAt,
          approvedBy: originalAuthority.approvedBy,
          evidence: originalAuthority.evidence === null ? Prisma.DbNull : originalAuthority.evidence as Prisma.InputJsonValue,
        } });
        await db.cutoverGate.deleteMany();
        for (const gate of originalGates) await db.cutoverGate.create({ data: {
          id: gate.id,
          status: gate.status,
          evidence: gate.evidence === null ? Prisma.DbNull : gate.evidence as Prisma.InputJsonValue,
          captureManifestId: gate.captureManifestId,
          approvedBy: gate.approvedBy,
          reviewedBy: gate.reviewedBy,
          approvedAt: gate.approvedAt,
        } });
        await db.legacyImportSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
      }
    });

    await t.test("inactive native SKU is rejected before a stock opening writes any state", async () => {
      const inactiveSkuId = `inactive-native-opening-${randomUUID()}`;
      const lotId = `inactive-native-opening-lot-${randomUUID()}`;
      await db.catalogSku.create({ data: {
        id: inactiveSkuId, code: inactiveSkuId, name: "Inactive native opening fixture", variety: "Fixture", category: "Fixture", unit: "g", active: false,
      } });
      const request = envelope(lotId, "StockOpeningRecorded", {
        skuId: inactiveSkuId, label: "Inactive native opening", quantity: "5", unitCost: "10", costCurrency: "ARS",
        receivedDate: today, locationId, preparedBy: deniedId, evidence: { note: "Inactive native SKU must remain unavailable" },
      });
      const effectsBefore = {
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        receipts: await db.commandReceipt.count(), audits: await db.operationAudit.count(), outbox: await db.operationOutbox.count(),
      };
      const rejected = await send(request);
      assert.equal(rejected.response.status, 422, JSON.stringify(rejected.body));
      assert.equal(rejected.body.code, "STOCK_OPENING_SKU_REQUIRED");
      assert.deepEqual({
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        receipts: await db.commandReceipt.count(), audits: await db.operationAudit.count(), outbox: await db.operationOutbox.count(),
      }, effectsBefore);
      assert.equal(await db.inventoryLot.findUnique({ where: { id: lotId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: lotId } }), null);
      assert.equal((await db.catalogSku.findUniqueOrThrow({ where: { id: inactiveSkuId } })).active, false);
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
      assert.equal(detail.order.financialState, null, "the legacy-facing projection stays unknown while the AppSheet total formula is pending");
      assert.equal(detail.order.legacyFinancialProjectionState, "unknown");
      assert.equal(detail.order.legacyFinancialProjectionReason, "invoice_total_pending");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: targetId } })).financialState, "unpaid",
        "the native order payment state remains separate from the unresolved legacy projection");
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
      assert.equal(Object.hasOwn(detail.order.quote.lines[0], "pricePerGramMinor"), false, "un snapshot legado no debe inventar el precio por gramo desde el total o unitPrice técnico");
      assert.equal(Object.hasOwn(detail.order.quote.input.lines[0], "pricePerGramMinor"), false);
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

    await t.test("a confirmed invoice preserves its explicit price per gram separately from the captured line total", async () => {
      const targetId = `appsheet-price-per-gram-${randomUUID()}`;
      const pricePerGramMinor = "98765";
      const input = invoiceData({ preorder: false, lineTotal: "1201", quantity: "3", pricePerGramMinor });
      const saved = await command(envelope(targetId, "InvoiceSaved", input));
      assert.equal(saved.body.result.commercialState, "confirmed");

      const detail = await (await call(`/operations/orders/${targetId}`)).json() as any;
      assert.equal(detail.order.quote.input.lines[0].pricePerGramMinor, pricePerGramMinor);
      assert.equal(detail.order.quote.lines[0].pricePerGramMinor, pricePerGramMinor);
      assert.equal(detail.order.quote.lines[0].explicitTotalMinor, "1201");
      assert.equal(detail.order.lines[0].revenueMinor, "1201");
      assert.equal(detail.order.lines[0].referenceMinor, "1201");
      assert.equal(detail.order.quote.input.lines[0].totalMinor, "1201");
      assert.equal(detail.order.capturedProductMinor, "1201");
      assert.equal(detail.reservations.length, 1);
      assert.equal(detail.deliveries.length, 0);
    });

    await t.test("a negative explicit price per gram rejects before creating invoice state", async () => {
      const targetId = `appsheet-invalid-price-per-gram-${randomUUID()}`;
      const input = invoiceData({ lineTotal: "1201", quantity: "3" });
      const line = (input.lines as Array<Record<string, unknown>>)[0]!;
      const request = envelope(targetId, "InvoiceSaved", { ...input, lines: [{ ...line, pricePerGramMinor: "-1" }] });
      const before = {
        orders: await db.operationOrder.count(),
        lines: await db.operationOrderLine.count(),
        reservations: await db.stockReservation.count(),
        deliveries: await db.deliveryAssignment.count(),
      };

      const response = await call("/operations/commands", ownerId, request);
      const body = await response.json() as { error?: string };
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(body.error ?? "", /pricePerGramMinor/);
      assert.deepEqual({
        orders: await db.operationOrder.count(),
        lines: await db.operationOrderLine.count(),
        reservations: await db.stockReservation.count(),
        deliveries: await db.deliveryAssignment.count(),
      }, before);
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
    });

    await t.test("stock shortage rolls invoice, reservation and moto delivery back together", async () => {
      const targetId = `appsheet-shortage-${randomUUID()}`;
      const request = envelope(targetId, "InvoiceSaved", invoiceData({ quantity: "101", lineTotal: "40400", withMoto: true, pricePerGramMinor: "98765" }));
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
      const editedPreorder = await (await call(`/operations/orders/${targetId}`)).json() as any;
      assert.equal(Object.hasOwn(editedPreorder.order.quote.input.lines[0], "pricePerGramMinor"), false);
      assert.equal(Object.hasOwn(editedPreorder.order.quote.lines[0], "pricePerGramMinor"), false);
      assert.equal(editedPreorder.order.quote.lines[0].explicitTotalMinor, "1001");
      assert.equal(editedPreorder.order.lines[0].revenueMinor, "1001");

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
      const confirmOnUpdateRequest = envelope(targetId, "InvoiceUpdated", {
        ...invoiceData({ preorder: false, lineTotal: "1001", quantity: "2" }),
        acceptance: { reference: "synthetic-conversion-acceptance" },
      }, 2);
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
      assert.equal(Object.hasOwn(detail.order.quote.input.lines[0], "pricePerGramMinor"), false);
      assert.equal(Object.hasOwn(detail.order.quote.lines[0], "pricePerGramMinor"), false);
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

    await t.test("replacement invoices fail closed without a seed, then reserve numbers atomically and preserve them on edit", async (replacementTest) => {
      const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
      const manifestHash = digest(`synthetic-invoice-capture-${randomUUID()}`);
      const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
      const captureNow = new Date(Date.now() - 60_000);
      const pauseStartedAt = new Date(captureNow.getTime() - 4_000);
      const firstReadAt = new Date(captureNow.getTime() - 3_000);
      const verificationStartedAt = new Date(captureNow.getTime() - 2_000);
      const verificationCompletedAt = new Date(captureNow.getTime() - 1_000);
      const pageManifest = [
        { sheetId: 1, title: "C_Cliente", bodyRead: true, bodyExcluded: false },
        { sheetId: 2, title: "D_Catalogo_Mercaderia", bodyRead: true, bodyExcluded: false },
        { sheetId: 3, title: "T_Usuarios", bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted" },
      ].map(sheet => {
        const pageHash = digest(`synthetic-page-${sheet.sheetId}`);
        return { ...sheet, path: `pages/${sheet.sheetId}-0-1.json`, pageIndex: 0, startRow: 1, endRow: 1,
          pageHash, verifiedPageHash: pageHash, stable: true, counts: { rowsWithValues: 1 } };
      });
      const pageRefs = pageManifest.map(page => ({ path: page.path, sheetId: page.sheetId, pageIndex: page.pageIndex,
        startRow: page.startRow, endRow: page.endRow, pageHash: page.pageHash, counts: page.counts }));
      const dataHash = digest(canonicalJson(pageRefs));
      const dataCoverage = {
        metadataStable: true, headersStableAll: true, totalPages: pageManifest.length, rowsWithValues: pageManifest.length,
        dataRecordCount: 3, failedPages: 0, changedPages: 0, unresolvedFormulaCount: 0,
        sheets: [
          { sheetId: 1, title: "C_Cliente", pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false },
          { sheetId: 2, title: "D_Catalogo_Mercaderia", pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false },
          { sheetId: 3, title: "T_Usuarios", pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0,
            bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted" },
        ],
      };
      const captureStability = { stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true, scanComplete: true,
        firstPassPages: 3, verifiedPages: 3, matchedPages: 3, changedPages: 0, failedPages: 0, missingPages: 0,
        unresolvedFormulaCount: 0, sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"] };
      await db.appSheetCaptureManifest.create({ data: {
        captureId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: "synthetic-invoice-spreadsheet", spreadsheetId: "synthetic-invoice-spreadsheet",
        metadataHash: "a".repeat(64), headersHash: "b".repeat(64), manifestHash, dataHash, definitionHash: null,
        stability: captureStability,
        firstReadAt, verificationStartedAt, verificationCompletedAt, cutoffAt: captureNow,
        dataCoverage, pageManifest, dataSheetCount: 2, dataPageCount: 3, dataRecordCount: 3,
        dataFormulaCount: 0, dataUnresolvedFormulaCount: 0, definitionTableCount: null, definitionColumnCount: null,
        definitionSliceCount: null, definitionViewCount: null, definitionActionCount: null, definitionBotCount: null,
        definitionWorkflowRuleCount: null, definitionFormatRuleCount: null,
      } });
      const snapshotId = `synthetic-invoice-history-${randomUUID()}`;
      const invoiceSourceRecordId = `synthetic-invoice-source-${randomUUID()}`;
      const cashSourceRecordId = `synthetic-cash-source-${randomUUID()}`;
      const stockSourceRecordId = `synthetic-stock-source-${randomUUID()}`;
      const stockMovementSourceRecordId = `synthetic-stock-movement-source-${randomUUID()}`;
      const invoiceSourceKey = "synthetic-invoice-source-key";
      const cashSourceKey = "synthetic-cash-source-key";
      const stockSourceKey = "synthetic-stock-source-key";
      const stockMovementSourceKey = "synthetic-stock-movement-source-key";
      const invoiceContentHash = digest("synthetic-invoice-content");
      const cashContentHash = digest("synthetic-cash-content");
      const stockContentHash = digest("synthetic-stock-content");
      const stockMovementContentHash = digest("synthetic-stock-movement-content");
      const publicationFingerprint = digest("synthetic-history-publication");
      const appliedDefinitionHash = digest("synthetic-history-applied-definition");
      const snapshotCoverage = {
        schemaVersion: "appsheet-history-coverage/v1",
        projectionKind: "history",
        sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
        captureId,
        manifestHash,
        dataHash,
        captureDefinitionHash: null,
        appliedDefinitionHash,
        mode: "stable",
        stability: captureStability,
        pages: pageManifest.map(({ sheetId, title, pageIndex, startRow, endRow, pageHash, verifiedPageHash, stable }) =>
          ({ sheetId, title, pageIndex, startRow, endRow, pageHash, verifiedPageHash, stable })),
        deltaEvidence: [],
        sheets: [{ sourceTable: "C_Facturacion", sourceRecordCount: 1, factCount: 1, definitionTableMatch: "unique", changedPageIndexes: [] }],
      };
      await db.legacyImportSnapshot.create({ data: {
        id: snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "appsheet-live-capture", fileHash: manifestHash,
        importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "reviewed", createdBy: ownerId, reviewedBy: deniedId, reviewedAt: captureNow,
        captureManifestId: captureId, coverage: snapshotCoverage,
        controls: { appSheetHistoryStage: { schemaVersion: "appsheet-history-stage/v1", projectionKind: "history",
          sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, captureId, manifestHash, dataHash, captureDefinitionHash: null,
          mode: "stable", definitionHash: appliedDefinitionHash, mappingId: APPSHEET_HISTORY_MAPPING_ID, status: "staged" } },
      } });
      const createSourceRecord = (id: string, sourceTable: string, sourceKey: string, sourceRow: number, contentHash: string, normalized: Prisma.InputJsonValue) =>
        db.legacySourceRecord.create({ data: { id, snapshotId, sourceTable, sourceKey, sourceRow, fileHash: manifestHash, contentHash,
          importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, original: {}, normalized, treatment: "fact_candidate" } });
      const createFact = (input: { id: string; sourceRecordId: string; sourceTable: string; sourceKey: string; sourceRow: number; sourceHash: string;
        kind: string; occurredOn?: string; dateState: "known" | "absent" | "invalid" | "not-applicable";
        amountMinor?: bigint; amountState: "known" | "absent" | "invalid" | "not-applicable";
        currency?: string; currencyState: "known" | "absent" | "invalid" | "not-applicable";
        quantity?: string; quantityState: "known" | "absent" | "invalid" | "not-applicable";
        unit?: string; unitState: "known" | "absent" | "invalid" | "not-applicable"; attributes?: Prisma.InputJsonObject }) =>
        db.legacyHistoricalFact.create({ data: { id: input.id, snapshotId, sourceRecordId: input.sourceRecordId, sourceTable: input.sourceTable,
          sourceKey: input.sourceKey, sourceRow: input.sourceRow, sourceHash: input.sourceHash, mappingId: APPSHEET_HISTORY_MAPPING_ID,
          kind: input.kind, occurredOn: input.occurredOn ?? null, dateState: input.dateState, currency: input.currency ?? null, currencyState: input.currencyState,
          unit: input.unit ?? null, unitState: input.unitState, amountMinor: input.amountMinor ?? null, amountState: input.amountState,
          quantity: input.quantity ?? null, quantityState: input.quantityState, attributes: input.attributes ?? {}, createdBy: ownerId } });
      const historyDate = today;
      await createSourceRecord(invoiceSourceRecordId, "C_Facturacion", invoiceSourceKey, 2, invoiceContentHash,
        { columns: [{ header: "Id_Factura", value: invoiceSourceKey }, { header: "Id_Oculto", value: "41", exactDecimal: "41" },
          { header: "N_factura", value: "2025|FA0040" }, { header: "Fecha", value: today },
          { header: "Total_Facturado", value: "12.00", exactDecimal: "12.00" }, { header: "Cantidad_Gr", value: "5.000", exactDecimal: "5" }] });
      await createFact({ id: `synthetic-invoice-fact-${randomUUID()}`, sourceRecordId: invoiceSourceRecordId, sourceTable: "C_Facturacion",
        sourceKey: invoiceSourceKey, sourceRow: 2, sourceHash: invoiceContentHash, kind: "invoice", occurredOn: historyDate, dateState: "known",
        amountMinor: 1200n, amountState: "known", currencyState: "absent", quantity: "5", quantityState: "known", unit: "g", unitState: "known" });
      await createSourceRecord(cashSourceRecordId, "Movimiento", cashSourceKey, 3, cashContentHash,
        { columns: [{ header: "ID_Movimiento", value: cashSourceKey }, { header: "Fecha", value: today },
          { header: "Monto", value: "12.00", exactDecimal: "12.00" }, { header: "Tipo_Moneda", value: "ARS" }] });
      await createFact({ id: `synthetic-cash-fact-${randomUUID()}`, sourceRecordId: cashSourceRecordId, sourceTable: "Movimiento", sourceKey: cashSourceKey,
        sourceRow: 3, sourceHash: cashContentHash, kind: "cash", occurredOn: historyDate, dateState: "known", amountMinor: 1200n, amountState: "known",
        currency: "ARS", currencyState: "known", quantityState: "not-applicable", unitState: "not-applicable" });
      // Synthetic D_Stock is only a gate fixture; no live history rule or physical-count evidence is implied.
      await createSourceRecord(stockSourceRecordId, "D_Stock", stockSourceKey, 4, stockContentHash,
        { columns: [{ header: "Cantidad", value: "5", exactDecimal: "5" }, { header: "Unidad", value: "g" }, { header: "Codigo_Detalle", value: "invoice-source-sku" }] });
      await createFact({ id: `synthetic-stock-fact-${randomUUID()}`, sourceRecordId: stockSourceRecordId, sourceTable: "D_Stock", sourceKey: stockSourceKey,
        sourceRow: 4, sourceHash: stockContentHash, kind: "stock", dateState: "not-applicable", amountState: "not-applicable", currencyState: "not-applicable",
        quantity: "5", quantityState: "known", unit: "g", unitState: "known",
        attributes: { relationships: [{ targetTable: "D_Catalogo_Mercaderia", status: "unique", targetSourceKey: "invoice-source-sku" }] } });
      // A safe historical movement can carry quantity, grams, and a unique SKU relation, but an Entrada remains a ledger delta.
      await createSourceRecord(stockMovementSourceRecordId, "Mov_Stock1", stockMovementSourceKey, 5, stockMovementContentHash,
        { columns: [{ header: "ID_Movimiento", value: stockMovementSourceKey }, { header: "Tipo", value: "Entrada" },
          { header: "Cantidad_Gr", value: "5.000", exactDecimal: "5" }, { header: "Codigo_Detalle", value: "invoice-source-sku" }] });
      await createFact({ id: `synthetic-stock-movement-fact-${randomUUID()}`, sourceRecordId: stockMovementSourceRecordId,
        sourceTable: "Mov_Stock1", sourceKey: stockMovementSourceKey, sourceRow: 5, sourceHash: stockMovementContentHash,
        kind: "stock", occurredOn: historyDate, dateState: "known", amountState: "not-applicable", currencyState: "not-applicable",
        quantity: "5", quantityState: "known", unit: "g", unitState: "known",
        attributes: { relationships: [{ targetTable: "D_Catalogo_Mercaderia", status: "unique", targetSourceKey: "invoice-source-sku" }] } });
      await db.legacyHistoryPublication.create({ data: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, snapshotId, fileHash: manifestHash,
        mappingId: APPSHEET_HISTORY_MAPPING_ID, fingerprint: publicationFingerprint, publishedBy: ownerId, evidence: { reference: "synthetic fixture" } } });

      const invoiceRef = { sourceRecordId: invoiceSourceRecordId, sourceRow: 2, sourceHash: invoiceContentHash,
        sourceKeyHash: digest(invoiceSourceKey), hiddenId: "41" };
      const sourceBindingHash = digest(canonicalJson({ captureId, manifestHash, dataHash, snapshotId,
        mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint, rows: [{ ...invoiceRef, invoiceNumber: "2025|FA0040" }] }));
      const validPreviewPayload = { captureId, manifestHash, dataHash, snapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint,
        sourceBindingHash, invoiceRecordCount: 1, numberedInvoiceCount: 1, unnumberedInvoiceCount: 0, duplicateInvoiceNumberCount: 0,
        duplicateHiddenIdCount: 0, maxHiddenId: "41" };
      const validPreviewDigest = digest(canonicalJson(validPreviewPayload));

      const seedRequest = envelope(captureId, "AppSheetInvoiceSequenceSeeded", {
        captureId, snapshotId, previewDigest: validPreviewDigest, evidence: { note: "Synthetic reviewed seed fixture without its final pause gate." },
      });
      const seedRejected = await send(seedRequest);
      assert.equal(seedRejected.response.status, 423, JSON.stringify(seedRejected.body));
      assert.equal(seedRejected.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.equal(await db.appSheetInvoiceSequence.count(), 0);
      assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: captureId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: seedRequest.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: seedRequest.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: seedRequest.requestId } }), 0);

      const accountId = `appsheet-final-delta-cash-${randomUUID()}`;
      await command(envelope(accountId, "AccountCreated", { name: "Synthetic preactivation cash", currency: "ARS", kind: "cash", holder: "Fixture", purpose: "Final delta gate test" }));
      await command(envelope(accountId, "AccountVerified", { evidence: { note: "Synthetic account verification" } }, 1));
      const skuId = `appsheet-final-delta-sku-${randomUUID()}`;
      const locationId = `appsheet-final-delta-location-${randomUUID()}`;
      await db.catalogSku.create({ data: { id: skuId, code: skuId, name: "Synthetic cutover SKU", variety: "Fixture", category: "Fixture", unit: "g", sourceId: "invoice-source-sku" } });
      await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic cutover location" } });

      const assertNoCommandEffects = async (request: CommandEnvelope) => {
        assert.equal(await db.commandReceipt.findUnique({ where: { requestId: request.requestId } }), null);
        assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
        assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
      };
      const cashOpeningRequest = (suffix: string) => envelope(accountId, "AccountOpeningApproved", {
        amountMinor: "1200", preparedBy: deniedId, evidence: { note: `Synthetic ${suffix} cash opening` }, sourceRecordId: cashSourceRecordId,
      }, 2);
      const requireBlockedOpening = async (request: CommandEnvelope) => {
        const result = await send(request);
        assert.equal(result.response.status, 423, JSON.stringify(result.body));
        assert.equal(result.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
        await assertNoCommandEffects(request);
        const account = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
        assert.equal(account.openingMinor, 0n);
        assert.equal(account.openingApprovedBy, null);
        assert.equal(await db.ledgerEvent.count({ where: { kind: "opening", sourceObjectId: accountId } }), 0);
        assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: accountId } })).version, 2);
      };
      await requireBlockedOpening(cashOpeningRequest("ungated"));

      const stockLotId = `appsheet-final-delta-lot-${randomUUID()}`;
      const stockRequest = envelope(stockLotId, "StockOpeningRecorded", { skuId, label: "Synthetic source opening", quantity: "5", unitCost: "10",
        costCurrency: "ARS", receivedDate: today, locationId, preparedBy: deniedId, evidence: { note: "Synthetic ungated stock opening" },
        sourceRecordId: stockSourceRecordId });
      const stockRejected = await send(stockRequest);
      assert.equal(stockRejected.response.status, 423, JSON.stringify(stockRejected.body));
      assert.equal(stockRejected.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      await assertNoCommandEffects(stockRequest);
      assert.equal(await db.inventoryLot.findUnique({ where: { id: stockLotId } }), null);
      assert.equal(await db.stockFact.count({ where: { requestId: stockRequest.requestId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: stockLotId } }), null, "the provisional lot aggregate rolls back");

      const createFinalDeltaGate = async (options: { bindingCaptureId?: string; authorId?: string; stale?: boolean } = {}) => {
        const finalDelta = { schemaVersion: 1, manualPauseStartedAt: pauseStartedAt.toISOString(), manualPauseEndedAt: null,
          manualPauseEvidenceRef: "pause-log:synthetic-final-delta", capture: { captureId, manifestHash, dataHash,
            firstReadAt: firstReadAt.toISOString(), verificationStartedAt: verificationStartedAt.toISOString(),
            verificationCompletedAt: verificationCompletedAt.toISOString(), cutoffAt: captureNow.toISOString(), sourceWriteDetected: false },
          expectedHandoffChanges: { disposition: "separate-review", reference: "delta-review:synthetic-final-delta" } };
        if (options.stale) finalDelta.capture.manifestHash = "f".repeat(64);
        const evidence = { humanEvidence: { reference: "synthetic gate author and reviewer" }, appSheetReplacement: { schemaVersion: 1,
          captureId: options.bindingCaptureId ?? captureId, manifestHash, dataHash, captureDefinitionHash: null, appliedDefinitionHash: "e".repeat(64),
          gateProof: { finalDelta } } };
        await db.cutoverGate.upsert({ where: { id: "final-delta-reconciled" },
          create: { id: "final-delta-reconciled", status: "approved", evidence, captureManifestId: captureId,
            approvedBy: options.authorId ?? deniedId, reviewedBy: scopedId, approvedAt: new Date() },
          update: { status: "approved", evidence, captureManifestId: captureId,
            approvedBy: options.authorId ?? deniedId, reviewedBy: scopedId, approvedAt: new Date() } });
      };
      await createFinalDeltaGate({ bindingCaptureId: `appsreal-${"f".repeat(16)}` });
      await requireBlockedOpening(cashOpeningRequest("wrong-capture"));
      await createFinalDeltaGate({ stale: true });
      await requireBlockedOpening(cashOpeningRequest("stale-proof"));
      const inactiveGateAuthorId = "appsheet-invoice-inactive-gate-author";
      await db.user.create({ data: { id: inactiveGateAuthorId, name: "Inactive gate author", email: `${inactiveGateAuthorId}@appsheet-invoice.test`,
        password, role: "viewer", active: false } });
      await createFinalDeltaGate({ authorId: inactiveGateAuthorId });
      await requireBlockedOpening(cashOpeningRequest("inactive-gate-author"));

      await createFinalDeltaGate();
      assert.equal(await db.operationAuthority.findUnique({ where: { id: "operations" } }), null, "openings precede authority activation");
      const cashflowOpeningRequest = cashOpeningRequest("matching-cashflow-under-approved-gate");
      const cashflowOpeningRejected = await send(cashflowOpeningRequest);
      assert.equal(cashflowOpeningRejected.response.status, 423, JSON.stringify(cashflowOpeningRejected.body));
      assert.equal(cashflowOpeningRejected.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(cashflowOpeningRejected.body.details?.blockers, ["cash_opening_source_is_cashflow"]);
      await assertNoCommandEffects(cashflowOpeningRequest);
      const accountAfterCashflow = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
      assert.equal(accountAfterCashflow.openingMinor, 0n);
      assert.equal(accountAfterCashflow.openingApprovedBy, null);
      assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: accountId } })).version, 2);
      assert.equal(await db.ledgerEvent.count({ where: { kind: "opening", sourceObjectId: accountId } }), 0);

      const movementLotId = `appsheet-final-delta-movement-lot-${randomUUID()}`;
      const movementRequest = envelope(movementLotId, "StockOpeningRecorded", {
        skuId, label: "Synthetic ledger movement incorrectly proposed as opening", quantity: "5", unitCost: "10",
        costCurrency: "ARS", receivedDate: today, locationId, preparedBy: deniedId,
        evidence: { note: "Synthetic movement must not become an opening balance" }, sourceRecordId: stockMovementSourceRecordId,
      });
      const stockStateBeforeMovement = {
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        baselineBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true, reserved: true } }),
      };
      const movementRejected = await send(movementRequest);
      assert.equal(movementRejected.response.status, 423, JSON.stringify(movementRejected.body));
      assert.equal(movementRejected.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(movementRejected.body.details?.blockers, ["stock_opening_source_is_ledger_movement"]);
      await assertNoCommandEffects(movementRequest);
      assert.deepEqual({
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        baselineBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true, reserved: true } }),
      }, stockStateBeforeMovement);
      assert.equal(await db.inventoryLot.findUnique({ where: { id: movementLotId } }), null);
      assert.equal(await db.stockFact.count({ where: { requestId: movementRequest.requestId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: movementLotId } }), null);

      const canonicalOpeningSkuId = `appsheet-unreviewed-opening-sku-${randomUUID()}`;
      const unreviewedActiveSkus = [
        { id: canonicalOpeningSkuId, label: "active canonical SKU before authority review", sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM },
        { id: `appsheet-partial-opening-sku-${randomUUID()}`, label: "partial-provenance SKU", sourceSystem: null },
        { id: `appsheet-external-opening-sku-${randomUUID()}`, label: "external-provenance SKU", sourceSystem: "legacy-catalog" },
      ];
      const stockStateBeforeUnreviewedActive = {
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
      };
      for (const [index, fixture] of unreviewedActiveSkus.entries()) {
        const activeSkuId = fixture.id;
        const activeLotId = `appsheet-unreviewed-active-opening-lot-${index}-${randomUUID()}`;
        await db.catalogSku.create({ data: {
          id: activeSkuId, code: activeSkuId, name: fixture.label, variety: "Fixture", category: "Fixture", unit: "g",
          sourceSystem: fixture.sourceSystem, sourceId: "invoice-source-sku", active: true,
        } });
        const activeSkuRequest = envelope(activeLotId, "StockOpeningRecorded", {
          skuId: activeSkuId, label: fixture.label, quantity: "5", unitCost: "10", costCurrency: "ARS",
          receivedDate: today, locationId, preparedBy: deniedId, evidence: { note: fixture.label }, sourceRecordId: stockSourceRecordId,
        });
        const activeSkuRejected = await send(activeSkuRequest);
        assert.equal(activeSkuRejected.response.status, 423, JSON.stringify(activeSkuRejected.body));
        assert.equal(activeSkuRejected.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
        await assertNoCommandEffects(activeSkuRequest);
        assert.equal(await db.inventoryLot.findUnique({ where: { id: activeLotId } }), null);
        assert.equal(await db.stockFact.count({ where: { requestId: activeSkuRequest.requestId } }), 0);
        assert.equal(await db.operationObject.findUnique({ where: { id: activeLotId } }), null);
      }
      assert.deepEqual({
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
      }, stockStateBeforeUnreviewedActive);
      assert.equal((await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalOpeningSkuId } })).active, true,
        "rejecting the pre-authority canonical opening leaves the SKU unchanged");
      await db.catalogSku.update({ where: { id: canonicalOpeningSkuId }, data: { active: false } });

      const inactiveCanonicalLotId = `appsheet-unreviewed-opening-lot-${randomUUID()}`;
      const inactiveCanonicalRequest = envelope(inactiveCanonicalLotId, "StockOpeningRecorded", {
        skuId: canonicalOpeningSkuId, label: "Unreviewed inactive canonical opening", quantity: "5", unitCost: "10", costCurrency: "ARS",
        receivedDate: today, locationId, preparedBy: deniedId, evidence: { note: "Only a SKU in the exact reviewed capture may open stock" },
        sourceRecordId: stockSourceRecordId,
      });
      const stockStateBeforeCanonical = {
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        baselineBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true, reserved: true } }),
      };
      const inactiveCanonicalRejected = await send(inactiveCanonicalRequest);
      assert.equal(inactiveCanonicalRejected.response.status, 423, JSON.stringify(inactiveCanonicalRejected.body));
      assert.equal(inactiveCanonicalRejected.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(inactiveCanonicalRejected.body.details?.blockers, ["canonical_master_snapshot_missing_or_ambiguous"]);
      await assertNoCommandEffects(inactiveCanonicalRequest);
      assert.deepEqual({
        lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count(),
        baselineBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true, reserved: true } }),
      }, stockStateBeforeCanonical);
      assert.equal(await db.inventoryLot.findUnique({ where: { id: inactiveCanonicalLotId } }), null);
      assert.equal(await db.stockFact.count({ where: { requestId: inactiveCanonicalRequest.requestId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: inactiveCanonicalLotId } }), null);
      assert.equal((await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalOpeningSkuId } })).active, false,
        "a failed pre-activation opening does not activate the SKU");

      await db.operationAuthority.create({ data: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null } });
      const canonicalBaselineProjection = syntheticCanonicalProject({
        captureRevision: `before-authority-${randomUUID()}`,
        memberKey: `member-before-authority-${randomUUID()}`,
      });
      const canonicalBaselineReview = syntheticCanonicalReview(canonicalBaselineProjection, "1".repeat(40));
      const canonicalBaselineStage = await stageAppSheetCanonicalMasters(canonicalBaselineProjection, {
        actorId: ownerId,
        technicalReview: canonicalBaselineReview,
        commitSha: "1".repeat(40),
        target: "isolated-test",
        destinationIdentity,
      }, db);
      assert.equal(canonicalBaselineStage.replay, false, "a new synthetic canonical projection stages while authority is in shadow mode");

      await db.operationAuthority.upsert({
        where: { id: "operations" },
        create: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: captureId },
        update: { mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: captureId },
      });

      const manualTarget = `appsheet-replacement-manual-${randomUUID()}`;
      const manualRequest = envelope(manualTarget, "InvoiceSaved", invoiceData({ preorder: true }));
      const manualRejected = await send(manualRequest);
      assert.equal(manualRejected.response.status, 422, JSON.stringify(manualRejected.body));
      assert.equal(manualRejected.body.code, "APP_SHEET_MANUAL_INVOICE_NUMBER_REJECTED");
      assert.equal(await db.operationOrder.findUnique({ where: { id: manualTarget } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: manualTarget } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: manualRequest.requestId } }), 0);

      const unseededTarget = `appsheet-replacement-unseeded-${randomUUID()}`;
      const unseededData = { ...invoiceData({ preorder: true }), invoiceNumber: undefined };
      delete (unseededData as Record<string, unknown>).invoiceNumber;
      const unseededRequest = envelope(unseededTarget, "InvoiceSaved", unseededData);
      const unseededRejected = await send(unseededRequest);
      assert.equal(unseededRejected.response.status, 423, JSON.stringify(unseededRejected.body));
      assert.equal(unseededRejected.body.code, "APP_SHEET_INVOICE_SEQUENCE_UNSEEDED");
      assert.equal(await db.operationOrder.findUnique({ where: { id: unseededTarget } }), null, "the provisional order write rolls back");
      assert.equal(await db.operationObject.findUnique({ where: { id: unseededTarget } }), null, "the provisional aggregate write rolls back");
      assert.equal(await db.operationOrderLine.count({ where: { orderId: unseededTarget } }), 0);
      assert.equal(await db.appSheetInvoiceSequence.count(), 0);
      assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0);
      assert.equal(await db.commandReceipt.count({ where: { requestId: unseededRequest.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: unseededRequest.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: unseededRequest.requestId } }), 0);

      await db.appSheetInvoiceSequence.create({ data: {
        namespace: captureId, captureId, manifestHash, dataHash, snapshotId, mappingId: "synthetic-reviewed-mapping",
        publicationFingerprint: "c".repeat(64), sourceBindingHash: "d".repeat(64), lastValue: 40n, seededValue: 40n,
        invoiceRecordCount: 1, numberedInvoiceCount: 1, unnumberedInvoiceCount: 0, duplicateInvoiceNumberCount: 0, duplicateHiddenIdCount: 0,
        seedEvidence: { fixture: "synthetic allocator test, not source certification" }, seededBy: ownerId, seededAt: captureNow,
      } });

      const canonicalStageStateCounts = async () => ({
        captures: await db.appSheetCaptureManifest.count(),
        snapshots: await db.legacyImportSnapshot.count(),
        sourceRecords: await db.legacySourceRecord.count(),
        exceptions: await db.legacyException.count(),
        members: await db.operationMember.count(),
        skus: await db.catalogSku.count(),
        identities: await db.legacyIdentity.count(),
        objects: await db.operationObject.count(),
        audits: await db.operationAudit.count(),
        receipts: await db.commandReceipt.count(),
        outbox: await db.operationOutbox.count(),
        sequences: await db.appSheetInvoiceSequence.count(),
        reservations: await db.appSheetInvoiceNumberReservation.count(),
        orders: await db.operationOrder.count(),
        orderLines: await db.operationOrderLine.count(),
      });
      const activeReplacementAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
      assert.equal(activeReplacementAuthority.mode, "active");
      assert.equal(activeReplacementAuthority.cutoverProfile, "appsheet-replacement");
      assert.equal(activeReplacementAuthority.captureManifestId, captureId);
      assert.equal((await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } })).lastValue, 40n,
        "the active replacement already has a stable, seeded invoice sequence");
      const purchaseSupplierId = `appsheet-review-supplier-${randomUUID()}`;
      const purchaseSkuId = `appsheet-unreviewed-purchase-sku-${randomUUID()}`;
      const purchaseId = `appsheet-unreviewed-purchase-${randomUUID()}`;
      const purchaseLineId = `appsheet-unreviewed-purchase-line-${randomUUID()}`;
      await db.supplier.create({ data: { id: purchaseSupplierId, name: "Synthetic purchase supplier", key: purchaseSupplierId } });
      await db.catalogSku.create({ data: {
        id: purchaseSkuId, code: purchaseSkuId, name: "Unreviewed imported purchase SKU", variety: "Fixture", category: "Fixture", unit: "g",
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: `unreviewed-${purchaseSkuId}`, active: true,
      } });
      await db.purchaseOrder.create({ data: {
        id: purchaseId, supplierId: purchaseSupplierId, agreementDate: today, currency: "ARS", totalMinor: 500n, status: "draft",
        items: [{ lineId: purchaseLineId, skuId: purchaseSkuId, unit: "g", quantity: "5", unitCost: "100", lineTotalMinor: "500" }],
      } });
      await db.operationObject.create({ data: { id: purchaseId, kind: "purchase", version: 0, createdBy: deniedId } });
      const approvalRequest = envelope(purchaseId, "PurchaseOrderApproved", { evidence: { note: "Imported SKU has no reviewed capture proof" } });
      const purchaseBeforeApproval = await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseId } });
      const purchaseObjectBeforeApproval = await db.operationObject.findUniqueOrThrow({ where: { id: purchaseId } });
      const approvalRejected = await send(approvalRequest);
      assert.equal(approvalRejected.response.status, 423, JSON.stringify(approvalRejected.body));
      assert.equal(approvalRejected.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
      await assertNoCommandEffects(approvalRequest);
      assert.deepEqual(await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseId } }), purchaseBeforeApproval,
        "the draft remains untouched when its imported SKU is ineligible");
      assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: purchaseId } }), purchaseObjectBeforeApproval,
        "the aggregate version does not advance on a rejected approval");
      const activeReplayBefore = await canonicalStageStateCounts();
      const activeReplay = await stageAppSheetCanonicalMasters(canonicalBaselineProjection, {
        actorId: ownerId,
        technicalReview: canonicalBaselineReview,
        commitSha: "1".repeat(40),
        target: "isolated-test",
        destinationIdentity,
      }, db);
      assert.equal(activeReplay.replay, true, "active authority permits only an exact, already-validated no-op replay");
      assert.deepEqual(await canonicalStageStateCounts(), activeReplayBefore, "the active replay changes no persisted state");

      const canonicalAfterActivationProjection = syntheticCanonicalProject({
        captureRevision: `after-authority-${randomUUID()}`,
        memberKey: `member-after-authority-${randomUUID()}`,
      });
      const canonicalAfterActivationReview = syntheticCanonicalReview(canonicalAfterActivationProjection, "1".repeat(40));
      const originalAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
      const setActiveAuthorityProfile = async (profile: "legacy" | "appsheet-replacement") => {
        await db.operationAuthority.deleteMany({ where: { id: "operations" } });
        await db.operationAuthority.create({ data: {
          id: originalAuthority.id,
          mode: "active",
          cutoverProfile: profile,
          captureManifestId: profile === "appsheet-replacement" ? captureId : null,
          epoch: originalAuthority.epoch,
          ...(originalAuthority.firstRealWriteAt ? { firstRealWriteAt: originalAuthority.firstRealWriteAt } : {}),
          ...(originalAuthority.approvedBy ? { approvedBy: originalAuthority.approvedBy } : {}),
          ...(originalAuthority.evidence === null ? {} : { evidence: originalAuthority.evidence as Prisma.InputJsonValue }),
        } });
      };
      try {
        for (const profile of ["legacy", "appsheet-replacement"] as const) {
          if (profile !== (await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).cutoverProfile)
            await setActiveAuthorityProfile(profile);
          const beforeBlockedStage = await canonicalStageStateCounts();
          await assert.rejects(stageAppSheetCanonicalMasters(canonicalAfterActivationProjection, {
            actorId: ownerId,
            technicalReview: canonicalAfterActivationReview,
            commitSha: "1".repeat(40),
            target: "isolated-test",
            destinationIdentity,
          }, db), (error: unknown) => error instanceof AppSheetCanonicalError &&
            error.code === "canonical_master_stage_requires_shadow_authority");
          assert.deepEqual(await canonicalStageStateCounts(), beforeBlockedStage,
            `active ${profile} authority rejects a new master projection without writing captures, snapshots, masters, identities, objects, or effects`);
        }
      } finally {
        const currentAuthority = await db.operationAuthority.findUnique({ where: { id: "operations" } });
        if (!currentAuthority || currentAuthority.mode !== originalAuthority.mode ||
            currentAuthority.cutoverProfile !== originalAuthority.cutoverProfile ||
            currentAuthority.captureManifestId !== originalAuthority.captureManifestId)
          await setActiveAuthorityProfile("appsheet-replacement");
      }

      const activeBeforeSuspension = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
      assert.equal(activeBeforeSuspension.mode, "active");
      assert.equal(activeBeforeSuspension.cutoverProfile, "appsheet-replacement");
      const authorityObject = await db.operationObject.findUnique({ where: { id: "operations" }, select: { version: true } });
      try {
        const suspension = await send(envelope("operations", "AuthoritySuspended",
          { reason: "Synthetic lifecycle coverage for canonical staging" }, authorityObject?.version ?? 0));
        assert.equal(suspension.response.status, 200, JSON.stringify(suspension.body));
        const suspendedAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
        assert.equal(suspendedAuthority.mode, "shadow");
        assert.equal(suspendedAuthority.epoch, activeBeforeSuspension.epoch + 1,
          "the real suspension command advances the authority epoch");
        assert.equal(suspendedAuthority.cutoverProfile, activeBeforeSuspension.cutoverProfile);
        assert.equal(suspendedAuthority.captureManifestId, activeBeforeSuspension.captureManifestId);
        assert.equal(suspendedAuthority.approvedBy, activeBeforeSuspension.approvedBy);
        assert.deepEqual(suspendedAuthority.evidence, activeBeforeSuspension.evidence);
        assert.equal(suspendedAuthority.firstRealWriteAt?.toISOString() ?? null,
          activeBeforeSuspension.firstRealWriteAt?.toISOString() ?? null);

        const suspendedReplayBefore = await canonicalStageStateCounts();
        const suspendedReplay = await stageAppSheetCanonicalMasters(canonicalBaselineProjection, {
          actorId: ownerId,
          technicalReview: canonicalBaselineReview,
          commitSha: "1".repeat(40),
          target: "isolated-test",
          destinationIdentity,
        }, db);
        assert.equal(suspendedReplay.replay, true, "suspension still permits the exact validated no-op replay");
        assert.deepEqual(await canonicalStageStateCounts(), suspendedReplayBefore,
          "the suspended replay changes no persisted state");

        const beforeSuspendedFreshStage = await canonicalStageStateCounts();
        await assert.rejects(stageAppSheetCanonicalMasters(canonicalAfterActivationProjection, {
          actorId: ownerId,
          technicalReview: canonicalAfterActivationReview,
          commitSha: "1".repeat(40),
          target: "isolated-test",
          destinationIdentity,
        }, db), (error: unknown) => error instanceof AppSheetCanonicalError &&
          error.code === "canonical_master_stage_requires_shadow_authority");
        assert.deepEqual(await canonicalStageStateCounts(), beforeSuspendedFreshStage,
          "a fresh projection after real suspension writes no capture, snapshot, source row, master, identity, object, audit, receipt, outbox, or operation effect");
      } finally {
        const currentAuthority = await db.operationAuthority.findUnique({ where: { id: "operations" } });
        if (currentAuthority?.mode === "shadow" && currentAuthority.epoch === activeBeforeSuspension.epoch + 1)
          await db.operationAuthority.update({ where: { id: "operations" }, data: { mode: "active", epoch: { increment: 1 } } });
      }
      const activeAfterSuspensionCoverage = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
      assert.equal(activeAfterSuspensionCoverage.mode, "active");
      assert.equal(activeAfterSuspensionCoverage.epoch, activeBeforeSuspension.epoch + 2,
        "fixture restoration reactivates without rolling the authority epoch backward");
      assert.equal(activeAfterSuspensionCoverage.cutoverProfile, activeBeforeSuspension.cutoverProfile);
      assert.equal(activeAfterSuspensionCoverage.captureManifestId, activeBeforeSuspension.captureManifestId);
      assert.equal(activeAfterSuspensionCoverage.approvedBy, activeBeforeSuspension.approvedBy);
      assert.deepEqual(activeAfterSuspensionCoverage.evidence, activeBeforeSuspension.evidence);
      assert.equal(activeAfterSuspensionCoverage.firstRealWriteAt?.toISOString() ?? null,
        activeBeforeSuspension.firstRealWriteAt?.toISOString() ?? null);

      const invoiceYear = Number(new Intl.DateTimeFormat("en", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric" }).format(new Date()));
      const historicalCollision = formatAppSheetInvoiceNumberForYear(invoiceYear, 41n);
      await db.appSheetInvoiceNumberReservation.create({ data: {
        id: `synthetic-historical-reservation-${randomUUID()}`, namespace: captureId, captureId, manifestHash,
        invoiceNumber: historicalCollision, origin: "historical", orderId: null, sourceReferenceCount: 1,
        sourceReferences: [{ sourceRecordId: "synthetic-history-row", sourceRow: 2, sourceHash: "e".repeat(64), sourceKeyHash: "f".repeat(64), hiddenId: "41" }],
        generatedId: null, generatedYear: null, createdBy: null,
      } });

      const transferData = (preorder: boolean) => {
        const data = invoiceData({ preorder, lineTotal: "110", quantity: "1", withMoto: true }) as Record<string, unknown>;
        delete data.invoiceNumber;
        data.productPaymentMethod = "transfer";
        return data;
      };
      const targets = [`appsheet-replacement-race-a-${randomUUID()}`, `appsheet-replacement-race-b-${randomUUID()}`];
      const requests = targets.map(target => envelope(target, "InvoiceSaved", transferData(true)));
      const ledgerCountsBeforeConcurrent = [await db.ledgerEvent.count(), await db.ledgerLeg.count(), await db.collectionReport.count(), await db.cashEntry.count()];
      const outcomes = await Promise.all(requests.map(request => send(request)));
      for (const outcome of outcomes) assert.equal(outcome.response.status, 200, JSON.stringify(outcome.body));
      const assignedNumbers = outcomes.map(outcome => outcome.body.result.invoiceNumber as string).sort();
      assert.deepEqual(assignedNumbers, [
        formatAppSheetInvoiceNumberForYear(invoiceYear, 42n),
        formatAppSheetInvoiceNumberForYear(invoiceYear, 43n),
      ].sort(), "the existing source number collision is skipped and concurrent creates remain unique");
      const sequence = await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } });
      assert.equal(sequence.lastValue, 43n);
      const reservations = await db.appSheetInvoiceNumberReservation.findMany({ where: { orderId: { in: targets } } });
      assert.equal(reservations.length, 2);
      assert.equal(new Set(reservations.map(item => item.invoiceNumber)).size, 2);
      assert.equal(new Set(reservations.map(item => item.orderId)).size, 2);
      assert.equal(await db.commandReceipt.count({ where: { targetId: { in: targets }, command: "InvoiceSaved" } }), 2);
      assert.equal(await db.operationOutbox.count({ where: { requestId: { in: requests.map(request => request.requestId) } } }), 2);
      assert.equal(await db.operationAudit.count({ where: { requestId: { in: requests.map(request => request.requestId) } } }), 2);
      assert.deepEqual([await db.ledgerEvent.count(), await db.ledgerLeg.count(), await db.collectionReport.count(), await db.cashEntry.count()], ledgerCountsBeforeConcurrent);

      for (const target of targets) {
        const order = await db.operationOrder.findUniqueOrThrow({ where: { id: target } });
        const quote = order.quote as Record<string, any>;
        assert.equal(order.commercialState, "preorder");
        // Products: 110 + 6 rounded surcharge; Moto: 700 + 35 surcharge.
        assert.equal(order.totalMinor, 851n);
        assert.equal(order.subtotalMinor, 110n);
        assert.equal(order.surchargeMinor, 6n);
        assert.equal(quote.subtotalCalculationState, "defined");
        assert.equal(quote.totalCalculationState, "defined");
        assert.equal(quote.totalCalculationSource, "appsheet_recalculation_action");
        assert.equal(quote.appSheetFormula.results.Subtotal_Venta, "110");
        assert.equal(quote.appSheetFormula.results.Transferencia, "6");
        assert.equal(quote.appSheetFormula.results.Transferencia_moto, "35");
        assert.equal(quote.appSheetFormula.results.Subtotal_Cliente_Moto, "735");
        assert.equal(quote.appSheetFormula.results.Total_Facturado, "851");
        assert.equal(quote.appSheetFormula.transfer.subcentRemainderNumerator, "10");
        assert.equal(quote.appSheetFormula.numbering.captureId, captureId);
        assert.equal(await db.stockReservation.count({ where: { orderId: target } }), 0);
      }
      const retry = await send(requests[0]!);
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.replay, true);
      assert.equal((await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } })).lastValue, 43n);
      assert.deepEqual([await db.ledgerEvent.count(), await db.ledgerLeg.count(), await db.collectionReport.count(), await db.cashEntry.count()], ledgerCountsBeforeConcurrent);

      const editedTarget = targets[0]!;
      const beforeEdit = await db.operationOrder.findUniqueOrThrow({ where: { id: editedTarget } });
      const originalQuote = beforeEdit.quote as Record<string, any>;
      const linesBeforeRejectedEdit = await db.operationOrderLine.findMany({ where: { orderId: editedTarget }, orderBy: { id: "asc" } });
      const changedNumberData = { ...transferData(true), invoiceNumber: "MANUAL-CHANGE" };
      const changedNumberRequest = envelope(editedTarget, "InvoiceUpdated", changedNumberData, 1);
      const changedNumberRejected = await send(changedNumberRequest);
      assert.equal(changedNumberRejected.response.status, 409, JSON.stringify(changedNumberRejected.body));
      assert.equal(changedNumberRejected.body.code, "INVOICE_NUMBER_IMMUTABLE");
      assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: editedTarget } })).quoteVersion, beforeEdit.quoteVersion);
      assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: editedTarget }, orderBy: { id: "asc" } }), linesBeforeRejectedEdit);
      assert.equal((await db.appSheetInvoiceNumberReservation.findUniqueOrThrow({ where: { orderId: editedTarget } })).invoiceNumber, originalQuote.invoiceNumber);
      assert.equal(await db.commandReceipt.count({ where: { requestId: changedNumberRequest.requestId } }), 0);

      const validEditData = { ...transferData(true), invoiceNumber: originalQuote.invoiceNumber, lines: [{
        ...(transferData(true).lines as Array<Record<string, unknown>>)[0], totalMinor: "120",
      }] };
      const validEdit = await command(envelope(editedTarget, "InvoiceUpdated", validEditData, 1));
      assert.equal(validEdit.body.result.invoiceNumber, originalQuote.invoiceNumber);
      const editedOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: editedTarget } });
      const editedQuote = editedOrder.quote as Record<string, any>;
      assert.equal(editedOrder.totalMinor, 861n);
      assert.equal(editedQuote.totalCalculationState, "defined");
      assert.equal(editedQuote.appSheetFormula.results.Transferencia, "6");
      assert.equal(editedQuote.appSheetFormula.numbering.sequenceId, originalQuote.appSheetFormula.numbering.sequenceId);
      assert.equal((await db.appSheetInvoiceNumberReservation.findUniqueOrThrow({ where: { orderId: editedTarget } })).invoiceNumber, originalQuote.invoiceNumber);
      assert.equal((await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: captureId } })).lastValue, 43n);

      const confirmed = await command(envelope(editedTarget, "InvoiceConfirmed", { acceptance: { reference: "synthetic-replacement-preorder-acceptance" } }, 2));
      assert.equal(confirmed.body.result.commercialState, "confirmed");
      const totalsAttempt = envelope(editedTarget, "InvoiceTotalsConfirmed", {
        currency: "ARS", productsTotalMinor: "120", motoClientTotalMinor: "700", evidence: { note: "Must not replace the captured formula result." },
      }, 3);
      const totalsRejected = await send(totalsAttempt);
      assert.equal(totalsRejected.response.status, 409, JSON.stringify(totalsRejected.body));
      assert.equal(totalsRejected.body.code, "INVOICE_TOTAL_ALREADY_RESOLVED");
      assert.equal(await db.commandReceipt.count({ where: { requestId: totalsAttempt.requestId } }), 0);
      assert.deepEqual([await db.ledgerEvent.count(), await db.ledgerLeg.count(), await db.collectionReport.count(), await db.cashEntry.count()], ledgerCountsBeforeConcurrent);

      await replacementTest.test("a canonical capture blocks legacy gates, activation, source-less openings, and legacy command replay", async () => {
        assert.ok(preCaptureLegacyInvoice, "the positive legacy command case must have created a receipt before the capture");
        const currentCapture = await db.appSheetCaptureManifest.findUniqueOrThrow({ where: { captureId } });
        const capturedStability = currentCapture.stability as Record<string, unknown>;
        const unstableManifestHash = digest(`synthetic-invoice-unstable-capture-${randomUUID()}`);
        const unstableCaptureId = `appsreal-${unstableManifestHash.slice(0, 16)}`;
        const unstableSpreadsheetId = `synthetic-invoice-spreadsheet-${unstableCaptureId}`;
        await db.appSheetCaptureManifest.create({ data: {
          ...currentCapture,
          captureId: unstableCaptureId,
          sourceId: unstableSpreadsheetId,
          spreadsheetId: unstableSpreadsheetId,
          manifestHash: unstableManifestHash,
          definitionCoverage: currentCapture.definitionCoverage ?? Prisma.DbNull,
          // Keep the manifest structurally valid; the authorization guard must
          // reject its explicit cutover ineligibility after parsing succeeds.
          stability: { ...capturedStability, stable: true, cutoverEligible: false, sourceWriteDetected: false },
        } });

        assert.equal((await db.operationAuthority.deleteMany({ where: { id: "operations" } })).count, 1);
        await db.operationAuthority.create({ data: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null } });

        const effectCounts = async () => ({
          receipts: await db.commandReceipt.count(),
          audits: await db.operationAudit.count(),
          outbox: await db.operationOutbox.count(),
        });
        const assertRejectedWithoutCommandEffects = async (request: CommandEnvelope, expectedCode: string, expectedBlocker?: string) => {
          const before = await effectCounts();
          const rejected = await send(request);
          assert.equal(rejected.response.status, 423, JSON.stringify(rejected.body));
          assert.equal(rejected.body.code, expectedCode);
          if (expectedBlocker) assert.deepEqual(rejected.body.details?.blockers, [expectedBlocker]);
          assert.deepEqual(await effectCounts(), before);
          if (request.requestId !== preCaptureLegacyInvoice!.requestId)
            assert.equal(await db.commandReceipt.findUnique({ where: { requestId: request.requestId } }), null);
          return rejected;
        };

        const approvalFlagBefore = process.env.CLUB_OPERATIONS_APPROVED;
        process.env.CLUB_OPERATIONS_APPROVED = "true";
        try {
        await db.cutoverGate.deleteMany();
        const cashOpeningRequest = envelope(accountId, "AccountOpeningApproved", {
          amountMinor: "1200", preparedBy: deniedId, evidence: { note: "Source-less synthetic cash opening with a staged capture" },
        }, 2);
        const accountBeforeOpening = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
        const cashEffectsBefore = { events: await db.ledgerEvent.count(), legs: await db.ledgerLeg.count(), entries: await db.cashEntry.count() };
        await assertRejectedWithoutCommandEffects(cashOpeningRequest, "APPSHEET_REPLACEMENT_NOT_READY", "opening_source_record_required");
        const cashAfter = await db.operationAccount.findUniqueOrThrow({ where: { id: accountId } });
        assert.equal(cashAfter.openingMinor, accountBeforeOpening.openingMinor);
        assert.equal(cashAfter.openingApprovedBy, accountBeforeOpening.openingApprovedBy);
        assert.deepEqual({ events: await db.ledgerEvent.count(), legs: await db.ledgerLeg.count(), entries: await db.cashEntry.count() }, cashEffectsBefore);

        const sourceLessStockLotId = `appsheet-source-less-opening-lot-${randomUUID()}`;
        const sourceLessStockRequest = envelope(sourceLessStockLotId, "StockOpeningRecorded", {
          skuId, label: "Synthetic source-less stock opening", quantity: "5", unitCost: "10", costCurrency: "ARS",
          receivedDate: today, locationId, preparedBy: deniedId, evidence: { note: "Source-less synthetic stock opening with a staged capture" },
        });
        const stockBefore = { lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() };
        await assertRejectedWithoutCommandEffects(sourceLessStockRequest, "APPSHEET_REPLACEMENT_NOT_READY", "opening_source_record_required");
        assert.deepEqual({ lots: await db.inventoryLot.count(), balances: await db.stockBalance.count(), facts: await db.stockFact.count() }, stockBefore);
        assert.equal(await db.inventoryLot.findUnique({ where: { id: sourceLessStockLotId } }), null);
        assert.equal(await db.operationObject.findUnique({ where: { id: sourceLessStockLotId } }), null, "the provisional aggregate rolls back");

        for (const gateId of cutoverGateIds) await db.cutoverGate.upsert({
          where: { id: gateId },
          create: { id: gateId, status: "approved", evidence: { note: "Synthetic generic legacy approval" }, approvedBy: deniedId, reviewedBy: ownerId, approvedAt: captureNow },
          update: { status: "approved", evidence: { note: "Synthetic generic legacy approval" }, approvedBy: deniedId, reviewedBy: ownerId, approvedAt: captureNow, captureManifestId: null },
        });

        const legacyGateId = cutoverGateIds[0]!;
        const legacyGateBefore = await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } });
        const legacyGateObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } });
        const legacyGateRequest = envelope(legacyGateId, "CutoverGateReviewed", {
          gateId: legacyGateId, cutoverProfile: "legacy", authorId: deniedId, evidence: { note: "Attempt legacy profile after canonical capture" },
        }, legacyGateObjectBefore.version);
        await assertRejectedWithoutCommandEffects(legacyGateRequest, "APPSHEET_REPLACEMENT_REQUIRED");
        assert.deepEqual(await db.cutoverGate.findUniqueOrThrow({ where: { id: legacyGateId } }), legacyGateBefore);
        assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: legacyGateId } }), legacyGateObjectBefore);

          const activationRequest = envelope("operations", "AuthorityActivated", {
            cutoverProfile: "legacy", evidence: { note: "Synthetic legacy activation after canonical capture" },
          });
          await assertRejectedWithoutCommandEffects(activationRequest, "APPSHEET_REPLACEMENT_REQUIRED");
          const authorityAfterActivation = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
          assert.equal(authorityAfterActivation.mode, "shadow", "the rejected API activation leaves authority unchanged");
          assert.equal(authorityAfterActivation.cutoverProfile, "legacy");

          assert.equal((await db.operationAuthority.deleteMany({ where: { id: "operations" } })).count, 1);
          await db.operationAuthority.create({ data: { id: "operations", mode: "active", cutoverProfile: "legacy", captureManifestId: null } });
          const activeLegacyAuthority = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
          const transitionRequest = envelope("operations", "AuthorityActivated", {
            cutoverProfile: "appsheet-replacement", captureId: unstableCaptureId, evidence: { note: "Attempt replacement transition from active legacy authority" },
          });
          await assertRejectedWithoutCommandEffects(transitionRequest, "APPSHEET_REPLACEMENT_NOT_READY", "capture_not_stable_or_complete");
          const authorityAfterTransition = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
          assert.equal(authorityAfterTransition.mode, activeLegacyAuthority.mode);
          assert.equal(authorityAfterTransition.cutoverProfile, activeLegacyAuthority.cutoverProfile);
          assert.equal(authorityAfterTransition.epoch, activeLegacyAuthority.epoch);
          assert.equal(authorityAfterTransition.captureManifestId, activeLegacyAuthority.captureManifestId);
          const replayOrderBefore = await db.operationOrder.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } });
          const replayObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } });
          const replayedLegacyInvoice = await assertRejectedWithoutCommandEffects(preCaptureLegacyInvoice!, "APPSHEET_REPLACEMENT_REQUIRED");
          assert.notEqual(replayedLegacyInvoice.body.replay, true, "the capture guard runs before returning a stored receipt");
          assert.ok(await db.commandReceipt.findUnique({ where: { requestId: preCaptureLegacyInvoice!.requestId } }), "the prior receipt is preserved");
          assert.deepEqual(await db.operationOrder.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } }), replayOrderBefore);
          assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: preCaptureLegacyInvoice!.targetId } }), replayObjectBefore);
          assert.equal((await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } })).epoch, activeLegacyAuthority.epoch);

          const newLegacyInvoiceRequest = envelope(`appsheet-legacy-after-capture-${randomUUID()}`, "InvoiceSaved", {
            ...invoiceData({ preorder: true }), invoiceNumber: `APP-2026-${randomUUID().slice(0, 8).toUpperCase()}`,
          });
          await assertRejectedWithoutCommandEffects(newLegacyInvoiceRequest, "APPSHEET_REPLACEMENT_REQUIRED");
          assert.equal(await db.operationOrder.findUnique({ where: { id: newLegacyInvoiceRequest.targetId } }), null);
          assert.equal(await db.operationObject.findUnique({ where: { id: newLegacyInvoiceRequest.targetId } }), null);
        } finally {
          if (approvalFlagBefore === undefined) delete process.env.CLUB_OPERATIONS_APPROVED;
          else process.env.CLUB_OPERATIONS_APPROVED = approvalFlagBefore;
        }
      });

      await replacementTest.test("reviewed AppSheet source lots flow through the HTTP selector and confirmed invoice reservation", async () => {
        // This is a synthetic consumer precondition. The only source-lot proof
        // below is produced by the real AppSheetSourceLotReviewed command.
        const sourceFixture = appSheetSourceLotCaptureFixture(`invoice-source-lots-${randomUUID()}`);
        const capture = sourceFixture.sourceLotCapture.manifest;
        const productionDestinationIdentity = appSheetDatabaseDestinationIdentity("production", databaseUrl);
        const digestValue = (value: unknown) => digest(canonicalJson(value));
        const captureDate = (value: string) => new Date(value);
        await db.appSheetCaptureManifest.create({ data: {
          captureId: capture.captureId, sourceSystem: capture.sourceSystem, sourceId: capture.sourceId, spreadsheetId: capture.spreadsheetId,
          metadataHash: capture.metadataHash, headersHash: capture.headersHash, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
          definitionHash: null, stability: capture.stability, firstReadAt: captureDate(capture.firstReadAt),
          verificationStartedAt: captureDate(capture.verificationStartedAt), verificationCompletedAt: captureDate(capture.verificationCompletedAt),
          cutoffAt: captureDate(capture.cutoffAt), dataCoverage: capture.coverage, pageManifest: capture.pages, definitionCoverage: Prisma.DbNull,
          dataSheetCount: capture.dataSheetCount, dataPageCount: capture.dataPageCount, dataRecordCount: capture.dataRecordCount,
          dataFormulaCount: capture.dataFormulaCount, dataUnresolvedFormulaCount: capture.dataUnresolvedFormulaCount,
          definitionTableCount: capture.definitionTableCount, definitionColumnCount: capture.definitionColumnCount,
          definitionSliceCount: capture.definitionSliceCount, definitionViewCount: capture.definitionViewCount,
          definitionActionCount: capture.definitionActionCount, definitionBotCount: capture.definitionBotCount,
          definitionWorkflowRuleCount: capture.definitionWorkflowRuleCount, definitionFormatRuleCount: capture.definitionFormatRuleCount,
        } });

        const authorityBeforeSourceLotFixture = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
        assert.equal(authorityBeforeSourceLotFixture.mode, "active");
        assert.equal(authorityBeforeSourceLotFixture.cutoverProfile, "legacy");
        assert.equal(authorityBeforeSourceLotFixture.captureManifestId, null);
        const authorityObject = await db.operationObject.findUnique({ where: { id: "operations" }, select: { version: true } });
        const suspendedLegacyAuthority = await send(envelope("operations", "AuthoritySuspended", {
          reason: "Synthetic source-lot fixture transition to shadow mode",
        }, authorityObject?.version ?? 0));
        assert.equal(suspendedLegacyAuthority.response.status, 200, JSON.stringify(suspendedLegacyAuthority.body));
        const authorityAfterSuspension = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
        assert.equal(authorityAfterSuspension.mode, "shadow");
        assert.equal(authorityAfterSuspension.cutoverProfile, "legacy", "the owner command preserves the existing profile");
        assert.equal(authorityAfterSuspension.captureManifestId, null, "the owner command preserves the existing capture");
        assert.equal(authorityAfterSuspension.epoch, authorityBeforeSourceLotFixture.epoch + 1);

        // The fixture changes replacement capture only while shadow. The database
        // trigger intentionally forbids changing it during active authority.
        await db.operationAuthority.update({
          where: { id: "operations" },
          data: { cutoverProfile: "appsheet-replacement", captureManifestId: capture.captureId },
        });

        const stagerId = `appsheet-source-lot-stager-${randomUUID()}`;
        await db.user.create({ data: { id: stagerId, name: "Synthetic source-lot stage operator", email: `${stagerId}@appsheet-invoice.test`, password, role: "admin" } });
        await db.operationAccess.create({ data: { userId: stagerId, profile: "commercial", enabled: true, capabilities: ["imports.write"] } });
        const commitSha = "2".repeat(40);
        const backupEvidence = { manifestHash: digest("synthetic source-lot backup"), snapshotAt: new Date(Date.now() - 2_000).toISOString() };
        const technicalReview = {
          schemaVersion: 2, reviewKind: "independent-technical", captureId: capture.captureId, manifestHash: capture.manifestHash,
          definitionHash: sourceFixture.projection.appliedDefinitionHash, projectionKind: "masters",
          projectionHash: sourceFixture.projection.projectionHash, commitSha, importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
          reviewer: "synthetic-independent-source-lot-technical-reviewer", approved: true,
          reviewedAt: new Date(Date.now() - 1_000).toISOString(), findings: [], target: "production", destinationIdentity: productionDestinationIdentity,
        };
        const { stageAppSheetCanonicalMasters } = await import("../server/operations/appsheet-canonical.js");
        const { appSheetCanonicalCurrentDestinationHash } = await import("../server/operations/appsheet-canonical.js");
        const { finalDeltaProofForCapture } = await import("../server/operations/access.js");
        const { legacyPayloadHash } = await import("../server/operations/legacy-upload-contract.js");
        const { canonicalCommandBodyHash } = await import("../server/operations/canonical.js");
        const { appSheetDefinitionProductionReadiness } = await import("../shared/operations/appsheet-definition.js");
        const stagedMaster = await stageAppSheetCanonicalMasters(sourceFixture.projection, {
          actorId: stagerId, technicalReview, commitSha, target: "production", destinationIdentity: productionDestinationIdentity, backupEvidence,
        }, db);
        const masterSnapshot = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: stagedMaster.snapshotId } });
        const botInventory = { state: "verified", evidenceSha256: digest("synthetic app editor bot inventory consumer fixture"), observedCount: 1 };
        const masterControls = masterSnapshot.controls as Record<string, any>;
        const masterCoverage = masterSnapshot.coverage as Record<string, any>;
        masterControls.appSheetCanonical.botInventory = botInventory;
        masterCoverage.appSheetCanonical.botInventory = botInventory;
        await db.legacyImportSnapshot.update({ where: { id: masterSnapshot.id }, data: {
          controls: masterControls as Prisma.InputJsonValue, coverage: masterCoverage as Prisma.InputJsonValue,
        } });
        const canonicalReview = await command(envelope(masterSnapshot.id, "AppSheetCanonicalIdentitiesReviewed", {
          captureId: capture.captureId, manifestHash: capture.manifestHash, projectionHash: sourceFixture.projection.projectionHash,
          destinationCount: sourceFixture.projection.destinations.length, evidenceReference: "synthetic source-lot canonical identity review",
        }));
        assert.equal(canonicalReview.body.result.status, "reviewed");
        const memberDestination = sourceFixture.projection.destinations.find(destination => destination.type === "member");
        const skuDestination = sourceFixture.projection.destinations.find(destination => destination.type === "sku");
        assert.ok(memberDestination?.type === "member" && skuDestination?.type === "sku");
        const sourceMember = await db.operationMember.findUniqueOrThrow({ where: { id: memberDestination.id } });
        const sourceSku = await db.catalogSku.findUniqueOrThrow({ where: { id: skuDestination.id } });
        await db.memberPermission.create({ data: { memberId: sourceMember.id, kind: "operations", status: "verified", validFrom: today, validUntil } });

        const historySnapshotId = `appsheet-source-lot-history-${randomUUID()}`;
        const historyRows = sourceFixture.sourceRowsFor(historySnapshotId, capture.manifestHash);
        const sourceRecords = historyRows.records;
        const sourceFacts = historyRows.facts;
        const historyBackup = { manifestHash: digest("synthetic source-lot history backup"), snapshotAt: new Date(Date.now() - 2_000).toISOString() };
        const historyTechnicalReview = {
          schemaVersion: 2, reviewKind: "independent-technical", approved: true, bindingSource: "explicit-target-and-destination",
          reviewer: "synthetic-independent-source-history-reviewer", reviewedAt: new Date(Date.now() - 1_000).toISOString(),
          findingsCount: 0, findingsHash: digest([]), commitSha,
        };
        const recordsHash = digestValue(sourceRecords.map(record => ({ id: record.id, sourceTable: record.sourceTable,
          sourceKey: record.sourceKey, contentHash: record.contentHash })));
        const factsHash = digestValue(sourceFacts.map(fact => ({ id: fact.id, sourceRecordId: fact.sourceRecordId,
          sourceHash: fact.sourceHash, kind: fact.kind, quantity: fact.quantity, unit: fact.unit })));
        const historyProjectionHash = digestValue({ schemaVersion: "appsheet-history-projection/v1", captureId: capture.captureId,
          manifestHash: capture.manifestHash, dataHash: capture.dataHash, recordsHash, factsHash });
        const inventory = sourceFixture.projection.definitionInventory;
        const historyStage = {
          schemaVersion: "appsheet-history-stage/v2", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
          mappingId: APPSHEET_HISTORY_MAPPING_ID, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, captureId: capture.captureId,
          manifestHash: capture.manifestHash, dataHash: capture.dataHash, captureDefinitionHash: null, mode: "stable",
          definitionHash: sourceFixture.projection.appliedDefinitionHash, definitionSourceSha256: inventory.source.sha256,
          definitionDescriptorSha256: inventory.descriptorSha256, definitionFileSha256: digest("synthetic history definition file"),
          definitionIdentityState: "verified", definitionReadiness: appSheetDefinitionProductionReadiness(inventory),
          definitionInventory: inventory, status: "staged", projectionHash: historyProjectionHash, destination: { target: "production", identity: productionDestinationIdentity },
          humanReview: { status: "pending" }, operationalAuthority: { status: "unchanged" }, authorizationContext: "user-authorized-plan",
          actorUserId: stagerId, actor: "codex:appsheet-history-stage", reviewedBy: null, reviewedAt: null,
          effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false, numbering: "not-generated" },
          backupManifestHash: historyBackup.manifestHash, backupSnapshotAt: historyBackup.snapshotAt, technicalReview: historyTechnicalReview,
          recordsHash, factsHash, exceptionsHash: digest([]),
        };
        const tableCounts = new Map<string, { records: number; facts: number }>();
        for (const record of sourceRecords) tableCounts.set(record.sourceTable, {
          records: (tableCounts.get(record.sourceTable)?.records ?? 0) + 1, facts: tableCounts.get(record.sourceTable)?.facts ?? 0,
        });
        for (const fact of sourceFacts) tableCounts.set(fact.sourceTable, {
          records: tableCounts.get(fact.sourceTable)?.records ?? 0, facts: (tableCounts.get(fact.sourceTable)?.facts ?? 0) + 1,
        });
        const historyCoverage = {
          schemaVersion: "appsheet-history-coverage/v1", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
          captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash, captureDefinitionHash: null,
          appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash, mode: "stable", stability: capture.stability,
          pages: capture.pages.map(page => ({ sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow,
            endRow: page.endRow, pageHash: page.pageHash, verifiedPageHash: page.verifiedPageHash, stable: page.stable })),
          sheets: [...tableCounts.entries()].map(([sourceTable, count]) => ({ sourceTable, pageCount: capture.pages.filter(page => page.title === sourceTable).length,
            sourceRecordCount: count.records, populatedSourceRows: count.records, factCount: count.facts,
            blockingExceptionCount: 0, reviewExceptionCount: 0, sourceRecordUnresolvedFormulaCount: 0,
            definitionTableMatch: "unique", changedPageIndexes: [], unresolvedFormulaCount: 0 })),
          source: { spreadsheetId: capture.spreadsheetId, dataRecordCount: sourceRecords.length },
          totals: { recordCount: sourceRecords.length, factCount: sourceFacts.length, exceptionCount: 0 }, exceptionTotal: 0,
          definition: { inventory, identityState: "verified", appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash,
            sourceSha256: inventory.source.sha256, descriptorSha256: inventory.descriptorSha256, commitSha },
        };
        await db.legacyImportSnapshot.create({ data: {
          id: historySnapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "synthetic-source-lot-history",
          fileHash: capture.manifestHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "reviewed", createdBy: stagerId,
          reviewedBy: ownerId, reviewedAt: new Date(), captureManifestId: capture.captureId,
          controls: { appSheetHistoryStage: historyStage }, coverage: historyCoverage,
        } });
        for (const record of sourceRecords) await db.legacySourceRecord.create({ data: {
          id: record.id, snapshotId: historySnapshotId, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
          fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
          original: record.original as Prisma.InputJsonValue, normalized: record.normalized as Prisma.InputJsonValue, treatment: record.treatment,
        } });
        for (const fact of sourceFacts) await db.legacyHistoricalFact.create({ data: {
          id: fact.id, snapshotId: historySnapshotId, sourceRecordId: fact.sourceRecordId, sourceTable: fact.sourceTable,
          sourceKey: fact.sourceKey, sourceRow: fact.sourceRow, sourceHash: fact.sourceHash, mappingId: fact.mappingId, kind: fact.kind,
          occurredOn: fact.occurredOn, dateState: fact.dateState, amountMinor: null, amountState: "not-applicable",
          currency: null, currencyState: "not-applicable", quantity: fact.quantity, quantityState: fact.quantityState,
          unit: fact.unit, unitState: fact.unitState, attributes: fact.attributes as Prisma.InputJsonValue, createdBy: stagerId,
        } });
        const historyPublicationFingerprint = legacyPayloadHash({ snapshotId: historySnapshotId, fileHash: capture.manifestHash,
          mappingId: APPSHEET_HISTORY_MAPPING_ID, rows: sourceRecords.length, corrections: [] });
        await db.legacyHistoryPublication.upsert({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
          create: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, snapshotId: historySnapshotId, fileHash: capture.manifestHash,
            mappingId: APPSHEET_HISTORY_MAPPING_ID, fingerprint: historyPublicationFingerprint, publishedBy: stagerId,
            evidence: { reference: "synthetic source-lot history publication prerequisite" } },
          update: { snapshotId: historySnapshotId, fileHash: capture.manifestHash, mappingId: APPSHEET_HISTORY_MAPPING_ID,
            fingerprint: historyPublicationFingerprint, publishedBy: stagerId, evidence: { reference: "synthetic source-lot history publication prerequisite" } },
        });
        await db.operationAudit.create({ data: {
          actorId: stagerId, action: "legacy.appsheet_history_staged", objectId: historySnapshotId,
          details: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
            captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash, projectionHash: historyProjectionHash,
            mode: "stable", reviewer: historyTechnicalReview.reviewer, technicalReviewAt: historyTechnicalReview.reviewedAt,
            commitSha, target: "production", destinationIdentity: productionDestinationIdentity,
            backupManifestHash: historyBackup.manifestHash, backupSnapshotAt: historyBackup.snapshotAt,
            authorizationContext: "user-authorized-plan", recordCount: sourceRecords.length, factCount: sourceFacts.length,
            exceptionCount: 0, reviewedBy: null, status: "staged" },
        } });

        const firstReadAt = captureDate(capture.firstReadAt);
        const finalDelta = finalDeltaProofForCapture({ captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
          firstReadAt, verificationStartedAt: captureDate(capture.verificationStartedAt), verificationCompletedAt: captureDate(capture.verificationCompletedAt),
          cutoffAt: captureDate(capture.cutoffAt), stability: capture.stability } as any, {
          manualPauseStartedAt: new Date(firstReadAt.getTime() - 1_000).toISOString(), manualPauseEndedAt: null,
          manualPauseEvidenceRef: "synthetic manual pause fixture", expectedHandoffChangesRef: "synthetic separate handoff review fixture",
        });
        const finalDeltaEvidence = { humanEvidence: { reference: "synthetic distinct gate author and reviewer" }, appSheetReplacement: {
          schemaVersion: 1, captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
          captureDefinitionHash: null, appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash, gateProof: { finalDelta },
        } };
        await db.cutoverGate.upsert({ where: { id: "final-delta-reconciled" },
          create: { id: "final-delta-reconciled", status: "approved", evidence: finalDeltaEvidence, captureManifestId: capture.captureId,
            approvedBy: stagerId, reviewedBy: ownerId, approvedAt: new Date() },
          update: { status: "approved", evidence: finalDeltaEvidence, captureManifestId: capture.captureId,
            approvedBy: stagerId, reviewedBy: ownerId, approvedAt: new Date() },
        });

        const openingRecords = new Map(sourceRecords.filter(record => record.sourceTable === "D_Stock").map(record => [record.sourceKey, record]));
        const internalLots = new Map<string, { id: string; balanceId: string; sourceRecordId: string }>();
        for (const sourceLot of historyRows.sourceLots) {
          const openingRecord = openingRecords.get(`opening-${sourceLot.sourceLotId}`);
          assert.ok(openingRecord, `synthetic D_Stock source exists for ${sourceLot.sourceLotId}`);
          const lotId = `appsheet-source-lot-internal-${randomUUID()}`;
          const opening = await command(envelope(lotId, "StockOpeningRecorded", {
            skuId: sourceSku.id, label: `Synthetic opening for ${sourceLot.sourceLotId}`, quantity: sourceLot.sourceStockActual,
            unitCost: "10", costCurrency: "ARS", receivedDate: sourceLot.sourceDeliveryDate, locationId, custodianId: ownerId,
            preparedBy: deniedId, evidence: { note: "Synthetic D_Stock source lot opening" }, sourceRecordId: openingRecord.id,
          }));
          assert.equal(opening.body.result.opening.quantity, sourceLot.sourceStockActual);
          assert.equal(opening.body.result.balance.quantity, sourceLot.sourceStockActual);
          const balance = await db.stockBalance.findFirstOrThrow({ where: { lotId } });
          internalLots.set(sourceLot.sourceLotId, { id: lotId, balanceId: balance.id, sourceRecordId: sourceLot.sourceRecord.id });
        }

        const sourceLotCommandRequests = new Map<string, CommandEnvelope>();
        const sourceReviewEffects = async () => ({
          identities: await db.legacyIdentity.findMany({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Mercaderia" }, orderBy: { sourceKey: "asc" } }),
          lots: await db.inventoryLot.findMany({ where: { id: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
          objects: await db.operationObject.findMany({ where: { id: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
          reviews: await db.operationAudit.findMany({ where: { action: "appsheet.source_lot_reviewed", objectId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
          receipts: await db.commandReceipt.count(), audits: await db.operationAudit.count(), outbox: await db.operationOutbox.count(),
        });
        for (const sourceLot of historyRows.sourceLots) {
          const target = internalLots.get(sourceLot.sourceLotId)!;
          const reviewRequest = envelope(target.id, "AppSheetSourceLotReviewed", {
            sourceRecordId: sourceLot.sourceRecord.id, sourceKey: sourceLot.sourceLotId, contentHash: sourceLot.sourceRecord.contentHash,
            preparedBy: deniedId, evidence: { note: "Synthetic independent review of source-derived AppSheet stock" },
          }, 1);
          sourceLotCommandRequests.set(sourceLot.sourceLotId, reviewRequest);
          const reviewed = await command(reviewRequest);
          const proof = reviewed.body.result.proof;
          assert.equal(reviewed.body.result.sourceLot.inventoryLotId, target.id);
          assert.equal(proof.sourceRecordId, sourceLot.sourceRecord.id);
          assert.equal(proof.sourceStockActual, sourceLot.sourceStockActual);
          assert.equal(proof.sourceDeliveryDate, sourceLot.sourceDeliveryDate);
          for (const field of ["sourceDataHash", "sourceRowHash", "sourceDerivationHash", "sourceStockDefinitionHash", "sourceMovementRowsetHash", "sourceSelectionHash"])
            assert.match(proof[field], /^[a-f0-9]{64}$/, `${field} is generated by the review command`);
        }
        const reviewedSourceState = await sourceReviewEffects();
        const firstReviewRequest = sourceLotCommandRequests.get(historyRows.sourceLots[0]!.sourceLotId)!;
        const replayedSourceReview = await command(firstReviewRequest);
        assert.equal(replayedSourceReview.body.replay, true);
        assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "the exact HTTP command replay adds no effects");

        const duplicateReview = envelope(firstReviewRequest.targetId, "AppSheetSourceLotReviewed", firstReviewRequest.data, 2);
        const duplicateResult = await send(duplicateReview);
        assert.equal(duplicateResult.response.status, 409, JSON.stringify(duplicateResult.body));
        assert.equal(duplicateResult.body.code, "APPSHEET_SOURCE_LOT_RECAPTURE_REQUIRED");
        assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "a second review request for the same capture is rejected without writes");

        await db.operationAccess.update({ where: { userId: scopedId }, data: {
          profile: "stock", enabled: true, capabilities: ["openings.approve"],
          scope: { locationIds: ["outside-source-lot-location"], custodianIds: [ownerId] },
        } });
        const scopedReviewRequest = envelope(firstReviewRequest.targetId, "AppSheetSourceLotReviewed", firstReviewRequest.data, 2);
        const scopedReview = await send(scopedReviewRequest, scopedId);
        assert.equal(scopedReview.response.status, 403, JSON.stringify(scopedReview.body));
        assert.equal(scopedReview.body.code, "LOCATION_SCOPE");
        assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "scope rejection leaves all source-lot evidence unchanged");

        // Consumer precondition only: mimic the already-reviewed activation receipt
        // chain so the active catalogue reader can validate the SKU. Do not invoke
        // AuthorityActivated from this test.
        const reviewedMaster = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: masterSnapshot.id } });
        const controls = reviewedMaster.controls as Record<string, any>;
        const skuFingerprint = controls.appSheetCanonical.destinationFingerprints.find((item: any) => item.destinationId === sourceSku.id);
        assert.ok(skuFingerprint);
        const activatedSku = await db.catalogSku.update({ where: { id: sourceSku.id }, data: { active: true } });
        const activatedObject = await db.operationObject.update({ where: { id: sourceSku.id }, data: { version: 1 } });
        assert.equal(activatedObject.version, 1);
        const activatedSnapshot = {
          id: activatedSku.id, code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety,
          category: activatedSku.category, unit: activatedSku.unit, active: activatedSku.active,
          sourceSystem: activatedSku.sourceSystem, sourceId: activatedSku.sourceId, appSheet: activatedSku.appSheet,
        };
        const activationEntry = {
          skuId: sourceSku.id, sourceKey: skuDestination.sourceKey, baselineHash: skuFingerprint.dataHash, baselineVersion: skuFingerprint.operationVersion,
          activatedHash: appSheetCanonicalCurrentDestinationHash(activatedSnapshot, "sku"), activatedVersion: 1,
        };
        const activationManifest = { schemaVersion: 1, captureId: capture.captureId, snapshotId: masterSnapshot.id,
          projectionHash: sourceFixture.projection.projectionHash, destinationIdentity: productionDestinationIdentity, entries: [activationEntry] };
        const authorityRequestId = randomUUID();
        const activationRequest = envelope("operations", "AuthorityActivated", {
          cutoverProfile: "appsheet-replacement", captureId: capture.captureId, evidence: { reference: "synthetic activation consumer fixture" },
        });
        activationRequest.requestId = authorityRequestId;
        await db.operationAuthority.update({ where: { id: "operations" }, data: {
          mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: capture.captureId, epoch: 3, approvedBy: ownerId,
        } });
        await db.operationObject.upsert({ where: { id: "operations" },
          create: { id: "operations", kind: "authority", version: 1, createdBy: ownerId },
          update: { kind: "authority", version: 1, createdBy: ownerId },
        });
        const activationResponse = { requestId: authorityRequestId, targetId: "operations", version: 1,
          result: { authority: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement",
            captureManifestId: capture.captureId, epoch: 3, approvedBy: ownerId }, appSheetSkuActivation: activationManifest } };
        await db.commandReceipt.create({ data: { requestId: authorityRequestId, actorId: ownerId, targetId: "operations", command: "AuthorityActivated",
          bodyHash: canonicalCommandBodyHash(activationRequest), response: activationResponse, resultingVersion: 1, authorityEpoch: 2,
          occurredAt: new Date() } });
        await db.operationAudit.create({ data: { actorId: ownerId, action: "AuthorityActivated", objectId: "operations", requestId: authorityRequestId,
          details: { version: 1 } } });
        await db.operationAudit.create({ data: { actorId: ownerId, action: "appsheet.canonical_sku_activated", objectId: sourceSku.id,
          requestId: authorityRequestId, details: { schemaVersion: 1, captureId: capture.captureId, snapshotId: masterSnapshot.id,
            projectionHash: sourceFixture.projection.projectionHash, destinationIdentity: productionDestinationIdentity,
            ...activationEntry, snapshot: activatedSnapshot } } });

        // Number allocation is a synthetic precondition; the test is about the
        // actual source-lot review and confirmed reservation transaction.
        const historyPublication = await db.legacyHistoryPublication.findUniqueOrThrow({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM } });
        const seededValue = BigInt(Date.now());
        await db.appSheetInvoiceSequence.create({ data: {
          namespace: capture.captureId, captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
          snapshotId: historySnapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint: historyPublication.fingerprint,
          sourceBindingHash: digestValue({ fixture: "synthetic sequence consumer prerequisite", captureId: capture.captureId }),
          lastValue: seededValue, seededValue, invoiceRecordCount: 0, numberedInvoiceCount: 0, unnumberedInvoiceCount: 0,
          duplicateInvoiceNumberCount: 0, duplicateHiddenIdCount: 0, seedEvidence: { fixture: "synthetic sequence consumer prerequisite" },
          seededBy: ownerId, seededAt: new Date(),
        } });

        const catalogResponse = await call("/operations/catalog?channel=local");
        assert.equal(catalogResponse.status, 200, await catalogResponse.text());
        const catalog = await catalogResponse.json() as { items: Array<{ id: string; appSheetSourceLots?: Array<any> }> };
        const catalogSku = catalog.items.find(item => item.id === sourceSku.id);
        assert.ok(catalogSku);
        const sourceLotOptions = catalogSku.appSheetSourceLots ?? [];
        assert.equal(sourceLotOptions.length, 2, "both reviewed source lots with positive stock are selectable");
        assert.equal(sourceLotOptions[0]!.sourceLotId, historyRows.sourceLots[0]!.sourceLotId, "catalogue retains the older FIFO lot first");
        const selectedSourceLot = historyRows.sourceLots[1]!;
        const selectedOption = sourceLotOptions.find(item => item.sourceLotId === selectedSourceLot.sourceLotId);
        assert.ok(selectedOption);
        assert.equal(selectedOption.inventoryLotId, internalLots.get(selectedSourceLot.sourceLotId)!.id);

        const invoiceTargetId = `appsheet-source-lot-invoice-${randomUUID()}`;
        const invoice = invoiceData({ preorder: false, quantity: "3", lineId: `source-lot-invoice-line-${randomUUID()}` });
        const invoiceInput: Record<string, any> = {
          ...invoice, memberId: sourceMember.id,
          lines: invoice.lines.map(line => ({ ...line, skuId: sourceSku.id, sourceLotId: selectedSourceLot.sourceLotId })),
        };
        delete invoiceInput.invoiceNumber;
        const invoiceRequest = envelope(invoiceTargetId, "InvoiceSaved", invoiceInput);
        const confirmedInvoice = await send(invoiceRequest);
        assert.equal(confirmedInvoice.response.status, 200, JSON.stringify(confirmedInvoice.body));
        assert.equal(confirmedInvoice.body.result.commercialState, "confirmed");
        const savedOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: invoiceTargetId } });
        assert.equal((savedOrder.quote as any).input.lines[0].sourceLotId, selectedSourceLot.sourceLotId);
        const reservations = await db.stockReservation.findMany({ where: { orderId: invoiceTargetId }, include: { balance: { include: { lot: true } } } });
        assert.equal(reservations.length, 1);
        assert.equal(reservations[0]!.balance.lot.id, internalLots.get(selectedSourceLot.sourceLotId)!.id,
          "explicit selection reserves the second source lot instead of native FIFO's first lot");
        assert.equal(reservations[0]!.quantity.toString(), "3");
        assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(historyRows.sourceLots[0]!.sourceLotId)!.balanceId } })).reserved.toString(), "0");
        assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(selectedSourceLot.sourceLotId)!.balanceId } })).reserved.toString(), "3");
        const sequenceAfterInvoice = await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } });
        assert.equal(sequenceAfterInvoice.lastValue, seededValue + 1n);

        const confirmedInvoiceEffects = async () => ({
          order: await db.operationOrder.findUniqueOrThrow({ where: { id: invoiceTargetId } }),
          object: await db.operationObject.findUniqueOrThrow({ where: { id: invoiceTargetId } }),
          lines: await db.operationOrderLine.findMany({ where: { orderId: invoiceTargetId }, orderBy: { id: "asc" } }),
          reservations: await db.stockReservation.findMany({ where: { orderId: invoiceTargetId }, orderBy: { id: "asc" } }),
          assignments: await db.deliveryAssignment.count({ where: { orderId: invoiceTargetId } }),
          firstBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(historyRows.sourceLots[0]!.sourceLotId)!.balanceId } }),
          selectedBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(selectedSourceLot.sourceLotId)!.balanceId } }),
          sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
          numberReservations: await db.appSheetInvoiceNumberReservation.findMany({ where: { namespace: capture.captureId }, orderBy: { id: "asc" } }),
          receipt: await db.commandReceipt.findUniqueOrThrow({ where: { requestId: invoiceRequest.requestId } }),
          audits: await db.operationAudit.findMany({ where: { requestId: invoiceRequest.requestId }, orderBy: { id: "asc" } }),
          outbox: await db.operationOutbox.findMany({ where: { requestId: invoiceRequest.requestId }, orderBy: { id: "asc" } }),
        });
        const effectsAfterInvoice = await confirmedInvoiceEffects();
        const replayedInvoice = await command(invoiceRequest);
        assert.equal(replayedInvoice.body.replay, true);
        assert.deepEqual(await confirmedInvoiceEffects(), effectsAfterInvoice, "invoice replay does not double-reserve stock or advance numbering");

        const rejectedTargetId = `appsheet-source-lot-invalid-invoice-${randomUUID()}`;
        const invalidInvoice = invoiceData({ preorder: false, quantity: "3", lineId: `invalid-source-lot-line-${randomUUID()}` });
        const invalidInvoiceInput: Record<string, any> = {
          ...invalidInvoice, memberId: sourceMember.id,
          lines: invalidInvoice.lines.map(line => ({ ...line, skuId: sourceSku.id, sourceLotId: `missing-source-lot-${randomUUID()}` })),
        };
        delete invalidInvoiceInput.invoiceNumber;
        const invalidInvoiceRequest = envelope(rejectedTargetId, "InvoiceSaved", invalidInvoiceInput);
        const rollbackBefore = {
          sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
          numberReservations: await db.appSheetInvoiceNumberReservation.count(), stockReservations: await db.stockReservation.count(),
          orders: await db.operationOrder.count(), orderLines: await db.operationOrderLine.count(), assignments: await db.deliveryAssignment.count(),
          balances: await db.stockBalance.findMany({ where: { lotId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
        };
        const invalidInvoiceResult = await send(invalidInvoiceRequest);
        assert.equal(invalidInvoiceResult.response.status, 423, JSON.stringify(invalidInvoiceResult.body));
        assert.equal(invalidInvoiceResult.body.code, "APPSHEET_SOURCE_LOT_NOT_ELIGIBLE");
        assert.deepEqual({
          sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
          numberReservations: await db.appSheetInvoiceNumberReservation.count(), stockReservations: await db.stockReservation.count(),
          orders: await db.operationOrder.count(), orderLines: await db.operationOrderLine.count(), assignments: await db.deliveryAssignment.count(),
          balances: await db.stockBalance.findMany({ where: { lotId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
        }, rollbackBefore, "failed lot resolution rolls back the provisional order, number allocation, and stock effects");
        assert.equal(await db.operationOrder.findUnique({ where: { id: rejectedTargetId } }), null);
        assert.equal(await db.operationOrderLine.count({ where: { orderId: rejectedTargetId } }), 0);
        assert.equal(await db.operationObject.findUnique({ where: { id: rejectedTargetId } }), null);
        assert.equal(await db.stockReservation.count({ where: { orderId: rejectedTargetId } }), 0);
        assert.equal(await db.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: rejectedTargetId } }), null);
        assert.equal(await db.commandReceipt.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
        assert.equal(await db.operationAudit.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
        assert.equal(await db.operationOutbox.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
      });
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
