import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import bcrypt from "bcryptjs";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
import { splitSqlStatements } from "./migration-sql.js";

const origin = "http://appsheet-preorder.test";

test("AppSheet preorder draft API preserves raw source fields, enforces scope and rolls back without operational effects", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname),
    "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i,
    "usar una base sintética bombo_ui_ dedicada");
  if (process.env.DATABASE_URL) {
    const applicationUrl = new URL(process.env.DATABASE_URL);
    assert.notEqual(
      databaseUrl.hostname + ":" + databaseUrl.port + databaseUrl.pathname,
      applicationUrl.hostname + ":" + applicationUrl.port + applicationUrl.pathname,
      "TEST_DATABASE_URL no puede ser la base de la aplicación",
    );
  }

  const schema = "appsheet_preorder_api_" + randomUUID().replaceAll("-", "");
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: randomBytes(32).toString("base64url"),
    ALLOWED_ORIGIN: origin,
  });

  let db: typeof import("../server/db.js")["db"] | undefined;
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    // Load the process-wide DB only after pointing it at this test-only schema.
    db = (await import("../server/db.js")).db;
    await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;

    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(migration.name + "/migration.sql", migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const primaryMemberId = "preorder-member-" + randomUUID();
    const otherMemberId = "preorder-member-" + randomUUID();
    await db.operationMember.create({
      data: {
        id: primaryMemberId,
        name: "Synthetic preorder member",
        email: "",
        phone: "",
        address: {},
        preferences: {},
        sourceSystem: null,
        sourceId: null,
        legacyCustomerId: null,
      },
    });
    await db.operationMember.create({
      data: {
        id: otherMemberId,
        name: "Synthetic out-of-scope member",
        email: "",
        phone: "",
        address: {},
        preferences: {},
        sourceSystem: null,
        sourceId: null,
        legacyCustomerId: null,
      },
    });

    const actorSpecs = {
      writer: { capabilities: ["orders.write", "operations.read"], memberIds: [primaryMemberId], profile: "commercial" },
      reader: { capabilities: ["operations.read"], memberIds: [primaryMemberId], profile: "viewer" },
      restrictedWriter: { capabilities: ["orders.write", "operations.read"], memberIds: [otherMemberId], profile: "commercial" },
      restrictedReader: { capabilities: ["operations.read"], memberIds: [otherMemberId], profile: "viewer" },
      noOrders: { capabilities: ["operations.read"], memberIds: [primaryMemberId], profile: "viewer" },
      noRead: { capabilities: ["orders.write"], memberIds: [primaryMemberId], profile: "commercial" },
    } as const;
    const actorIds: Record<keyof typeof actorSpecs, string> = {
      writer: "preorder-writer-" + randomUUID(),
      reader: "preorder-reader-" + randomUUID(),
      restrictedWriter: "preorder-restricted-writer-" + randomUUID(),
      restrictedReader: "preorder-restricted-reader-" + randomUUID(),
      noOrders: "preorder-no-orders-" + randomUUID(),
      noRead: "preorder-no-read-" + randomUUID(),
    };
    const emails: Record<string, string> = {};
    const passwords: Record<string, string> = {};
    for (const key of Object.keys(actorSpecs) as Array<keyof typeof actorSpecs>) {
      const id = actorIds[key];
      const email = (key + "-" + randomUUID() + "@synthetic-preorder.test").toLowerCase();
      const password = randomBytes(24).toString("base64url");
      emails[id] = email;
      passwords[id] = password;
      await db.user.create({
        data: {
          id,
          name: "Synthetic AppSheet preorder API actor",
          email,
          password: await bcrypt.hash(password, 4),
          role: "admin",
        },
      });
      await db.operationAccess.create({
        data: {
          userId: id,
          profile: actorSpecs[key].profile,
          capabilities: [...actorSpecs[key].capabilities],
          scope: { memberIds: [...actorSpecs[key].memberIds] },
        },
      });
    }

    // Generic invoice registration must be loaded so the negative test proves
    // object-kind isolation, instead of only proving that a command is unknown.
    await import("../server/operations/finance.js");
    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const apiBase = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api";
    const cookies: Record<string, string> = {};
    for (const id of Object.values(actorIds)) {
      const response = await fetch(apiBase + "/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: emails[id].toLowerCase(), password: passwords[id] }),
      });
      assert.equal(response.status, 200, "login HTTP de actor sintético");
      const cookie = response.headers.get("set-cookie");
      assert.ok(cookie, "el login debe entregar cookie de sesión");
      cookies[id] = cookie.split(";")[0]!;
    }

    const sendCommand = (actorId: string, envelope: CommandEnvelope) => fetch(apiBase + "/operations/commands", {
      method: "POST",
      headers: {
        Cookie: cookies[actorId]!,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    const readDetail = (actorId: string, targetId: string) => fetch(
      apiBase + "/operations/appsheet-preorders/" + encodeURIComponent(targetId),
      { headers: { Cookie: cookies[actorId]!, Origin: origin } },
    );
    const request = (
      targetId: string,
      command: string,
      data: Record<string, unknown>,
      expectedVersion = 0,
      requestId = randomUUID(),
    ): CommandEnvelope => ({
      schemaVersion: 1,
      requestId,
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    const reverseKeysDeep = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeysDeep);
      if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).reverse()
          .map(([key, nested]) => [key, reverseKeysDeep(nested)]),
      );
    };

    const readDraftRow = async (targetId: string) => {
      const rows = await db!.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT "id", "memberId", "schemaVersion", "snapshotHash", "payload", "createdBy", "createdAt", "updatedAt" ' +
        'FROM "AppSheetPreorderDraft" WHERE "id" = $1',
        targetId,
      );
      return rows[0] ?? null;
    };
    const operationEffects = async () => {
      const tables = [
        "OperationOrder",
        "OperationOrderLine",
        "InventoryLot",
        "StockBalance",
        "StockReservation",
        "StockFact",
        "PreparationAllocation",
        "DeliveryAssignment",
        "CollectionReport",
        "LedgerEvent",
        "LedgerLeg",
        "AppSheetInvoiceSequence",
        "AppSheetInvoiceNumberReservation",
        "Sale",
        "SaleItem",
        "CashEntry",
        "Movement",
      ] as const;
      const counts: Record<string, string> = {};
      for (const table of tables) {
        const rows = await db!.$queryRawUnsafe<Array<{ count: string }>>(
          'SELECT COUNT(*)::text AS count FROM "' + table + '"',
        );
        counts[table] = rows[0]!.count;
      }
      return counts;
    };
    const commandState = async (envelope: CommandEnvelope) => ({
      object: await db!.operationObject.findUnique({ where: { id: envelope.targetId } }),
      draft: await readDraftRow(envelope.targetId),
      receipt: await db!.commandReceipt.findUnique({ where: { requestId: envelope.requestId } }),
      outbox: await db!.operationOutbox.findMany({ where: { requestId: envelope.requestId }, orderBy: { id: "asc" } }),
      audit: await db!.operationAudit.findMany({ where: { requestId: envelope.requestId }, orderBy: { id: "asc" } }),
    });
    const rejectWithoutWrites = async (
      actorId: string,
      envelope: CommandEnvelope,
      expectedStatus: number,
      expectedCode?: string,
    ) => {
      const before = await commandState(envelope);
      const response = await sendCommand(actorId, envelope);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, expectedStatus, envelope.command + " debe rechazar la solicitud");
      if (expectedCode) assert.equal(body.code, expectedCode);
      assert.deepEqual(await commandState(envelope), before, envelope.command + " no debe escribir al fallar");
      return body;
    };

    const targetId = "bombo-preventa:" + randomUUID();
    const secondTargetId = "bombo-preventa:" + randomUUID();
    const header = {
      registeredAddress: "",
      declaredAddress: null,
      segment: "Entre10y15",
      grams: "0.001230000000000000",
      subtotal: "100.000000000000000001",
      paymentForm: "Transferencia",
      saleTransfer: "0",
      transferSubtotal: null,
      deliveryZone: "Centro",
      deliveryDate: "2026-10-11",
      motoClientTariff: "5.00",
      motoTransfer: "-0.000000000000000001",
      motoServiceTotal: "123.456789012345678901",
      motoAdminTariff: "7.5000",
      total: "777.777777777777777777",
      // note intentionally absent to verify absent differs from null and blank
    };
    const lines = [
      {
        article: "",
        variety: null,
        grams: "-0.1250000000000000001",
        productType: "Flor",
        formulaResults: {
          recordedAt: "2026-10-09T14:15:16.123Z",
          tariffScale: null,
          pricePerGram: "123.000000000000000001",
          total: "999.999999999999999999",
        },
      },
      {
        article: "Synthetic second line",
        variety: "Variedad",
        grams: "0",
        productType: "Concentrado",
      },
    ];
    const saveData: Record<string, unknown> = {
      memberId: primaryMemberId,
      header,
      formulaResults: { saleDate: "2026-10-09" },
      lines,
    };
    const save = request(targetId, "SourcePreorderSaved", saveData);
    const protectedTablesBefore = await operationEffects();

    const noCapability = request(secondTargetId, "SourcePreorderSaved", {
      ...saveData,
      memberId: primaryMemberId,
    });
    await rejectWithoutWrites(actorIds.noOrders, noCapability, 403);

    const outOfScope = request(secondTargetId, "SourcePreorderSaved", {
      ...saveData,
      memberId: primaryMemberId,
    });
    await rejectWithoutWrites(actorIds.restrictedWriter, outOfScope, 403);

    for (const [label, extra] of [
      ["currency", { currency: "ARS" }],
      ["legacy origin", { origin: "appsheet_capture" }],
      ["capture provenance", { appsheetCapture: { captureId: "synthetic-forbidden" } }],
      ["source row keys", { appsheetKeys: ["synthetic-forbidden"] }],
      ["capture metadata", { source: "AppSheet" }],
    ] as const) {
      const invalid = request(secondTargetId, "SourcePreorderSaved", { ...saveData, ...extra });
      const body = await rejectWithoutWrites(actorIds.writer, invalid, 400);
      assert.ok(body, "el rechazo de " + label + " devuelve cuerpo HTTP");
    }
    const nestedCurrency = request(secondTargetId, "SourcePreorderSaved", {
      ...saveData,
      header: { ...header, currency: "ARS" },
    });
    await rejectWithoutWrites(actorIds.writer, nestedCurrency, 400);
    const numericRawInput = request(secondTargetId, "SourcePreorderSaved", {
      ...saveData,
      header: { ...header, saleTransfer: 0 },
    });
    await rejectWithoutWrites(actorIds.writer, numericRawInput, 400);
    const invalidTarget = request("not-an-appsheet-preorder", "SourcePreorderSaved", saveData);
    await rejectWithoutWrites(actorIds.writer, invalidTarget, 400, "APPSHEET_PREORDER_TARGET_ID");

    // Fail in PostgreSQL after the aggregate, receipt and outbox writes have
    // begun; a trigger only in this random schema must roll the whole command back.
    const rollbackFunction = "preorder_rollback_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const rollbackTrigger = "preorder_rollback_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const rollbackRequest = request(secondTargetId, "SourcePreorderSaved", saveData);
    await db.$executeRawUnsafe(
      'CREATE FUNCTION "' + schema + '"."' + rollbackFunction + '"() RETURNS trigger ' +
      "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic preorder transaction rollback'; END; $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER "' + rollbackTrigger + '" BEFORE INSERT ON "OperationAudit" ' +
      'FOR EACH ROW EXECUTE FUNCTION "' + schema + '"."' + rollbackFunction + '"()',
    );
    try {
      const before = await commandState(rollbackRequest);
      const response = await sendCommand(actorIds.writer, rollbackRequest);
      assert.equal(response.status, 500, "el trigger sintético debe fallar después de escrituras transaccionales");
      assert.deepEqual(await commandState(rollbackRequest), before, "el error del trigger debe revertir agregado, receipt y outbox");
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "' + rollbackTrigger + '" ON "OperationAudit"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "' + schema + '"."' + rollbackFunction + '"()');
    }

    const saveResponse = await sendCommand(actorIds.writer, save);
    const saveBody = await saveResponse.json() as {
      requestId: string;
      targetId: string;
      version: number;
      result: { draft: Record<string, unknown> };
      replay?: boolean;
    };
    assert.equal(saveResponse.status, 200, "la preventa sintética se guarda por el contrato HTTP público");
    assert.equal(saveBody.requestId, save.requestId);
    assert.equal(saveBody.targetId, targetId);
    assert.equal(saveBody.version, 1);
    assert.equal(saveBody.replay, undefined, "un comando nuevo no se marca como replay");
    const draft = saveBody.result.draft;
    assert.equal(draft.id, targetId);
    assert.equal(draft.memberId, primaryMemberId);
    assert.equal(draft.version, 1);
    assert.equal(draft.schemaVersion, 1);
    assert.equal("createdBy" in draft, false, "la API no expone el actor de persistencia");
    assert.match(String(draft.snapshotHash), /^[a-f0-9]{64}$/);
    const payload = draft.payload as {
      origin: string;
      appsheetCapture: unknown;
      appsheetKeys: unknown;
      header: {
        rawValues: Record<string, { state: string; raw?: string }>;
        formulaResults: { verification: string; values: Record<string, { state: string; raw?: string }> };
        calculationProposal: { status: string; values: Record<string, unknown> };
      };
      lines: Array<{
        lineId: string;
        rawValues: Record<string, { state: string; raw?: string }>;
        formulaResults: { verification: string; values: Record<string, { state: string; raw?: string }> };
        calculationProposal: { status: string; values: Record<string, unknown> };
      }>;
    };
    assert.equal(payload.origin, "bombo_native");
    assert.equal(payload.appsheetCapture, null);
    assert.equal(payload.appsheetKeys, null);
    assert.deepEqual(payload.header.rawValues.registeredAddress, { state: "value", raw: "" });
    assert.deepEqual(payload.header.rawValues.declaredAddress, { state: "null" });
    assert.deepEqual(payload.header.rawValues.note, { state: "absent" });
    assert.deepEqual(payload.header.rawValues.saleTransfer, { state: "value", raw: "0" });
    assert.deepEqual(payload.header.rawValues.grams, { state: "value", raw: "0.001230000000000000" });
    assert.deepEqual(payload.header.rawValues.subtotal, { state: "value", raw: "100.000000000000000001" });
    assert.deepEqual(payload.header.rawValues.total, { state: "value", raw: "777.777777777777777777" });
    assert.notEqual(
      payload.header.rawValues.subtotal.raw,
      payload.header.rawValues.total.raw,
      "el total ingresado manualmente no se sustituye por subtotal",
    );
    assert.equal(payload.header.formulaResults.verification, "unverified");
    assert.deepEqual(payload.header.formulaResults.values.saleDate, { state: "value", raw: "2026-10-09" });
    assert.equal(payload.header.calculationProposal.status, "not_evaluated");
    assert.deepEqual(payload.header.calculationProposal.values, { saleDate: null });
    assert.equal(payload.lines.length, 2);
    assert.match(
      payload.lines[0]!.lineId,
      /^bombo-preventa-line:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.notEqual(payload.lines[0]!.lineId, payload.lines[1]!.lineId);
    assert.deepEqual(payload.lines[0]!.rawValues.article, { state: "value", raw: "" });
    assert.deepEqual(payload.lines[0]!.rawValues.variety, { state: "null" });
    assert.deepEqual(payload.lines[0]!.rawValues.grams, { state: "value", raw: "-0.1250000000000000001" });
    assert.equal(payload.lines[0]!.formulaResults.verification, "unverified");
    assert.deepEqual(payload.lines[0]!.formulaResults.values, {
      recordedAt: { state: "value", raw: "2026-10-09T14:15:16.123Z" },
      tariffScale: { state: "null" },
      pricePerGram: { state: "value", raw: "123.000000000000000001" },
      total: { state: "value", raw: "999.999999999999999999" },
    });
    assert.equal(payload.lines[0]!.calculationProposal.status, "not_evaluated");
    assert.deepEqual(payload.lines[0]!.calculationProposal.values, {
      recordedAt: null,
      tariffScale: null,
      pricePerGram: null,
      total: null,
    });
    assert.deepEqual(payload.lines[1]!.rawValues.grams, { state: "value", raw: "0" });
    assert.deepEqual(payload.lines[1]!.formulaResults.values, {
      recordedAt: { state: "absent" },
      tariffScale: { state: "absent" },
      pricePerGram: { state: "absent" },
      total: { state: "absent" },
    });

    const detailResponse = await readDetail(actorIds.reader, targetId);
    assert.equal(detailResponse.status, 200);
    const detailBody = await detailResponse.json() as { item: Record<string, unknown> };
    assert.deepEqual(detailBody.item, draft);
    const secondSave = request(secondTargetId, "SourcePreorderSaved", {
      memberId: primaryMemberId,
      // These money-named keys are raw AppSheet text states, not parsed money:
      // null and blank must pass the command hash and round-trip unchanged.
      header: { subtotal: null, total: "", note: null },
      lines: [],
    });
    const secondSaveResponse = await sendCommand(actorIds.writer, secondSave);
    const secondSaveBody = await secondSaveResponse.json() as typeof saveBody;
    assert.equal(secondSaveResponse.status, 200);
    assert.equal(secondSaveBody.version, 1);
    const secondPayload = secondSaveBody.result.draft.payload as typeof payload;
    assert.deepEqual(secondPayload.header.rawValues.subtotal, { state: "null" });
    assert.deepEqual(secondPayload.header.rawValues.total, { state: "value", raw: "" });
    assert.deepEqual(secondPayload.header.rawValues.note, { state: "null" });
    assert.equal(await db.commandReceipt.count({ where: { requestId: secondSave.requestId } }), 1);
    assert.equal(await db.operationOutbox.count({ where: { requestId: secondSave.requestId } }), 1);
    assert.equal(await db.operationAudit.count({ where: { requestId: secondSave.requestId } }), 1);

    const firstPageResponse = await fetch(
      apiBase + "/operations/appsheet-preorders?memberId=" + encodeURIComponent(primaryMemberId) + "&limit=1",
      { headers: { Cookie: cookies[actorIds.reader]!, Origin: origin } },
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as {
      items: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    const secondPageResponse = await fetch(
      apiBase + "/operations/appsheet-preorders?memberId=" + encodeURIComponent(primaryMemberId) +
        "&limit=1&cursor=" + encodeURIComponent(firstPage.nextCursor),
      { headers: { Cookie: cookies[actorIds.reader]!, Origin: origin } },
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json() as typeof firstPage;
    assert.equal(secondPage.items.length, 1, "el cursor devuelve el registro que sigue sin repetir el primero");
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(
      new Set([firstPage.items[0]!.id, secondPage.items[0]!.id]),
      new Set([targetId, secondTargetId]),
    );
    assert.notEqual(firstPage.items[0]!.id, secondPage.items[0]!.id);
    const noReadResponse = await readDetail(actorIds.noRead, targetId);
    assert.equal(noReadResponse.status, 403, "la lectura exige operations.read");
    const restrictedReadResponse = await readDetail(actorIds.restrictedReader, targetId);
    assert.equal(restrictedReadResponse.status, 403, "el detalle respeta el alcance del miembro");

    const storedHash = String((await readDraftRow(targetId))!.snapshotHash);
    const savedReceiptCount = await db.commandReceipt.count({ where: { requestId: save.requestId } });
    const savedOutboxCount = await db.operationOutbox.count({ where: { requestId: save.requestId } });
    const savedAuditCount = await db.operationAudit.count({ where: { requestId: save.requestId } });
    assert.equal(savedReceiptCount, 1);
    assert.equal(savedOutboxCount, 1);
    assert.equal(savedAuditCount, 1);
    assert.deepEqual(await operationEffects(), protectedTablesBefore, "guardar una preventa no crea efectos operativos");

    const replayResponse = await sendCommand(actorIds.writer, save);
    const replayBody = await replayResponse.json() as typeof saveBody;
    assert.equal(replayResponse.status, 200);
    assert.equal(replayBody.replay, true);
    assert.deepEqual(replayBody.result.draft, draft);
    assert.equal(await db.commandReceipt.count({ where: { requestId: save.requestId } }), 1);
    assert.equal(await db.operationOutbox.count({ where: { requestId: save.requestId } }), 1);
    assert.equal(await db.operationAudit.count({ where: { requestId: save.requestId } }), 1);

    const reorderedSave = reverseKeysDeep(save) as CommandEnvelope;
    const reorderedReplayResponse = await sendCommand(actorIds.writer, reorderedSave);
    const reorderedReplayBody = await reorderedReplayResponse.json() as typeof saveBody;
    assert.equal(reorderedReplayResponse.status, 200, "el orden de claves no cambia una operación idéntica");
    assert.equal(reorderedReplayBody.replay, true);
    assert.deepEqual(reorderedReplayBody.result.draft, draft);
    assert.equal(await db.commandReceipt.count({ where: { requestId: save.requestId } }), 1);
    assert.equal(await db.operationOutbox.count({ where: { requestId: save.requestId } }), 1);
    assert.equal(await db.operationAudit.count({ where: { requestId: save.requestId } }), 1);

    const changedBody: CommandEnvelope = {
      ...save,
      data: { ...saveData, header: { ...header, total: "888.000000000000000001" } },
    };
    await rejectWithoutWrites(actorIds.writer, changedBody, 409, "IDEMPOTENCY_KEY_REUSED");

    await db.operationAccess.update({
      where: { userId: actorIds.writer },
      data: { scope: { memberIds: [otherMemberId] } },
    });
    await rejectWithoutWrites(actorIds.writer, save, 403);
    await db.operationAccess.update({
      where: { userId: actorIds.writer },
      data: { scope: { memberIds: [primaryMemberId] } },
    });

    const invoiceConfirmation = request(targetId, "InvoiceConfirmed", {
      acceptance: { note: "Synthetic wrong-kind confirmation must not mutate a draft" },
    }, 1);
    await rejectWithoutWrites(actorIds.writer, invoiceConfirmation, 409, "OBJECT_KIND_MISMATCH");
    const staleUpdate = request(targetId, "SourcePreorderUpdated", {
      header: { ...header, total: "1.00" },
      lines: [],
    }, 0);
    await rejectWithoutWrites(actorIds.writer, staleUpdate, 409, "VERSION_CONFLICT");

    const corruptedHash = "0".repeat(64);
    await db.$executeRawUnsafe(
      'UPDATE "AppSheetPreorderDraft" SET "snapshotHash" = $1 WHERE "id" = $2',
      corruptedHash,
      targetId,
    );
    const corruptRead = await readDetail(actorIds.reader, targetId);
    assert.equal(corruptRead.status, 409);
    assert.equal((await corruptRead.json() as Record<string, unknown>).code, "APPSHEET_PREORDER_SNAPSHOT_INTEGRITY");
    const corruptEdit = request(targetId, "SourcePreorderUpdated", {
      header: { total: "2.00" },
      lines: [],
    }, 1);
    await rejectWithoutWrites(actorIds.writer, corruptEdit, 409, "APPSHEET_PREORDER_SNAPSHOT_INTEGRITY");
    await db.$executeRawUnsafe(
      'UPDATE "AppSheetPreorderDraft" SET "snapshotHash" = $1 WHERE "id" = $2',
      storedHash,
      targetId,
    );

    const firstLineId = payload.lines[0]!.lineId;
    const duplicateLineIds = request(targetId, "SourcePreorderUpdated", {
      header: { ...header, subtotal: "123.000000000000000001", total: "999.000000000000000002" },
      lines: [
        { lineId: firstLineId, article: "Synthetic edit A" },
        { lineId: firstLineId, article: "Synthetic edit B" },
      ],
    }, 1);
    await rejectWithoutWrites(actorIds.writer, duplicateLineIds, 422, "APPSHEET_PREORDER_LINE_DUPLICATE");

    const unknownLineId = request(targetId, "SourcePreorderUpdated", {
      header,
      lines: [{ lineId: "bombo-preventa-line:" + randomUUID(), article: "Synthetic unknown line" }],
    }, 1);
    await rejectWithoutWrites(actorIds.writer, unknownLineId, 422, "APPSHEET_PREORDER_LINE_UNKNOWN");

    const malformedLineId = request(targetId, "SourcePreorderUpdated", {
      header,
      lines: [{ lineId: "not-a-native-line-id", article: "Synthetic malformed line" }],
    }, 1);
    await rejectWithoutWrites(actorIds.writer, malformedLineId, 400);

    const attemptedFormulaEdit = request(targetId, "SourcePreorderUpdated", {
      header,
      lines: [{ lineId: firstLineId, article: "Synthetic formula overwrite", formulaResults: { total: "1" } }],
    }, 1);
    await rejectWithoutWrites(actorIds.writer, attemptedFormulaEdit, 400);

    const update = request(targetId, "SourcePreorderUpdated", {
      header: {
        registeredAddress: null,
        subtotal: "123.000000000000000001",
        total: "999.000000000000000002",
        deliveryDate: "",
      },
      lines: [
        { lineId: firstLineId, article: "Synthetic edited article", grams: "0", productType: "Flor" },
        { article: "Synthetic new line", variety: "", grams: "-0.0000001", productType: null },
      ],
    }, 1);
    const updateResponse = await sendCommand(actorIds.writer, update);
    const updateBody = await updateResponse.json() as typeof saveBody;
    assert.equal(updateResponse.status, 200);
    assert.equal(updateBody.version, 2);
    assert.equal(updateBody.result.draft.version, 2);
    assert.equal(updateBody.result.draft.memberId, primaryMemberId);
    const updatedPayload = updateBody.result.draft.payload as typeof payload;
    assert.deepEqual(updatedPayload.header.rawValues.registeredAddress, { state: "null" });
    assert.deepEqual(updatedPayload.header.rawValues.deliveryDate, { state: "value", raw: "" });
    assert.deepEqual(updatedPayload.header.rawValues.note, { state: "absent" });
    assert.deepEqual(updatedPayload.header.rawValues.subtotal, {
      state: "value",
      raw: "123.000000000000000001",
    });
    assert.deepEqual(updatedPayload.header.rawValues.total, {
      state: "value",
      raw: "999.000000000000000002",
    });
    assert.equal(updatedPayload.lines.length, 2, "la actualización guarda solamente las líneas enviadas");
    assert.equal(updatedPayload.lines[0]!.lineId, firstLineId);
    assert.deepEqual(updatedPayload.lines[0]!.rawValues.grams, { state: "value", raw: "0" });
    assert.deepEqual(updatedPayload.lines[0]!.formulaResults, payload.lines[0]!.formulaResults);
    assert.deepEqual(updatedPayload.lines[0]!.calculationProposal, payload.lines[0]!.calculationProposal);
    assert.match(
      updatedPayload.lines[1]!.lineId,
      /^bombo-preventa-line:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.notEqual(updatedPayload.lines[1]!.lineId, firstLineId);
    assert.deepEqual(updatedPayload.lines[1]!.rawValues.variety, { state: "value", raw: "" });
    assert.deepEqual(updatedPayload.lines[1]!.rawValues.grams, { state: "value", raw: "-0.0000001" });
    assert.deepEqual(updatedPayload.lines[1]!.rawValues.productType, { state: "null" });
    assert.deepEqual(updatedPayload.lines[1]!.formulaResults.values.total, { state: "absent" });
    assert.equal(updatedPayload.lines[1]!.calculationProposal.status, "not_evaluated");
    assert.deepEqual(await operationEffects(), protectedTablesBefore, "editar una preventa no crea efectos operativos");

    const requestIds = [save.requestId, secondSave.requestId, update.requestId];
    assert.equal(await db.commandReceipt.count({ where: { requestId: { in: requestIds } } }), 3);
    assert.equal(await db.operationOutbox.count({ where: { requestId: { in: requestIds } } }), 3);
    assert.equal(await db.operationAudit.count({ where: { requestId: { in: requestIds } } }), 3);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    if (schemaCreated && db) {
      await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    }
    if (db) await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
