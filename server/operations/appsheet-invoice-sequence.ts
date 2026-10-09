import { createHash, randomUUID } from "node:crypto";
import { Prisma, type User } from "@prisma/client";
import { canonicalJson } from "../../shared/operations/exact.js";
import { APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../../shared/operations/appsheet-history.js";
import { prepareAppSheetCaptureManifest } from "../../shared/operations/appsheet-canonical.js";
import { formatAppSheetInvoiceNumberForYear } from "../../shared/operations/appsheet-invoice-rules.js";
import { OperationError, json, requireCapability, type Tx } from "./core.js";
import { requireApprovedAppSheetFinalDeltaGate } from "./access.js";

const INT64_MAX = 9_223_372_036_854_775_807n;
const HASH = /^[a-f0-9]{64}$/;

type InvoiceSourceRef = {
  sourceRecordId: string;
  sourceRow: number;
  sourceHash: string;
  sourceKeyHash: string;
  hiddenId: string;
};
type InvoiceSourceRow = InvoiceSourceRef & { invoiceNumber: string | null };
type HistoricalReservation = {
  invoiceNumber: string;
  refs: InvoiceSourceRef[];
};
type PreparedSeed = {
  report: AppSheetInvoiceSequenceSeedPreview;
  snapshotId: string;
  mappingId: string;
  publicationFingerprint: string;
  unnumberedSourceRefs: InvoiceSourceRef[];
  duplicateHiddenIdGroups: Array<{ hiddenId: string; refs: InvoiceSourceRef[] }>;
  reservations: HistoricalReservation[];
};

export type AppSheetInvoiceSequenceSeedPreview = {
  captureId: string;
  manifestHash: string;
  dataHash: string;
  snapshotId: string;
  mappingId: string;
  publicationFingerprint: string;
  sourceBindingHash: string;
  invoiceRecordCount: number;
  numberedInvoiceCount: number;
  unnumberedInvoiceCount: number;
  duplicateInvoiceNumberCount: number;
  duplicateHiddenIdCount: number;
  maxHiddenId: string;
  previewDigest: string;
  seedable: true;
};

export class AppSheetInvoiceSequenceError extends OperationError {
  constructor(code: string, message: string, status = 423, details?: unknown) {
    super(status, code, message, details);
    this.name = "AppSheetInvoiceSequenceError";
  }
}

function fail(code: string, message = "La numeración de facturas requiere una captura estable y una historia revisada y conciliada.", status = 423): never {
  throw new AppSheetInvoiceSequenceError(code, message, status);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameStableHistoryPages(coveragePages: unknown, capturePageManifest: unknown): boolean {
  if (!Array.isArray(coveragePages) || !Array.isArray(capturePageManifest) || coveragePages.length !== capturePageManifest.length) return false;
  const fields = ["sheetId", "title", "pageIndex", "startRow", "endRow", "pageHash", "verifiedPageHash", "stable"] as const;
  return coveragePages.every((value, index) => {
    const page = record(value);
    const source = record(capturePageManifest[index]);
    return Boolean(page && source && page.stable === true && page.pageHash === page.verifiedPageHash &&
      fields.every((field) => page[field] === source[field]));
  });
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCapture(capture: {
  captureId: string; sourceSystem: string; sourceId: string; spreadsheetId: string; metadataHash: string; headersHash: string;
  manifestHash: string; dataHash: string; definitionHash: string | null; stability: Prisma.JsonValue;
  firstReadAt: Date; verificationStartedAt: Date; verificationCompletedAt: Date; cutoffAt: Date;
  dataCoverage: Prisma.JsonValue; pageManifest: Prisma.JsonValue; definitionCoverage: Prisma.JsonValue | null;
  dataSheetCount: number; dataPageCount: number; dataRecordCount: number; dataFormulaCount: number; dataUnresolvedFormulaCount: number;
  definitionTableCount: number | null; definitionColumnCount: number | null; definitionSliceCount: number | null; definitionViewCount: number | null;
  definitionActionCount: number | null; definitionBotCount: number | null; definitionWorkflowRuleCount: number | null; definitionFormatRuleCount: number | null;
}) {
  try {
    const prepared = prepareAppSheetCaptureManifest({
      schemaVersion: "appsheet-capture-manifest/v1",
      captureId: capture.captureId, sourceSystem: capture.sourceSystem, sourceId: capture.sourceId, spreadsheetId: capture.spreadsheetId,
      metadataHash: capture.metadataHash, headersHash: capture.headersHash, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
      definitionHash: capture.definitionHash, stability: capture.stability,
      firstReadAt: capture.firstReadAt.toISOString(), verificationStartedAt: capture.verificationStartedAt.toISOString(),
      verificationCompletedAt: capture.verificationCompletedAt.toISOString(), cutoffAt: capture.cutoffAt.toISOString(),
      coverage: capture.dataCoverage, pages: capture.pageManifest, definitionCoverage: capture.definitionCoverage,
      dataSheetCount: capture.dataSheetCount, dataPageCount: capture.dataPageCount, dataRecordCount: capture.dataRecordCount,
      dataFormulaCount: capture.dataFormulaCount, dataUnresolvedFormulaCount: capture.dataUnresolvedFormulaCount,
      definitionTableCount: capture.definitionTableCount, definitionColumnCount: capture.definitionColumnCount,
      definitionSliceCount: capture.definitionSliceCount, definitionViewCount: capture.definitionViewCount,
      definitionActionCount: capture.definitionActionCount, definitionBotCount: capture.definitionBotCount,
      definitionWorkflowRuleCount: capture.definitionWorkflowRuleCount, definitionFormatRuleCount: capture.definitionFormatRuleCount,
    });
    if (prepared.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || prepared.captureId !== `appsreal-${prepared.manifestHash.slice(0, 16)}` ||
        prepared.sourceId !== prepared.spreadsheetId || prepared.stability.stable !== true)
      fail("APP_SHEET_CAPTURE_NOT_STABLE");
    return prepared;
  } catch (error) {
    if (error instanceof AppSheetInvoiceSequenceError) throw error;
    fail("APP_SHEET_CAPTURE_NOT_STABLE");
  }
}

function sourceColumns(value: Prisma.JsonValue): Array<{ header: unknown; value: unknown; exactDecimal?: unknown }> {
  const normalized = record(value);
  if (!normalized || !Array.isArray(normalized.columns)) fail("APP_SHEET_HISTORY_ROW_INVALID");
  return normalized.columns as Array<{ header: unknown; value: unknown; exactDecimal?: unknown }>;
}

function uniqueColumn(columns: ReturnType<typeof sourceColumns>, header: string) {
  const values = columns.filter((column) => column.header === header);
  if (values.length !== 1) fail("APP_SHEET_HISTORY_ROW_INVALID", `La historia no contiene una única columna ${header}.`);
  return values[0]!;
}

function hiddenIdValue(value: unknown): bigint {
  if (typeof value !== "string") fail("APP_SHEET_HIDDEN_ID_INVALID", "Id_Oculto debe tener un entero efectivo exacto para continuar.");
  const match = /^(0|[1-9]\d*)(?:\.0+)?$/.exec(value.trim());
  if (!match) fail("APP_SHEET_HIDDEN_ID_INVALID", "Id_Oculto debe tener un entero efectivo exacto para continuar.");
  const result = BigInt(match[1]!);
  if (result < 1n || result > INT64_MAX) fail("APP_SHEET_HIDDEN_ID_INVALID", "Id_Oculto está fuera del rango entero admitido.");
  return result;
}

function sourceReference(recordRow: {
  id: string; sourceKey: string; sourceRow: number; contentHash: string; normalized: Prisma.JsonValue;
}): InvoiceSourceRow {
  if (!HASH.test(recordRow.contentHash) || !Number.isSafeInteger(recordRow.sourceRow) || recordRow.sourceRow < 1)
    fail("APP_SHEET_HISTORY_ROW_INVALID");
  const columns = sourceColumns(recordRow.normalized);
  const hiddenId = hiddenIdValue(uniqueColumn(columns, "Id_Oculto").exactDecimal ?? uniqueColumn(columns, "Id_Oculto").value);
  const rawNumber = uniqueColumn(columns, "N_factura").value;
  if (rawNumber !== null && typeof rawNumber !== "string") fail("APP_SHEET_INVOICE_NUMBER_INVALID");
  const invoiceNumber = typeof rawNumber === "string" && rawNumber.trim() !== "" ? rawNumber : null;
  return {
    sourceRecordId: recordRow.id,
    sourceRow: recordRow.sourceRow,
    sourceHash: recordRow.contentHash,
    sourceKeyHash: sha256(recordRow.sourceKey),
    hiddenId: hiddenId.toString(),
    invoiceNumber,
  };
}

function referenceOnly(row: InvoiceSourceRow): InvoiceSourceRef {
  const { invoiceNumber: _invoiceNumber, ...reference } = row;
  return reference;
}

async function prepareSeed(tx: Tx, captureId: string, snapshotId: string): Promise<PreparedSeed> {
  const capture = await requireApprovedAppSheetFinalDeltaGate(tx, captureId);
  const preparedCapture = parseCapture(capture);

  const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: snapshotId }, include: { upload: { select: { completedAt: true } } } });
  if (!snapshot || snapshot.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || snapshot.filename !== "appsheet-live-capture" ||
      snapshot.fileHash !== preparedCapture.manifestHash || snapshot.captureManifestId !== preparedCapture.captureId ||
      snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.reviewedBy === snapshot.createdBy)
    fail("APP_SHEET_HISTORY_NOT_PUBLISHED", "La historia debe estar revisada de forma independiente y vinculada a la captura estable.");
  const coverage = record(snapshot.coverage);
  const coverageStability = record(coverage?.stability);
  const deltaEvidence = coverage?.deltaEvidence;
  const stage = record(record(snapshot.controls)?.appSheetHistoryStage);
  if (!coverage || coverage.schemaVersion !== "appsheet-history-coverage/v1" || coverage.projectionKind !== "history" ||
      coverage.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || coverage.captureId !== preparedCapture.captureId ||
      coverage.manifestHash !== preparedCapture.manifestHash || coverage.dataHash !== preparedCapture.dataHash ||
      coverage.captureDefinitionHash !== preparedCapture.definitionHash || coverage.mode !== "stable" ||
      !coverageStability || !sameCanonicalJson(coverageStability, preparedCapture.stability) ||
      !sameStableHistoryPages(coverage.pages, preparedCapture.pageManifest) || !Array.isArray(deltaEvidence) || deltaEvidence.length !== 0 ||
      !stage || stage.schemaVersion !== "appsheet-history-stage/v1" || stage.projectionKind !== "history" ||
      stage.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || stage.captureId !== preparedCapture.captureId ||
      stage.manifestHash !== preparedCapture.manifestHash || stage.dataHash !== preparedCapture.dataHash ||
      stage.captureDefinitionHash !== preparedCapture.definitionHash || stage.mode !== "stable" ||
      stage.definitionHash !== coverage.appliedDefinitionHash || stage.mappingId !== APPSHEET_HISTORY_MAPPING_ID || stage.status !== "staged")
    fail("APP_SHEET_HISTORY_BINDING_INVALID", "La cobertura y los controles publicados no corresponden a la captura estable.");
  if (snapshot.upload && !snapshot.upload.completedAt) fail("APP_SHEET_HISTORY_INCOMPLETE");

  const publication = await tx.legacyHistoryPublication.findUnique({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM } });
  if (!publication || publication.snapshotId !== snapshot.id || publication.fileHash !== snapshot.fileHash ||
      publication.mappingId !== APPSHEET_HISTORY_MAPPING_ID || !HASH.test(publication.fingerprint))
    fail("APP_SHEET_HISTORY_NOT_PUBLISHED", "La captura requiere una publicación histórica aprobada y vigente.");

  const [allRecordCount, allBaseFactCount, invoiceRecords, invoiceFacts] = await Promise.all([
    tx.legacySourceRecord.count({ where: { snapshotId } }),
    tx.legacyHistoricalFact.count({ where: { snapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, correctionOf: null } }),
    tx.legacySourceRecord.findMany({ where: { snapshotId, sourceTable: "C_Facturacion" }, orderBy: { sourceRow: "asc" },
      select: { id: true, sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, treatment: true, normalized: true } }),
    tx.legacyHistoricalFact.findMany({ where: { snapshotId, sourceTable: "C_Facturacion", mappingId: APPSHEET_HISTORY_MAPPING_ID, correctionOf: null },
      orderBy: { sourceRow: "asc" }, select: { sourceRecordId: true, sourceTable: true, sourceKey: true, sourceRow: true, sourceHash: true, kind: true } }),
  ]);
  if (allRecordCount !== preparedCapture.dataRecordCount || allBaseFactCount !== allRecordCount ||
      invoiceRecords.length === 0 || invoiceFacts.length !== invoiceRecords.length)
    fail("APP_SHEET_HISTORY_ROW_BINDING_INCOMPLETE", "Los registros y hechos históricos no cubren de forma completa la captura publicada.");

  const factsByRecord = new Map(invoiceFacts.map((fact) => [fact.sourceRecordId, fact]));
  for (const source of invoiceRecords) {
    const fact = factsByRecord.get(source.id);
    if (!fact || source.treatment !== "fact_candidate" || fact.kind !== "invoice" || fact.sourceTable !== source.sourceTable ||
        fact.sourceKey !== source.sourceKey || fact.sourceRow !== source.sourceRow || fact.sourceHash !== source.contentHash)
      fail("APP_SHEET_HISTORY_ROW_BINDING_INVALID", "Una fila de C_Facturacion no coincide con su hecho histórico congelado.");
  }
  const sheetCoverage = Array.isArray(coverage.sheets) ? coverage.sheets.map(record) : [];
  const invoiceCoverage = sheetCoverage.filter((sheet) => sheet?.sourceTable === "C_Facturacion");
  const table = invoiceCoverage.length === 1 ? invoiceCoverage[0] : null;
  if (!table || table.sourceRecordCount !== invoiceRecords.length || table.factCount !== invoiceFacts.length ||
      table.definitionTableMatch !== "unique" || (Array.isArray(table.changedPageIndexes) && table.changedPageIndexes.length > 0))
    fail("APP_SHEET_HISTORY_COVERAGE_MISMATCH", "La cobertura publicada de C_Facturacion no concilia con sus filas y hechos.");
  const openExceptions = await tx.legacyException.count({ where: { snapshotId, sourceRecordId: { in: invoiceRecords.map((item) => item.id) }, status: "open" } });
  if (openExceptions !== 0) fail("APP_SHEET_HISTORY_EXCEPTIONS_OPEN", "Cerrá las excepciones de C_Facturacion antes de sembrar la numeración.");

  const rows = invoiceRecords.map((source) => sourceReference(source));
  const byNumber = new Map<string, InvoiceSourceRef[]>();
  const byId = new Map<string, InvoiceSourceRef[]>();
  const unnumberedSourceRefs: InvoiceSourceRef[] = [];
  let maxHiddenId = 0n;
  const rowBindings = rows.map((row) => {
    const ref = referenceOnly(row);
    const hiddenId = BigInt(row.hiddenId);
    if (hiddenId > maxHiddenId) maxHiddenId = hiddenId;
    const hiddenRows = byId.get(row.hiddenId) ?? [];
    hiddenRows.push(ref);
    byId.set(row.hiddenId, hiddenRows);
    if (row.invoiceNumber === null) unnumberedSourceRefs.push(ref);
    else {
      const invoiceRows = byNumber.get(row.invoiceNumber) ?? [];
      invoiceRows.push(ref);
      byNumber.set(row.invoiceNumber, invoiceRows);
    }
    return { ...ref, invoiceNumber: row.invoiceNumber };
  });
  const reservations = [...byNumber.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([invoiceNumber, refs]) => ({ invoiceNumber, refs }));
  const duplicateHiddenIdGroups = [...byId.entries()].filter(([, refs]) => refs.length > 1).sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1)
    .map(([hiddenId, refs]) => ({ hiddenId, refs }));
  const duplicateInvoiceNumberCount = reservations.reduce((sum, item) => sum + Math.max(0, item.refs.length - 1), 0);
  const duplicateHiddenIdCount = duplicateHiddenIdGroups.reduce((sum, item) => sum + item.refs.length - 1, 0);
  const sourceBindingHash = sha256(canonicalJson({
    captureId: preparedCapture.captureId, manifestHash: preparedCapture.manifestHash, dataHash: preparedCapture.dataHash,
    snapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint: publication.fingerprint,
    rows: rowBindings,
  }));
  const previewPayload = {
    captureId: preparedCapture.captureId, manifestHash: preparedCapture.manifestHash, dataHash: preparedCapture.dataHash,
    snapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint: publication.fingerprint,
    sourceBindingHash, invoiceRecordCount: rows.length, numberedInvoiceCount: rows.length - unnumberedSourceRefs.length,
    unnumberedInvoiceCount: unnumberedSourceRefs.length, duplicateInvoiceNumberCount, duplicateHiddenIdCount,
    maxHiddenId: maxHiddenId.toString(),
  };
  const report: AppSheetInvoiceSequenceSeedPreview = { ...previewPayload, previewDigest: sha256(canonicalJson(previewPayload)), seedable: true };
  return { report, snapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint: publication.fingerprint,
    unnumberedSourceRefs, duplicateHiddenIdGroups, reservations };
}

