import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import { legacySourceFollowUpObjectId } from "../shared/operations/source-control.js";

const origin = "http://source-control.test";
const passwordText = "Synthetic-source-control-password";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("source-control HTTP search, privacy and audited follow-up preserve the immutable archive", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const testDatabase = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(testDatabase.hostname), "TEST_DATABASE_URL must use loopback");
  assert.match(testDatabase.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a disposable bombo_ui_* database");
  const configuredDatabase = process.env.DATABASE_URL;
  if (configuredDatabase) {
    const configured = new URL(configuredDatabase);
    const target = (url: URL) => JSON.stringify([
      url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      url.port || "5432",
      decodeURIComponent(url.pathname.slice(1)),
    ]);
    assert.notEqual(target(testDatabase), target(configured), "TEST_DATABASE_URL must not target DATABASE_URL");
  }

  const schema = `source_control_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new URL(testDatabase);
  adminDatabase.searchParams.set("schema", "public");
  const scopedDatabase = new URL(testDatabase);
  scopedDatabase.searchParams.set("schema", schema);
  const envNames = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN", "CLUB_OPERATIONS_APPROVED", "OPERATIONAL_REHEARSAL"] as const;
  const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));

  let db: (typeof import("../server/db.js"))["db"] | undefined;
  let baseDb: PrismaClient | undefined;
  let server: import("node:http").Server | undefined;
  let schemaCreated = false;
  try {
    const prismaGlobal = globalThis as typeof globalThis & { bomboPrisma?: unknown };
    assert.equal(prismaGlobal.bomboPrisma, undefined, "the source-control API test must not inherit an application Prisma singleton");
    baseDb = new PrismaClient({ datasources: { db: { url: adminDatabase.toString() } } });
    await baseDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    Object.assign(process.env, {
      DATABASE_URL: scopedDatabase.toString(),
      NODE_ENV: "test",
      DEMO_MODE: "true",
      JWT_SECRET: "source-control-test-secret-long-enough-for-local-auth",
      ALLOWED_ORIGIN: origin,
      CLUB_OPERATIONS_APPROVED: "false",
      OPERATIONAL_REHEARSAL: "false",
    });
    ({ db } = await import("../server/db.js"));
    const [{ versionNumber }] = await db.$queryRaw<Array<{ versionNumber: number }>>`
      SELECT current_setting('server_version_num')::integer AS "versionNumber"`;
    assert.ok(versionNumber >= 180000 && versionNumber < 190000, `expected isolated PostgreSQL 18, received ${versionNumber}`);

    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const ids = {
      reviewer: `source-reviewer-${randomUUID()}`,
      clinical: `source-clinical-${randomUUID()}`,
      viewer: `source-viewer-${randomUUID()}`,
      scoped: `source-scoped-reviewer-${randomUUID()}`,
    };
    const password = await bcrypt.hash(passwordText, 4);
    for (const [id, role] of [[ids.reviewer, "admin"], [ids.clinical, "admin"], [ids.viewer, "viewer"], [ids.scoped, "admin"]] as const) {
      await db.user.create({ data: { id, name: id, email: `${id}@source-control.test`, password, role } });
    }
    await db.operationAccess.create({ data: { userId: ids.reviewer, profile: "finance", capabilities: ["imports.review", "finance.read", "reports.read"] } });
    await db.operationAccess.create({ data: { userId: ids.clinical, profile: "clinical", capabilities: ["imports.review", "clinical.read"] } });
    await db.operationAccess.create({ data: { userId: ids.scoped, profile: "finance", capabilities: ["imports.review"], scope: { memberIds: [], accountIds: [], custodianIds: [], locationIds: [] } } });

    const snapshotId = `source-control-${randomUUID()}`;
    const fileHash = hash(`${snapshotId}\0file`);
    const importerVersion = "synthetic-source-control/1";
    const createdAt = new Date("2026-10-08T12:00:00.000Z");
    await db.legacyImportSnapshot.create({ data: {
      id: snapshotId,
      sourceSystem: "appsheet-business-archive",
      filename: "synthetic-source-control.xlsx",
      fileHash,
      importerVersion,
      status: "staged",
      createdBy: ids.reviewer,
      controls: { sourceClass: "technical-observation", sourceOnly: true },
      coverage: [{ name: "C_Cliente", role: "archive_only", recordCount: 205 }, { name: "C_Mercaderia", role: "archive_only", recordCount: 1 }],
      createdAt,
    } });
    const secondSnapshotId = `source-control-secondary-${randomUUID()}`;
    await db.legacyImportSnapshot.create({ data: {
      id: secondSnapshotId,
      sourceSystem: "appsheet-business-archive",
      filename: "Paciente SOURCE_CONTROL_METADATA_CANARY diagnóstico.xlsx",
      fileHash: hash(`${secondSnapshotId}\0file`),
      importerVersion: "SOURCE_CONTROL_METADATA_CANARY diagnóstico",
      status: "staged",
      createdBy: ids.reviewer,
      controls: { sourceClass: "technical-observation", sourceOnly: true },
      coverage: [],
      createdAt: new Date("2026-10-07T12:00:00.000Z"),
    } });
    await db.operationObject.create({ data: { id: snapshotId, kind: "legacyImport", version: 1, createdBy: ids.reviewer } });

    const records = Array.from({ length: 205 }, (_, index) => {
      const rowNumber = index + 1;
      const id = hash(`${snapshotId}\0C_Cliente\0${rowNumber}`);
      const columns = [
        { coordinate: `A${rowNumber}`, header: "Id_Cliente", value: `synthetic-client-${rowNumber}` },
        { coordinate: `B${rowNumber}`, header: "Nombre", value: `Cliente sintético ${rowNumber}` },
        ...(rowNumber === 202
          ? [{ coordinate: `C${rowNumber}`, header: "Notas médicas", value: "SOURCE_CONTROL_CLINICAL_CANARY" }]
          : []),
      ];
      return {
        id,
        snapshotId,
        sourceTable: "C_Cliente",
        sourceKey: `synthetic-client-${rowNumber}`,
        sourceRow: rowNumber,
        fileHash,
        contentHash: hash(`${id}\0content`),
        importerVersion,
        original: { columns },
        normalized: { columns: structuredClone(columns) },
        treatment: "archive_only",
      };
    });
    const otherTableId = hash(`${snapshotId}\0C_Mercaderia\0${2}`);
    records.push({
      id: otherTableId,
      snapshotId,
      sourceTable: "C_Mercaderia",
      sourceKey: "synthetic-merchandise-1",
      sourceRow: 2,
      fileHash,
      contentHash: hash(`${otherTableId}\0content`),
      importerVersion,
      original: { columns: [{ coordinate: "A2", header: "ID_Mercaderia", value: "synthetic-merchandise-1" }] },
      normalized: { columns: [{ coordinate: "A2", header: "ID_Mercaderia", value: "synthetic-merchandise-1" }] },
      treatment: "archive_only",
    });
    await db.legacySourceRecord.createMany({ data: records });
    const exceptionRows = [
      {
        id: hash(`${snapshotId}\0exception\0clinical-canary`),
        snapshotId,
        sourceRecordId: hash(`${snapshotId}\0C_Cliente\0${202}`),
        kind: "SOURCE_CONTROL_CLINICAL_CANARY",
        severity: "SOURCE_CONTROL_CLINICAL_CANARY",
        status: "SOURCE_CONTROL_CLINICAL_CANARY",
        description: "SOURCE_CONTROL_CLINICAL_CANARY",
      },
      {
        id: hash(`${snapshotId}\0exception\0${10}`),
        snapshotId,
        sourceRecordId: hash(`${snapshotId}\0C_Cliente\0${10}`),
        kind: "synthetic_review_10",
        severity: "review",
        description: "Synthetic review row 10",
      },
      {
        id: hash(`${snapshotId}\0exception\0unattached`),
        snapshotId,
        sourceRecordId: null,
        kind: "SOURCE_CONTROL_UNATTACHED_CLINICAL_CANARY",
        severity: "SOURCE_CONTROL_UNATTACHED_CLINICAL_CANARY",
        status: "SOURCE_CONTROL_UNATTACHED_CLINICAL_CANARY",
        description: "SOURCE_CONTROL_UNATTACHED_CLINICAL_CANARY",
      },
      ...Array.from({ length: 52 }, (_, index) => ({
        id: hash(`${snapshotId}\0exception\0${205}\0${index}`),
        snapshotId,
        sourceRecordId: hash(`${snapshotId}\0C_Cliente\0${205}`),
        kind: index === 0 ? "SOURCE_CONTROL_EXCEPTION_CANARY" : `synthetic_review_205_${index}`,
        severity: "review",
        description: `Synthetic review row 205 exception ${index}`,
      })),
    ];
    await db.legacyException.createMany({ data: exceptionRows });
    await db.operationAuthority.create({ data: { id: "operations", mode: "shadow", epoch: 7 } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api`;
    const cookies: Record<string, string> = {};

    async function login(id: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@source-control.test`, password: passwordText }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function call(path: string, actor = ids.reviewer, body?: unknown) {
      return fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookies[actor] ?? "", Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function assertNoCommandEffects(command: { requestId: string; targetId: string }) {
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId: command.requestId } }), null,
        "a rejected command creates no receipt");
      assert.equal(await db.operationOutbox.count({ where: { requestId: command.requestId } }), 0,
        "a rejected command emits no outbox event");
      assert.equal(await db.operationAudit.count({ where: { requestId: command.requestId } }), 0,
        "a rejected command creates no audit entry");
      assert.equal(await db.operationObject.findUnique({ where: { id: command.targetId } }), null,
        "a rejected command creates no object or version");
    }
    function followUpCommand(recordId: string, requestId: string, expectedVersion: number, status: "pending" | "reviewing" | "explained", note: string) {
      return {
        schemaVersion: 1,
        requestId,
        targetId: legacySourceFollowUpObjectId(recordId),
        expectedVersion,
        occurredAt: new Date().toISOString(),
        command: "LegacySourceFollowUpRecorded",
        data: { snapshotId, recordId, status, note, evidence: "Synthetic supporting note" },
      };
    }

    await login(ids.reviewer);
    await login(ids.clinical);
    await login(ids.viewer);
    await login(ids.scoped);

    const attestationCredentialCanary = "Bearer synthetic.attestation.credential.canary.with.extra.parts";
    const signedUrlCanary = "https://storage.example.test/archive.xlsx?X-Amz-Credential=synthetic%2Fscope&X-Amz-Signature=synthetic-signature";
    const signedGoogleUrlCanary = "https://storage.googleapis.com/synthetic-bucket/archive.xlsx?X-Goog-Credential=synthetic%40example.test%2Fscope&X-Goog-Signature=synthetic-google-signature";
    const googleApiKeyCanary = "https://maps.googleapis.com/maps/api/geocode/json?key=AIzaSySyntheticGoogleApiKeyExample0123456789";
    await db.decisionInputAttestation.create({ data: {
      id: randomUUID(),
      domain: "cash_plan",
      scenario: "base",
      fromDate: new Date("2026-01-01T00:00:00.000Z"),
      throughDate: new Date("2027-12-31T00:00:00.000Z"),
      complete: true,
      sourceReference: signedUrlCanary,
      confirmedByUserId: ids.reviewer,
    } });
    await db.decisionStockMapping.create({ data: {
      id: randomUUID(),
      status: "separate",
      sharedLocationIds: [],
      localLocationIds: ["synthetic-local"],
      deliveryLocationIds: ["synthetic-delivery"],
      reference: signedGoogleUrlCanary,
      confirmedByUserId: ids.reviewer,
    } });
    const decisionInputsResponse = await call("/decision-inputs");
    assert.equal(decisionInputsResponse.status, 200, await decisionInputsResponse.clone().text());
    const decisionInputsText = await decisionInputsResponse.text();
    assert.doesNotMatch(decisionInputsText, /X-Amz-(?:Credential|Signature)|synthetic-signature|X-Goog-(?:Credential|Signature)|synthetic-google-signature/,
      "the decision-input snapshot redacts signed-URL credentials in persisted attestations and mappings");
    const decisionInputsBody = JSON.parse(decisionInputsText) as {
      mapping: { status: string; reference: string } | null;
      attestations: Array<{ domain: string; scenario: string | null; sourceReference: string }>;
    };
    const redactedAttestation = decisionInputsBody.attestations.find(attestation => attestation.domain === "cash_plan" && attestation.scenario === "base");
    assert.equal(redactedAttestation?.sourceReference, "[excluded authentication material]");
    assert.equal(decisionInputsBody.mapping?.status, "separate");
    assert.equal(decisionInputsBody.mapping?.reference, "[excluded authentication material]",
      "the persisted stock-mapping reference is redacted as well as financial input references");

    const obligationsSummary = await call("/reports/operations/summary?area=obligations-13-weeks&to=2026-10-09");
    assert.equal(obligationsSummary.status, 200, await obligationsSummary.clone().text());
    const obligationsSummaryText = await obligationsSummary.text();
    assert.doesNotMatch(obligationsSummaryText, /X-Amz-(?:Credential|Signature)|synthetic-signature/);
    const obligationsSummaryBody = JSON.parse(obligationsSummaryText) as { summary: { metrics: { attestation: { present: boolean; sourceReference?: string } } } };
    assert.equal(obligationsSummaryBody.summary.metrics.attestation.present, false,
      "a cash-plan attestation does not masquerade as completeness evidence for the 13-week payables report");

    const attestationsBeforeRejectedPost = await db.decisionInputAttestation.count();
    const attestationAuditsBeforeRejectedPost = await db.sensitiveAccessAudit.count({ where: { area: "data_coverage", action: "attest" } });
    for (const credentialReference of [attestationCredentialCanary, signedUrlCanary, signedGoogleUrlCanary, googleApiKeyCanary]) {
      const rejectedCredentialAttestation = await call("/decision-inputs/attestations", ids.reviewer, {
        domain: "cash_plan",
        scenario: "base",
        fromDate: "2099-01-01",
        throughDate: "2099-01-02",
        complete: true,
        sourceReference: credentialReference,
      });
      assert.equal(rejectedCredentialAttestation.status, 400, "credential-shaped attestation references are rejected before writing");
      const rejectedBody = await rejectedCredentialAttestation.text();
      assert.doesNotMatch(rejectedBody, /synthetic\.attestation\.credential\.canary|X-Amz-(?:Credential|Signature)|synthetic-signature|X-Goog-(?:Credential|Signature)|synthetic-google-signature|AIzaSySyntheticGoogleApiKeyExample/,
        "attestation validation does not echo credential-shaped content");
    }
    assert.equal(await db.decisionInputAttestation.count(), attestationsBeforeRejectedPost,
      "rejected attestation input creates no persistent attestation");
    assert.equal(await db.sensitiveAccessAudit.count({ where: { area: "data_coverage", action: "attest" } }), attestationAuditsBeforeRejectedPost,
      "rejected attestation input creates no sensitive-access audit entry");

    const forbidden = await call("/legacy-imports/source-control", ids.viewer);
    assert.equal(forbidden.status, 403, "source browsing requires imports.review");
    const scopedRequests = await Promise.all([
      call("/legacy-imports/source-control", ids.scoped),
      call(`/legacy-imports/source-control/${snapshotId}`, ids.scoped),
      call(`/legacy-imports/source-control/${snapshotId}/exceptions`, ids.scoped),
      call(`/legacy-imports/source-control/${snapshotId}/records`, ids.scoped),
      call(`/legacy-imports/source-control/${snapshotId}/records/${hash(`${snapshotId}\0C_Cliente\0${205}`)}/exceptions`, ids.scoped),
    ]);
    for (const response of scopedRequests) {
      assert.equal(response.status, 403, "a member, account, custodian, or location scope cannot read the unpartitioned legacy source archive");
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(snapshotId));
      assert.doesNotMatch(body, /SYNTHETIC|SOURCE_CONTROL_CLINICAL_CANARY/);
    }
    const scopedWriteCommand = followUpCommand(hash(`${snapshotId}\0C_Cliente\0${205}`), randomUUID(), 0, "reviewing", "Synthetic scoped follow-up");
    const scopedWrite = await call("/operations/commands", ids.scoped, scopedWriteCommand);
    assert.equal(scopedWrite.status, 403, "scoped access also cannot write follow-up to the unpartitioned archive");
    assert.doesNotMatch(await scopedWrite.text(), new RegExp(snapshotId));
    await assertNoCommandEffects(scopedWriteCommand);

    const listFirst = await call("/legacy-imports/source-control?limit=1&q=appsheet-business-archive");
    assert.equal(listFirst.status, 200, await listFirst.clone().text());
    const firstPage = await listFirst.json() as { items: Array<{ snapshotId: string }>; nextCursor: string | null };
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor, "the source list exposes a continuation cursor");
    const listSecond = await call(`/legacy-imports/source-control?limit=1&q=appsheet-business-archive&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    assert.equal(listSecond.status, 200);
    const secondPage = await listSecond.json() as { items: Array<{ snapshotId: string }>; nextCursor: string | null };
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0]!.snapshotId, firstPage.items[0]!.snapshotId);
    assert.equal(secondPage.nextCursor, null);

    const restrictedMetadataResponse = await call(`/legacy-imports/source-control/${secondSnapshotId}`);
    assert.equal(restrictedMetadataResponse.status, 200);
    const restrictedMetadataText = await restrictedMetadataResponse.text();
    assert.doesNotMatch(restrictedMetadataText, /SOURCE_CONTROL_METADATA_CANARY/);
    const restrictedMetadata = JSON.parse(restrictedMetadataText) as { source: { filename: string; importerVersion: string } };
    assert.equal(restrictedMetadata.source.filename, "[restricted source metadata]");
    assert.equal(restrictedMetadata.source.importerVersion, "[restricted source metadata]");

    const restrictedMetadataSearch = await call("/legacy-imports/source-control?limit=10&q=SOURCE_CONTROL_METADATA_CANARY");
    assert.equal(restrictedMetadataSearch.status, 200);
    assert.deepEqual((await restrictedMetadataSearch.json() as { items: unknown[] }).items, [],
      "reviewer search does not reveal a match in clinical source metadata they cannot see");
    const clinicalMetadataResponse = await call("/legacy-imports/source-control/" + secondSnapshotId, ids.clinical);
    assert.equal(clinicalMetadataResponse.status, 200);
    const clinicalMetadata = await clinicalMetadataResponse.json() as { source: { filename: string; importerVersion: string } };
    assert.equal(clinicalMetadata.source.filename, "Paciente SOURCE_CONTROL_METADATA_CANARY diagnóstico.xlsx");
    assert.equal(clinicalMetadata.source.importerVersion, "SOURCE_CONTROL_METADATA_CANARY diagnóstico");
    const clinicalMetadataSearch = await call("/legacy-imports/source-control?limit=10&q=SOURCE_CONTROL_METADATA_CANARY", ids.clinical);
    assert.equal(clinicalMetadataSearch.status, 200);
    const clinicalMetadataSearchItems = await clinicalMetadataSearch.json() as { items: Array<{ snapshotId: string }> };
    assert.deepEqual(clinicalMetadataSearchItems.items.map(item => item.snapshotId), [secondSnapshotId]);

    const sourceResponse = await call(`/legacy-imports/source-control/${snapshotId}`);
    assert.equal(sourceResponse.status, 200);
    const { source } = await sourceResponse.json() as { source: { snapshotId: string; sourceSystem: string; filename: string; rowCount: number; exceptionCount: number; unattachedExceptionCount: number; technicalSource: boolean; allowedActions: { recordFollowUp: boolean; genericLegacyWorkflow: boolean } } };
    assert.equal(source.snapshotId, snapshotId);
    assert.equal(source.sourceSystem, "appsheet-business-archive");
    assert.equal(source.filename, "synthetic-source-control.xlsx");
    assert.equal(source.rowCount, 206);
    assert.equal(source.exceptionCount, 55);
    assert.equal(source.unattachedExceptionCount, 1,
      "the source summary accounts for technical exceptions that cannot be linked to an extracted row");
    assert.equal(source.technicalSource, true);
    assert.equal(source.allowedActions.recordFollowUp, true);
    assert.equal(source.allowedActions.genericLegacyWorkflow, false,
      "a technical source advertises follow-up but not canonical publication or approval workflow");

    const unattachedExceptionResponse = await call(`/legacy-imports/source-control/${snapshotId}/exceptions?limit=1`);
    assert.equal(unattachedExceptionResponse.status, 200);
    const unattachedExceptionPage = await unattachedExceptionResponse.json() as { items: Array<{ exceptionId: string; code: string; severity: string; status: string }>; nextCursor: string | null };
    assert.deepEqual(unattachedExceptionPage.items, [{
      exceptionId: hash(`${snapshotId}\0exception\0unattached`),
      code: "other_technical_exception",
      severity: "unknown",
      status: "unknown",
    }], "unattached exceptions are visible as sanitized technical metadata only");
    assert.equal(unattachedExceptionPage.nextCursor, null);
    assert.doesNotMatch(JSON.stringify(unattachedExceptionPage), /SOURCE_CONTROL_UNATTACHED_CLINICAL_CANARY/);

    const rowExceptionAsUnattachedCursor = hash(`${snapshotId}\0exception\0clinical-canary`);
    const invalidUnattachedCursor = await call(`/legacy-imports/source-control/${snapshotId}/exceptions?cursor=${rowExceptionAsUnattachedCursor}&limit=1`);
    assert.equal(invalidUnattachedCursor.status, 400, "a cursor from a row-bound exception cannot page unattached exceptions");
    assert.equal((await invalidUnattachedCursor.json() as { code: string }).code, "INVALID_EXCEPTION_CURSOR");

    const recordsPath = `/legacy-imports/source-control/${snapshotId}/records`;
    const firstRecordsResponse = await call(`${recordsPath}?limit=5`);
    assert.equal(firstRecordsResponse.status, 200);
    const firstRecords = await firstRecordsResponse.json() as { items: Array<{ recordId: string; tableName: string; rowNumber: number }>; nextCursor: string | null };
    assert.equal(firstRecords.items.length, 5);
    assert.ok(firstRecords.nextCursor);
    const nextRecordsResponse = await call(`${recordsPath}?limit=5&cursor=${encodeURIComponent(firstRecords.nextCursor)}`);
    assert.equal(nextRecordsResponse.status, 200);
    const nextRecords = await nextRecordsResponse.json() as { items: Array<{ recordId: string; tableName: string; rowNumber: number }>; nextCursor: string | null };
    assert.equal(nextRecords.items.length, 5);
    assert.equal(new Set([...firstRecords.items, ...nextRecords.items].map(row => row.recordId)).size, 10,
      "the opaque continuation returns a distinct persisted page");
    assert.equal(firstRecords.items[0]!.rowNumber, 1);
    assert.equal(nextRecords.items[0]!.rowNumber, 6);

    const crossPageSearch = await call(`${recordsPath}?limit=5&q=205`);
    assert.equal(crossPageSearch.status, 200);
    const searchResult = await crossPageSearch.json() as { items: Array<{ recordId: string; tableName: string; rowNumber: number; exceptions: Array<{ code: string }>; followUp: unknown }>; nextCursor: string | null };
    assert.equal(searchResult.items.length, 1, "server search reaches a row beyond the first page");
    assert.equal(searchResult.items[0]!.rowNumber, 205);
    assert.equal(searchResult.items[0]!.tableName, "C_Cliente");
    assert.equal(searchResult.items[0]!.followUp, null);

    const tableFilter = await call(`${recordsPath}?limit=5&snapshotTable=C_Mercaderia`);
    assert.equal(tableFilter.status, 200);
    const filteredTable = await tableFilter.json() as { items: Array<{ tableName: string; rowNumber: number }>; nextCursor: string | null };
    assert.deepEqual(filteredTable.items.map(row => [row.tableName, row.rowNumber]), [["C_Mercaderia", 2]]);
    assert.equal(filteredTable.nextCursor, null);

    const exceptionFilter = await call(`${recordsPath}?limit=5&exceptionOnly=true`);
    assert.equal(exceptionFilter.status, 200);
    const exceptionalRows = await exceptionFilter.json() as { items: Array<{ rowNumber: number; exceptionCount: number }> };
    assert.deepEqual(exceptionalRows.items.map(row => [row.rowNumber, row.exceptionCount]), [[10, 1], [202, 1], [205, 52]]);

    const changedFilterCursor = await call(`${recordsPath}?limit=5&snapshotTable=C_Mercaderia&cursor=${encodeURIComponent(firstRecords.nextCursor)}`);
    assert.equal(changedFilterCursor.status, 400, "a cursor cannot be reused with different search filters");

    const clinicalSearch = await call(`${recordsPath}?q=SOURCE_CONTROL_CLINICAL_CANARY`);
    assert.equal(clinicalSearch.status, 200);
    const clinicalSearchBody = await clinicalSearch.text();
    assert.doesNotMatch(clinicalSearchBody, /SOURCE_CONTROL_CLINICAL_CANARY/);
    assert.deepEqual((JSON.parse(clinicalSearchBody) as { items: unknown[]; nextCursor: string | null }).items, [],
      "search cannot reveal a redacted cell or exception value, even through whether it matched");

    const restrictedRow = await call(`${recordsPath}?q=202`);
    assert.equal(restrictedRow.status, 200, "reviewers can navigate a row while the sensitive columns are redacted");
    const restrictedRowText = await restrictedRow.text();
    assert.doesNotMatch(restrictedRowText, /SOURCE_CONTROL_CLINICAL_CANARY/);
    const restrictedRowBody = JSON.parse(restrictedRowText) as { items: Array<{ rowNumber: number; exceptions: Array<{ code: string; severity: string; status: string }> }> };
    assert.equal(restrictedRowBody.items[0]!.rowNumber, 202);
    assert.doesNotMatch(JSON.stringify(restrictedRowBody.items[0]!.exceptions), /SOURCE_CONTROL_CLINICAL_CANARY/,
      "arbitrary clinical text in exception code, severity, or status is not exposed in a row list");
    const clinicalExceptions = await call(`/legacy-imports/source-control/${snapshotId}/records/${hash(`${snapshotId}\0C_Cliente\0${202}`)}/exceptions?limit=1`);
    assert.equal(clinicalExceptions.status, 200);
    assert.doesNotMatch(await clinicalExceptions.text(), /SOURCE_CONTROL_CLINICAL_CANARY/,
      "the paged exceptions endpoint also hides arbitrary clinical text without clinical.read");

    const clinicalRecordId = hash(`${snapshotId}\0C_Cliente\0${202}`);
    const forbiddenClinicalCommand = followUpCommand(clinicalRecordId, randomUUID(), 0, "reviewing", "Synthetic unauthorized clinical follow-up");
    const forbiddenClinicalFollowUp = await call("/operations/commands", ids.reviewer, forbiddenClinicalCommand);
    assert.equal(forbiddenClinicalFollowUp.status, 403, "writing follow-up to a clinical row requires clinical.read");
    assert.equal((await forbiddenClinicalFollowUp.json() as { code: string }).code, "CLINICAL_CAPABILITY_REQUIRED");
    await assertNoCommandEffects(forbiddenClinicalCommand);

    const credentialCanary = "Bearer synthetic.credential.canary.with.extra.parts";
    const credentialRecordId = hash(`${snapshotId}\0C_Cliente\0${205}`);
    const forbiddenCredentialCommand = followUpCommand(credentialRecordId, randomUUID(), 0, "reviewing", "Synthetic credential validation");
    forbiddenCredentialCommand.data.evidence = credentialCanary;
    const forbiddenCredentialFollowUp = await call("/operations/commands", ids.reviewer, forbiddenCredentialCommand);
    assert.equal(forbiddenCredentialFollowUp.status, 400, "credential-shaped evidence is rejected before the follow-up writes");
    assert.doesNotMatch(await forbiddenCredentialFollowUp.text(), /synthetic\.credential\.canary/,
      "validation errors do not echo rejected credential-shaped evidence");
    await assertNoCommandEffects(forbiddenCredentialCommand);

    const authorizedClinicalRow = await call(`${recordsPath}?q=202`, ids.clinical);
    assert.equal(authorizedClinicalRow.status, 200);
    assert.match(await authorizedClinicalRow.text(), /SOURCE_CONTROL_CLINICAL_CANARY/);
    const authorizedCellSearch = await call(`${recordsPath}?q=SOURCE_CONTROL_CLINICAL_CANARY`, ids.clinical);
    assert.equal(authorizedCellSearch.status, 200);
    assert.equal((await authorizedCellSearch.json() as { items: Array<{ rowNumber: number }> }).items[0]!.rowNumber, 202,
      "search can find a cell only for an actor allowed to see that cell");
    const exceptionCanarySearch = await call(`${recordsPath}?q=SOURCE_CONTROL_EXCEPTION_CANARY`);
    assert.equal(exceptionCanarySearch.status, 200);
    assert.deepEqual((await exceptionCanarySearch.json() as { items: unknown[] }).items, [],
      "row search does not search exception content or reveal its match count");

    const exceptionRecordId = hash(`${snapshotId}\0C_Cliente\0${205}`);
    const firstExceptionPageResponse = await call(`/legacy-imports/source-control/${snapshotId}/records/${exceptionRecordId}/exceptions?limit=2`);
    assert.equal(firstExceptionPageResponse.status, 200);
    const firstExceptionPage = await firstExceptionPageResponse.json() as { items: Array<{ exceptionId: string; code: string; severity: string; status: string }>; nextCursor: string | null };
    assert.equal(firstExceptionPage.items.length, 2);
    assert.ok(firstExceptionPage.nextCursor);
    assert.doesNotMatch(JSON.stringify(firstExceptionPage), /SOURCE_CONTROL_EXCEPTION_CANARY/,
      "arbitrary exception kind, severity and status are normalized before the paged read");
    const secondExceptionPageResponse = await call(`/legacy-imports/source-control/${snapshotId}/records/${exceptionRecordId}/exceptions?limit=2&cursor=${encodeURIComponent(firstExceptionPage.nextCursor)}`);
    assert.equal(secondExceptionPageResponse.status, 200);
    const secondExceptionPage = await secondExceptionPageResponse.json() as { items: Array<{ exceptionId: string }> ; nextCursor: string | null };
    assert.equal(secondExceptionPage.items.length, 2);
    assert.equal(new Set([...firstExceptionPage.items, ...secondExceptionPage.items].map(item => item.exceptionId)).size, 4,
      "the exception cursor advances through distinct persisted entries");

    const recordId = hash(`${snapshotId}\0C_Cliente\0${205}`);
    const originalBefore = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: recordId } });
    const exceptionsBefore = await db.legacyException.findMany({ where: { snapshotId, sourceRecordId: recordId }, orderBy: { id: "asc" } });
    const canonicalBefore = {
      facts: await db.legacyHistoricalFact.count({ where: { snapshotId } }),
      publications: await db.legacyHistoryPublication.count({ where: { sourceSystem: "appsheet-business-archive" } }),
      identities: await db.legacyIdentity.count({ where: { sourceSystem: "appsheet-business-archive" } }),
      ledgerEvents: await db.ledgerEvent.count(),
      ledgerLegs: await db.ledgerLeg.count(),
      stockFacts: await db.stockFact.count(),
    };
    assert.deepEqual(canonicalBefore, { facts: 0, publications: 0, identities: 0, ledgerEvents: 0, ledgerLegs: 0, stockFacts: 0 });

    const firstRequestId = randomUUID();
    const firstCommand = followUpCommand(recordId, firstRequestId, 0, "reviewing", "Synthetic follow-up note v1");
    const productionShadowEnv = new Map(["NODE_ENV", "DEMO_MODE", "CLUB_OPERATIONS_APPROVED", "OPERATIONAL_REHEARSAL"].map(name => [name, process.env[name]]));
    let savedResponse: Response;
    try {
      Object.assign(process.env, {
        NODE_ENV: "production",
        DEMO_MODE: "false",
        CLUB_OPERATIONS_APPROVED: "false",
        OPERATIONAL_REHEARSAL: "false",
      });
      const authorityBeforeFollowUp = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
      assert.equal(authorityBeforeFollowUp.mode, "shadow");
      assert.equal(authorityBeforeFollowUp.firstRealWriteAt, null);
      savedResponse = await call("/operations/commands", ids.reviewer, firstCommand);
    } finally {
      for (const [name, value] of productionShadowEnv) restoreEnvironment(name, value);
    }
    assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
    const saved = await savedResponse.json() as { version: number; result: { snapshotId: string; recordId: string; followUp: { status: string; note: string; evidence: string; version: number; updatedAt: string; updatedBy: string } } };
    assert.equal(saved.version, 1);
    assert.ok(Number.isFinite(Date.parse(saved.result.followUp.updatedAt)));
    assert.deepEqual(saved.result.followUp, {
      status: "reviewing", note: "Synthetic follow-up note v1", evidence: "Synthetic supporting note", version: 1,
      updatedAt: saved.result.followUp.updatedAt,
      updatedBy: ids.reviewer,
    });
    assert.equal(saved.result.snapshotId, snapshotId);
    assert.equal(saved.result.recordId, recordId);
    const followUpObjectId = legacySourceFollowUpObjectId(recordId);
    assert.deepEqual(await db.operationObject.findUnique({ where: { id: followUpObjectId }, select: { kind: true, version: true } }),
      { kind: "legacySourceFollowUp", version: 1 },
      "the persisted operation object advances once with the first follow-up");
    const authorityAfterFollowUp = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    assert.deepEqual({ mode: authorityAfterFollowUp.mode, epoch: authorityAfterFollowUp.epoch, firstRealWriteAt: authorityAfterFollowUp.firstRealWriteAt },
      { mode: "shadow", epoch: 7, firstRealWriteAt: null },
      "a permitted administrative follow-up remains usable in production-shadow mode without opening real operations");

    const replayResponse = await call("/operations/commands", ids.reviewer, firstCommand);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as { replay?: boolean }).replay, true,
      "replaying the same request confirms the original persisted command");
    assert.equal(await db.commandReceipt.count({ where: { targetId: followUpObjectId } }), 1,
      "an idempotent retry creates one follow-up receipt");
    assert.equal(await db.operationOutbox.count({ where: { requestId: firstRequestId } }), 1,
      "an idempotent retry emits one outbox event");
    assert.equal(await db.operationObject.findUniqueOrThrow({ where: { id: followUpObjectId } }).then(object => object.version), 1,
      "an idempotent retry leaves the persisted object version unchanged");
    const firstAudit = await db.operationAudit.findMany({ where: { objectId: followUpObjectId } });
    assert.equal(firstAudit.length, 1);
    assert.doesNotMatch(JSON.stringify(firstAudit[0]!.details), /Synthetic follow-up note|Synthetic supporting note/,
      "the general audit stores the action and version, not free-text follow-up content");

    const freshRecordResponse = await call(`${recordsPath}?q=205`);
    assert.equal(freshRecordResponse.status, 200);
    const persistedRows = await freshRecordResponse.json() as { items: Array<{ followUp: { status: string; note: string; evidence: string; version: number; updatedBy: string } | null }> };
    assert.deepEqual(persistedRows.items[0]!.followUp, {
      status: "reviewing", note: "Synthetic follow-up note v1", evidence: "Synthetic supporting note", version: 1, updatedBy: ids.reviewer,
      updatedAt: (saved.result.followUp as { updatedAt: string }).updatedAt,
    }, "a fresh API read returns follow-up state stored outside the source row");

    const concurrentCommands = [
      followUpCommand(recordId, randomUUID(), 1, "explained", "Synthetic concurrent note A"),
      followUpCommand(recordId, randomUUID(), 1, "pending", "Synthetic concurrent note B"),
    ];
    const concurrentResponses = await Promise.all(concurrentCommands.map(command => call("/operations/commands", ids.reviewer, command)));
    const concurrentBodies = await Promise.all(concurrentResponses.map(response => response.json() as Promise<{ code?: string; result?: { followUp?: { note: string; status: string; evidence: string; version: number; updatedAt: string; updatedBy: string } } }>));
    assert.deepEqual(concurrentResponses.map(response => response.status).sort(), [200, 409],
      "two edits based on the same version cannot both replace the current follow-up");
    const conflictIndex = concurrentResponses.findIndex(response => response.status === 409);
    assert.equal(concurrentBodies[conflictIndex]!.code, "VERSION_CONFLICT");
    const winner = concurrentCommands.find((_command, index) => concurrentResponses[index]!.status === 200)!;
    const stale = concurrentCommands[conflictIndex]!;
    const staleReceipt = await db.commandReceipt.findUnique({ where: { requestId: stale.requestId } });
    assert.equal(staleReceipt, null, "a stale edit leaves no success receipt");
    assert.equal(await db.operationOutbox.count({ where: { requestId: stale.requestId } }), 0, "a stale edit emits no outbox event");
    assert.equal(await db.operationAudit.count({ where: { requestId: stale.requestId } }), 0, "a stale edit creates no audit entry");
    assert.equal(await db.operationObject.findUniqueOrThrow({ where: { id: followUpObjectId } }).then(object => object.version), 2,
      "two competing version-one updates advance the object exactly once");
    assert.equal(await db.commandReceipt.count({ where: { targetId: followUpObjectId } }), 2);
    assert.equal(await db.operationAudit.count({ where: { objectId: followUpObjectId } }), 2);

    const firstReplayAfterUpdate = await call("/operations/commands", ids.reviewer, firstCommand);
    assert.equal(firstReplayAfterUpdate.status, 200);
    assert.equal((await firstReplayAfterUpdate.json() as { replay?: boolean }).replay, true,
      "an old idempotency key still returns its original receipt after a later version wins");
    assert.equal(await db.operationObject.findUniqueOrThrow({ where: { id: followUpObjectId } }).then(object => object.version), 2,
      "replaying an older receipt does not rewind or increment the current version");
    assert.equal(await db.commandReceipt.count({ where: { targetId: followUpObjectId } }), 2);
    const latest = await call(`${recordsPath}?q=205`);
    assert.equal(latest.status, 200);
    const latestRows = await latest.json() as { items: Array<{ followUp: { status: string; note: string; version: number; evidence: string; updatedAt: string; updatedBy: string } }> };
    assert.deepEqual(latestRows.items[0]!.followUp, {
      status: winner.data.status as string,
      note: winner.data.note as string,
      version: 2,
      evidence: "Synthetic supporting note",
      updatedBy: ids.reviewer,
      updatedAt: concurrentBodies[concurrentResponses.findIndex(response => response.status === 200)]!.result!.followUp!.updatedAt,
    });

    const originalAfter = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: recordId } });
    const exceptionsAfter = await db.legacyException.findMany({ where: { snapshotId, sourceRecordId: recordId }, orderBy: { id: "asc" } });
    assert.deepEqual({
      id: originalAfter.id,
      sourceKey: originalAfter.sourceKey,
      sourceRow: originalAfter.sourceRow,
      treatment: originalAfter.treatment,
      original: originalAfter.original,
      normalized: originalAfter.normalized,
      resolution: originalAfter.resolution,
    }, {
      id: originalBefore.id,
      sourceKey: originalBefore.sourceKey,
      sourceRow: originalBefore.sourceRow,
      treatment: originalBefore.treatment,
      original: originalBefore.original,
      normalized: originalBefore.normalized,
      resolution: originalBefore.resolution,
    }, "follow-up does not edit or resolve the archived source row");
    assert.deepEqual(exceptionsAfter, exceptionsBefore, "follow-up leaves original exception status and evidence unchanged");
    assert.deepEqual({
      facts: await db.legacyHistoricalFact.count({ where: { snapshotId } }),
      publications: await db.legacyHistoryPublication.count({ where: { sourceSystem: "appsheet-business-archive" } }),
      identities: await db.legacyIdentity.count({ where: { sourceSystem: "appsheet-business-archive" } }),
      ledgerEvents: await db.ledgerEvent.count(),
      ledgerLegs: await db.ledgerLeg.count(),
      stockFacts: await db.stockFact.count(),
    }, canonicalBefore, "source follow-up creates no canonical facts, identities, publications, ledger entries or stock movements");
  } finally {
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    } finally {
      try {
        if (db) await db.$disconnect();
      } finally {
        delete (globalThis as typeof globalThis & { bomboPrisma?: unknown }).bomboPrisma;
        try {
          if (schemaCreated && baseDb) await baseDb.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          try {
            if (baseDb) await baseDb.$disconnect();
          } finally {
            for (const name of envNames) restoreEnvironment(name, previousEnv.get(name));
          }
        }
      }
    }
  }
});