/** Read-only preview; the report contains counts and hashes, never customer source values. */
export async function previewAppSheetInvoiceSequenceSeed(tx: Tx, input: { captureId: string; snapshotId: string }): Promise<AppSheetInvoiceSequenceSeedPreview> {
  return (await prepareSeed(tx, input.captureId, input.snapshotId)).report;
}

/** Apply a preview only after a live owner approval and exact transactional revalidation. */
export async function applyAppSheetInvoiceSequenceSeed(tx: Tx, input: {
  captureId: string; snapshotId: string; previewDigest: string; evidence: { note: string };
}, actor: User, now: Date): Promise<{ namespace: string; seededValue: string; reservations: number; previewDigest: string; replay: boolean }> {
  await requireCapability(tx, actor, "cutover.approve");
  const currentActor = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true, active: true } });
  if (!currentActor?.active || currentActor.role !== "owner")
    throw new OperationError(403, "OWNER_APPROVAL_REQUIRED", "La siembra de numeración requiere la aprobación de una persona propietaria activa.");
  if (!HASH.test(input.previewDigest) || !input.evidence.note.trim())
    throw new OperationError(422, "APP_SHEET_SEQUENCE_APPROVAL_EVIDENCE_REQUIRED", "Revisá la vista previa y registrá una evidencia de aprobación.");

  const prepared = await prepareSeed(tx, input.captureId, input.snapshotId);
  if (prepared.report.previewDigest !== input.previewDigest)
    throw new OperationError(409, "APP_SHEET_SEQUENCE_PREVIEW_STALE", "La historia cambió desde la vista previa; generá una nueva y revisá las diferencias.");
  const existing = await tx.appSheetInvoiceSequence.findUnique({ where: { namespace: prepared.report.captureId } });
  if (existing) {
    const same = existing.captureId === prepared.report.captureId && existing.manifestHash === prepared.report.manifestHash &&
      existing.snapshotId === input.snapshotId && existing.sourceBindingHash === prepared.report.sourceBindingHash &&
      record(existing.seedEvidence)?.previewDigest === input.previewDigest;
    if (!same) throw new OperationError(409, "APP_SHEET_SEQUENCE_SEED_CONFLICT", "La captura ya tiene una siembra diferente.");
    return { namespace: existing.namespace, seededValue: existing.seededValue.toString(), reservations: await tx.appSheetInvoiceNumberReservation.count({ where: { namespace: existing.namespace } }), previewDigest: input.previewDigest, replay: true };
  }
  const otherSeed = await tx.appSheetInvoiceSequence.findFirst({ select: { namespace: true } });
  if (otherSeed) throw new OperationError(409, "APP_SHEET_SEQUENCE_ALREADY_SEEDED", "La historia ya tiene otra captura sembrada; el delta debe conciliarse antes de reemplazar su numeración.");

  const nowIso = now.toISOString();
  const seedEvidence = json({
    schemaVersion: "appsheet-invoice-sequence-seed/v1",
    previewDigest: input.previewDigest,
    sourceBindingHash: prepared.report.sourceBindingHash,
    approval: { actorId: currentActor.id, approvedAt: nowIso, note: input.evidence.note.trim() },
    unnumberedSourceRefs: prepared.unnumberedSourceRefs,
    duplicateHiddenIdGroups: prepared.duplicateHiddenIdGroups,
  });
  const namespace = prepared.report.captureId;
  await tx.appSheetInvoiceSequence.create({ data: {
    namespace, captureId: prepared.report.captureId, manifestHash: prepared.report.manifestHash, dataHash: prepared.report.dataHash,
    snapshotId: prepared.snapshotId, mappingId: prepared.mappingId, publicationFingerprint: prepared.publicationFingerprint,
    sourceBindingHash: prepared.report.sourceBindingHash, lastValue: BigInt(prepared.report.maxHiddenId), seededValue: BigInt(prepared.report.maxHiddenId),
    invoiceRecordCount: prepared.report.invoiceRecordCount, numberedInvoiceCount: prepared.report.numberedInvoiceCount,
    unnumberedInvoiceCount: prepared.report.unnumberedInvoiceCount, duplicateInvoiceNumberCount: prepared.report.duplicateInvoiceNumberCount,
    duplicateHiddenIdCount: prepared.report.duplicateHiddenIdCount, seedEvidence, seededBy: currentActor.id, seededAt: now,
  } });
  const reservationRows = prepared.reservations.map(({ invoiceNumber, refs }) => ({
    id: createHash("sha256").update(`${namespace}\0historical\0${invoiceNumber}`, "utf8").digest("hex"),
    namespace, captureId: namespace, manifestHash: prepared.report.manifestHash, invoiceNumber, origin: "historical",
    orderId: null, sourceReferenceCount: refs.length, sourceReferences: json(refs), generatedId: null, generatedYear: null, createdBy: null,
  }));
  for (let start = 0; start < reservationRows.length; start += 500)
    await tx.appSheetInvoiceNumberReservation.createMany({ data: reservationRows.slice(start, start + 500) });
  return { namespace, seededValue: prepared.report.maxHiddenId, reservations: reservationRows.length, previewDigest: input.previewDigest, replay: false };
}

/** Allocate by updating the locked counter row, never by selecting MAX from invoice suffixes. */
export async function reserveNewAppSheetInvoiceNumber(tx: Tx, input: {
  captureId: string; orderId: string; now: Date; actorId: string;
}): Promise<{ invoiceNumber: string; id: bigint; year: number }> {
  const sequence = await tx.appSheetInvoiceSequence.findUnique({ where: { namespace: input.captureId } });
  if (!sequence || sequence.captureId !== input.captureId || sequence.manifestHash.length !== 64)
    throw new OperationError(423, "APP_SHEET_INVOICE_SEQUENCE_UNSEEDED", "La numeración real requiere una semilla histórica estable, publicada y aprobada.");
  const prior = await tx.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: input.orderId } });
  if (prior) {
    if (prior.origin !== "bombo" || prior.namespace !== input.captureId || prior.generatedId === null || prior.generatedYear === null)
      throw new OperationError(409, "APP_SHEET_INVOICE_RESERVATION_CONFLICT", "El pedido ya tiene una reserva de número incompatible.");
    return { invoiceNumber: prior.invoiceNumber, id: prior.generatedId, year: prior.generatedYear };
  }
  const capture = await tx.appSheetCaptureManifest.findUnique({ where: { captureId: sequence.captureId }, select: { manifestHash: true, stability: true, sourceSystem: true, sourceId: true, spreadsheetId: true } });
  const stability = record(capture?.stability);
  if (!capture || capture.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || capture.sourceId !== capture.spreadsheetId ||
      capture.manifestHash !== sequence.manifestHash || stability?.stable !== true)
    throw new OperationError(423, "APP_SHEET_INVOICE_SEQUENCE_CAPTURE_INVALID", "La secuencia ya no corresponde a una captura estable verificada.");
  const year = new Intl.DateTimeFormat("en", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric" }).format(input.now);
  const invoiceYear = Number(year);
  if (!Number.isInteger(invoiceYear) || invoiceYear < 1 || invoiceYear > 9999) throw new OperationError(422, "INVOICE_YEAR_INVALID", "No se pudo resolver el año comercial de la factura.");
  const maxReservationAttempts = Math.min(100_000, Math.max(1, sequence.invoiceRecordCount + 1));
  for (let attempt = 0; attempt < maxReservationAttempts; attempt++) {
    const incremented = await tx.$queryRaw<Array<{ lastValue: bigint }>>(Prisma.sql`
      UPDATE "AppSheetInvoiceSequence"
      SET "lastValue" = "lastValue" + 1, "updatedAt" = ${input.now}
      WHERE "namespace" = ${sequence.namespace} AND "captureId" = ${sequence.captureId}
        AND "manifestHash" = ${sequence.manifestHash} AND "lastValue" < ${INT64_MAX}
      RETURNING "lastValue"
    `);
    const id = incremented[0]?.lastValue;
    if (id === undefined) throw new OperationError(409, "APP_SHEET_INVOICE_SEQUENCE_EXHAUSTED", "La secuencia alcanzó el límite entero admitido.");
    const invoiceNumber = `${invoiceYear}|FA0${id <= 9999n ? (`00${id}`).slice(-4) : id.toString()}`;
    if (await tx.appSheetInvoiceNumberReservation.findUnique({ where: { invoiceNumber }, select: { id: true } })) continue;
    await tx.appSheetInvoiceNumberReservation.create({ data: {
      id: randomUUID(), namespace: sequence.namespace, captureId: sequence.captureId, manifestHash: sequence.manifestHash,
      invoiceNumber, origin: "bombo", orderId: input.orderId, sourceReferenceCount: 0, sourceReferences: [],
      generatedId: id, generatedYear: invoiceYear, createdBy: input.actorId,
    } });
    return { invoiceNumber, id, year: invoiceYear };
  }
  throw new OperationError(409, "APP_SHEET_INVOICE_NUMBER_COLLISIONS", "La numeración encontró demasiadas reservas históricas consecutivas y se detuvo sin repetir un número.");
}

export async function verifyExistingAppSheetInvoiceReservation(tx: Tx, input: {
  captureId?: string | null; orderId: string; invoiceNumber: string | null; generatedId?: bigint; generatedYear?: number;
}): Promise<void> {
  const reservation = await tx.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: input.orderId } });
  if (!reservation || reservation.origin !== "bombo" || reservation.invoiceNumber !== input.invoiceNumber ||
      (input.captureId && reservation.namespace !== input.captureId) ||
      (input.generatedId !== undefined && reservation.generatedId !== input.generatedId) ||
      (input.generatedYear !== undefined && reservation.generatedYear !== input.generatedYear) ||
      (input.generatedId !== undefined && input.generatedYear !== undefined &&
        input.invoiceNumber !== formatAppSheetInvoiceNumberForYear(input.generatedYear, input.generatedId)))
    throw new OperationError(409, "APP_SHEET_INVOICE_RESERVATION_MISSING", "La factura no conserva la reserva inmutable de su número.");
}
