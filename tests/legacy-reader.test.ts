import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { redactStagedException, redactStagedRecord } from "../server/operations/legacy-import.js";
import { commandSpecs } from "../server/operations/core.js";
import { containsRecognizableCredential, isCredentialBearingHeader, isCredentialMetadataKey, legacyReaderVersion, readLegacyWorkbook } from "../server/operations/legacy-reader.js";
import { legacyPayloadHash } from "../server/operations/legacy-upload-contract.js";
import { canonicalJson } from "../shared/operations/exact.js";

function sourceCellValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const sourceCell = value as { kind?: unknown; value?: unknown };
  return sourceCell.kind === "source_xml_cell" ? sourceCell.value : value;
}

function sourceXml(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceCell = value as { kind?: unknown; xml?: unknown };
  return sourceCell.kind === "source_xml_cell" && sourceCell.xml && typeof sourceCell.xml === "object"
    ? sourceCell.xml as Record<string, unknown>
    : null;
}

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const users = workbook.addWorksheet("T_Usuarios");
  users.addRow(["ID_Usuarios", { richText: [{ text: "Pass" }, { text: "word" }] }, "Contraseña", "Api Key", "Token", "ClaveCompuestaDoubleKey", "Nombre"]);
  users.addRow(["user-7", "DO_NOT_SERIALIZE_PASSWORD", "DO_NOT_SERIALIZE_CONTRASENA", "DO_NOT_SERIALIZE_API_KEY", "DO_NOT_SERIALIZE_TOKEN", "COMPOSITE_KEY_SHOULD_REMAIN", "Operador"]);
  const clients = workbook.addWorksheet("C_Cliente");
  clients.addRow(["Id_Cliente", "Nombre", "Credencial"]);
  clients.addRow(["client-9", "Socio de prueba", "SYNTHETIC_DOCUMENT_REFERENCE"]);
  const composite = workbook.addWorksheet("CompositeKeyFixture");
  composite.addRow(["DoubleKey", "Nombre"]);
  composite.addRow(["COMPOSITE_KEY_SHOULD_REMAIN", "Fixture"]);
  const currency = workbook.addWorksheet("C_OperacionUSD");
  currency.addRow(["ID_OPUSD", "MontoARS", "MontoUSD", "Estado_CAJA USD", "ID_Mov_Stock_Total"]);
  currency.addRow(["op-4", 1500.25, 10, 2500, "stock-total-3"]);
  const noKey = workbook.addWorksheet("Form_Stockxdíavariedad");
  noKey.addRow(["cosecha privada"]);
  noKey.getCell("A500").numFmt = "General";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("catalogue source identities use CatalogoID when the commercial code repeats", async () => {
  const workbook = new ExcelJS.Workbook();
  const catalogue = workbook.addWorksheet("D_Catalogo_Mercaderia");
  catalogue.addRow(["CatalogoID", "Codigo_Detalle", "Variedad_Cann"]);
  catalogue.addRow(["catalogue-a", "commercial-shared", "Variedad A"]);
  catalogue.addRow(["catalogue-b", "commercial-shared", "Variedad B"]);
  const snapshot = await readLegacyWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.deepEqual(snapshot.records.map(record => record.sourceKey), ["catalogue-a", "catalogue-b"]);
  assert.equal(snapshot.records.some(record => record.exceptions.some(exception => exception.kind === "duplicate_source_key")), false);
});

test("legacy XLSX snapshot excludes credential headers and values before serializing T_Usuarios", async () => {
  const bytes = await workbookBuffer();
  const snapshot = await readLegacyWorkbook(bytes);
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.fileHash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(legacyReaderVersion, "bombo-legacy-reader/1.0.4");
  assert.equal(isCredentialBearingHeader("Credencial", "C_Cliente"), false);
  assert.equal(isCredentialBearingHeader("Credencial"), true, "the exception is contextual to C_Cliente");
  assert.equal(isCredentialBearingHeader("Contraseña", "T_Usuarios"), true);
  assert.equal(isCredentialBearingHeader("DoubleKey", "CompositeKeyFixture"), false);
  assert.equal(isCredentialBearingHeader("ClaveCompuestaDoubleKey", "T_Usuarios"), false);
  assert.equal(isCredentialBearingHeader("Clave", "T_Usuarios"), true);
  assert.equal(isCredentialBearingHeader("Clave", "Settings"), false);
  assert.equal(snapshot.sheets.find((sheet) => sheet.name === "T_Usuarios")?.excludedCredentialColumns, 4);
  for (const secret of ["DO_NOT_SERIALIZE_PASSWORD", "DO_NOT_SERIALIZE_CONTRASENA", "DO_NOT_SERIALIZE_API_KEY", "DO_NOT_SERIALIZE_TOKEN", "Password", "Contraseña", "Api Key", "Token"])
    assert.equal(serialized.includes(secret), false, `${secret} must not appear anywhere in the snapshot`);
  assert.equal(serialized.includes("COMPOSITE_KEY_SHOULD_REMAIN"), true, "composite keys are source identifiers, not credentials");
  assert.equal(serialized.includes("ClaveCompuestaDoubleKey"), true, "composite keys remain classified before auth-table context");
  assert.equal(serialized.includes("DoubleKey"), true, "DoubleKey is not treated as a secret by name alone");
  assert.equal(snapshot.records.find((record) => record.sourceTable === "T_Usuarios")?.sourceKey, "user-7");
  assert.equal(snapshot.records.find((record) => record.sourceTable === "T_Usuarios")?.original.columns.some((column) => column.header === "Nombre"), true);
  const clientCredential = snapshot.records.find((record) => record.sourceTable === "C_Cliente");
  assert.equal(snapshot.sheets.find((sheet) => sheet.name === "C_Cliente")?.excludedCredentialColumns, 0);
  assert.equal(sourceCellValue(clientCredential?.original.columns.find((column) => column.header === "Credencial")?.value), "SYNTHETIC_DOCUMENT_REFERENCE");
  const moneyColumns = snapshot.records.find((record) => record.sourceTable === "C_OperacionUSD")?.normalized.columns ?? [];
  assert.equal(moneyColumns.find((column) => column.header === "MontoARS")?.moneyMinorUnits, "150025");
  assert.equal(moneyColumns.find((column) => column.header === "MontoUSD")?.moneyMinorUnits, "1000");
  assert.equal(moneyColumns.find((column) => column.header === "Estado_CAJA USD")?.moneyMinorUnits, undefined);
  assert.equal(moneyColumns.find((column) => column.header === "ID_Mov_Stock_Total")?.moneyMinorUnits, undefined);

  const begin = commandSpecs.get("LegacyUploadBegun");
  assert.ok(begin, "the batch metadata parser is registered");
  const manifest = { chunks: [], recordsByTable: {} };
  const validBegin = {
    sourceSystem: snapshot.sourceSystem,
    filename: "fixture.xlsx",
    fileHash: snapshot.fileHash,
    importerVersion: snapshot.importerVersion,
    manifestHash: legacyPayloadHash(manifest),
    manifest,
    controls: snapshot.summary,
    coverage: snapshot.sheets,
  };
  const accepted = begin.schema.safeParse(validBegin);
  assert.equal(accepted.success, true, accepted.success ? "" : JSON.stringify(accepted.error.issues));
  const rejected = begin.schema.safeParse({
    ...validBegin,
    controls: { ...snapshot.summary, review: { sessionToken: "ordinary synthetic" } },
  });
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.equal(rejected.error.issues.some((issue) => issue.message.includes("metadatos")), true);
});

test("recognized credentials in ordinary cells, formulas and identifiers never enter a legacy snapshot", async () => {
  const token="sk-proj-"+"synthetic".repeat(8),bearer="Bearer "+"synthetic".repeat(5);
  const workbook=new ExcelJS.Workbook(),clients=workbook.addWorksheet("C_Cliente");
  clients.addRow(["Id_Cliente","Nombre","Dirección","Credencial"]);
  clients.addRow([token,token,{formula:`CONCAT("${bearer}")`,result:"Ordinary cached result"},"credential-document.pdf"]);
  const coordinate=workbook.addWorksheet("Form_Stockxdíavariedad");coordinate.addRow(["password=synthetic-not-a-real-password"]);
  const snapshot=await readLegacyWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  const serialized=JSON.stringify(snapshot);
  for(const secret of [token,bearer,"synthetic-not-a-real-password"])assert.equal(serialized.includes(secret),false);
  assert.equal(snapshot.records.length,2);assert.equal(snapshot.records[0].sourceKey.startsWith("synthetic:"),true);
  assert.equal(snapshot.exceptions.filter(exception=>exception.kind==="credential_value_excluded").length,4);
  assert.equal(serialized.includes("credential-document.pdf"),true,"document references retain their restricted reference treatment");
  const old={sourceTable:"C_Cliente",sourceKey:token,original:{columns:[{header:"Nombre",value:token},{header:"Otra",value:"Visible"}]},normalized:{columns:[{header:"Nombre",value:bearer}]}};
  for(const includeClinical of [true,false]){const projection=JSON.stringify(redactStagedRecord(old,{includeClinical}));assert.equal(projection.includes(token),false);assert.equal(projection.includes(bearer),false);assert.equal(projection.includes("Visible"),true);}
  assert.equal(isCredentialMetadataKey("actualPassword"), true);
  assert.equal(isCredentialMetadataKey("sessionToken"), true);
  assert.equal(isCredentialMetadataKey("excludedCredentialColumns"), false);
  assert.equal(isCredentialMetadataKey("credentialColumnsExcluded"), false);
  assert.equal(isCredentialMetadataKey("sourceKey"), false);
  assert.equal(isCredentialMetadataKey("contentHash"), false);
  assert.equal(isCredentialMetadataKey("header"), false);
  const nestedSourceCellValue = {
    kind: "source_xml_cell",
    value: { kind: "formula", cachedResult: { password: "ordinary synthetic" } },
    xml: { cellType: "str", valuePresent: true },
  };
  assert.equal(containsRecognizableCredential({ controls: { audit: { password: "ordinary synthetic" } } }), true);
  assert.equal(containsRecognizableCredential({ coverage: [{ header: "Credencial", sourceKey: "client-9" }] }), false);
  assert.equal(containsRecognizableCredential({ original: { columns: [{ header: "Nombre", value: nestedSourceCellValue }] } }), true);

  const projected = redactStagedRecord({
    sourceTable: "C_Cliente",
    sourceKey: "client-9",
    original: { columns: [
      { coordinate: "C2", header: "Credencial", value: "SYNTHETIC_DOCUMENT_REFERENCE" },
      { coordinate: "B2", header: "Nombre", value: nestedSourceCellValue },
    ] },
    normalized: { columns: [
      { coordinate: "C2", header: "Credencial", value: "SYNTHETIC_DOCUMENT_REFERENCE" },
      { coordinate: "B2", header: "Nombre", value: nestedSourceCellValue },
    ] },
  }, { includeClinical: true });
  const redacted = JSON.stringify(projected);
  assert.equal(redacted.includes("password"), false);
  assert.equal(redacted.includes("ordinary synthetic"), false);
  assert.equal(redacted.includes("Credencial"), true, "the C_Cliente header value remains data");
  assert.equal(redacted.includes("SYNTHETIC_DOCUMENT_REFERENCE"), true, "the restricted reference remains available in the authorized projection");
  assert.equal(redacted.includes("sourceKey"), true, "sourceKey is a schema key, not a credential key");

  assert.equal(isCredentialMetadataKey("password"), true);
});

test("legacy rows without a source key keep coordinate identity and an explicit exception", async () => {
  const snapshot = await readLegacyWorkbook(await workbookBuffer());
  const record = snapshot.records.find((item) => item.sourceTable === "Form_Stockxdíavariedad");
  const coverage = snapshot.sheets.find((sheet) => sheet.name === "Form_Stockxdíavariedad");
  assert.ok(record);
  assert.match(record.sourceKey, /^synthetic:Form_Stockxdíavariedad!row:1$/);
  assert.equal(record.exceptions.some((exception) => exception.kind === "missing_source_key"), true);
  assert.equal(coverage?.recordCount, 1);
  assert.equal(coverage?.keyedRecordCount, 0);
  assert.equal(Object.hasOwn(coverage ?? {}, "rowCount"), false);
});

test("invalid XLSX dates remain in the row set and become coordinate-scoped blockers", async () => {
  const workbook = new ExcelJS.Workbook();
  const clients = workbook.addWorksheet("C_Cliente");
  clients.addRow(["Id_Cliente", "Fecha"]);
  const row = clients.addRow(["client-bad-date", 1_000_000_000]);
  row.getCell(2).numFmt = "yyyy-mm-dd";

  const snapshot = await readLegacyWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  const record = snapshot.records.find((item) => item.sourceKey === "client-bad-date");
  assert.ok(record);
  assert.equal(snapshot.summary.recordCount, 1);
  assert.equal(record.exceptions.some((exception) => exception.kind === "invalid_excel_date" && exception.severity === "blocking" && exception.evidence.coordinate === "B2"), true);
});

test("formula string caches survive date-formatted cells and content hashes use canonical JSON", async () => {
  const workbook = new ExcelJS.Workbook();
  const clients = workbook.addWorksheet("C_Cliente");
  clients.addRow(["Id_Cliente", "Fecha"]);
  const cache = clients.getCell("B2");
  cache.value = { formula: '"08/01/2026"', result: "08/01/2026" };
  cache.numFmt = "yyyy-mm-dd";

  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const worksheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(worksheetXml, /<c[^>]*r="B2"[^>]*t="str"[^>]*>[\s\S]*?<v>08\/01\/2026<\/v>/);

  const snapshot = await readLegacyWorkbook(bytes);
  const record = snapshot.records.find((item) => item.sourceTable === "C_Cliente");
  assert.ok(record);
  assert.equal(record.normalized.columns.find((column) => column.coordinate === "B2")?.value, "08/01/2026");
  const originalCell = record.original.columns.find((column) => column.coordinate === "B2")?.value;
  assert.equal(sourceXml(originalCell)?.cellType, "str");
  assert.equal(sourceXml(originalCell)?.storedValue, "08/01/2026");
  assert.equal((sourceCellValue(originalCell) as { cachedResult?: unknown }).cachedResult, "08/01/2026");

  const { contentHash, ...unsignedRecord } = record;
  assert.equal(contentHash, createHash("sha256").update(canonicalJson(unsignedRecord)).digest("hex"));
  const spec = commandSpecs.get("LegacySnapshotStaged");
  assert.ok(spec);
  const parsed = spec.schema.parse({
    sourceSystem: snapshot.sourceSystem,
    filename: "synthetic.xlsx",
    fileHash: snapshot.fileHash,
    importerVersion: snapshot.importerVersion,
    controls: {},
    coverage: [],
    records: [record],
  }) as { records: Array<Record<string, unknown>> };
  const { contentHash: parsedHash, ...parsedUnsignedRecord } = parsed.records[0];
  assert.equal(parsedHash, createHash("sha256").update(canonicalJson(parsedUnsignedRecord)).digest("hex"));
});

test("array formula XML metadata is retained as review evidence on coordinate-only sheets", async () => {
  const workbook = new ExcelJS.Workbook();
  const auxiliary = workbook.addWorksheet("Array");
  auxiliary.getCell("A1").value = 2;
  auxiliary.getCell("B1").value = { formula: "A1*2", result: 4 };
  const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
  const worksheetFile = zip.file("xl/worksheets/sheet1.xml");
  assert.ok(worksheetFile);
  const worksheetXml = await worksheetFile.async("string");
  assert.match(worksheetXml, /<f>A1\*2<\/f>/);
  zip.file("xl/worksheets/sheet1.xml", worksheetXml.replace("<f>A1*2</f>", '<f t="array" ref="B1">A1*2</f>'));

  const snapshot = await readLegacyWorkbook(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
  const record = snapshot.records.find((item) => item.sourceTable === "Array");
  const coverage = snapshot.sheets.find((sheet) => sheet.name === "Array");
  assert.ok(record);
  assert.equal(record.treatment, "archive_only");
  assert.equal(coverage?.coordinateRange, "A1:B1");
  const formulaCell = record.original.columns.find((column) => column.coordinate === "B1")?.value;
  assert.deepEqual(sourceXml(formulaCell)?.formula, { type: "array", ref: "B1" });
  assert.equal(record.exceptions.some((exception) => exception.kind === "array_formula_preserved" && exception.severity === "review" && exception.evidence.coordinate === "B1"), true);
  assert.equal(record.exceptions.some((exception) => exception.kind === "invalid_excel_date"), false);
});

test("numeric cells keep their exact source XML lexeme inside original.value", async () => {
  const bytes = await workbookBuffer();
  const snapshot = await readLegacyWorkbook(bytes);
  const record = snapshot.records.find((item) => item.sourceTable === "C_OperacionUSD");
  assert.ok(record);
  const amount = record.original.columns.find((column) => column.header === "MontoARS");
  assert.ok(amount);
  assert.equal(sourceXml(amount.value)?.cellType, "n");
  assert.equal(sourceXml(amount.value)?.storedValue, "1500.25");
  assert.equal(sourceCellValue(amount.value), "1500.25");
  assert.equal(record.normalized.columns.find((column) => column.header === "MontoARS")?.exactDecimal, "1500.25");
});

test("cash overlap compares the result flag case-insensitively while preserving real value differences", async () => {
  async function makeSnapshot(currentFlag: string, legacyFlag: string) {
    const workbook = new ExcelJS.Workbook();
    const headers = ["ID_Movimiento", "Fecha", "Tipo_Movimiento", "Concepto", "Caja", "Monto", "Tipo_Moneda", "Afecta_Resultado"];
    const current = workbook.addWorksheet("Movimiento_Nueva");
    current.addRow(["ID_Movimiento_Unique", ...headers]);
    current.addRow(["current-cash-1", "cash-1", "2026-01-02", "venta", "caja", "local", 1200.5, "ARS", currentFlag]);
    const legacy = workbook.addWorksheet("Movimiento");
    legacy.addRow(headers);
    legacy.addRow(["cash-1", "2026-01-02", "venta", "caja", "local", 1200.5, "ARS", legacyFlag]);
    return readLegacyWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  }

  const casingOnly = await makeSnapshot("si", "SI");
  assert.equal(casingOnly.summary.cashOverlap.exact_legacy_fields, 1);
  assert.equal(casingOnly.summary.cashOverlap.different_legacy_fields, 0);
  const currentRecord = casingOnly.records.find((record) => record.sourceTable === "Movimiento_Nueva");
  assert.equal(currentRecord?.sourceKey, "current-cash-1");
  assert.equal(currentRecord?.treatment, "archive_only");
  assert.equal(casingOnly.summary.keyedRecordCount, 2);
  const preservedCurrent = currentRecord?.normalized.columns.find((column) => column.header === "Afecta_Resultado")?.value;
  const preservedLegacy = casingOnly.records.find((record) => record.sourceTable === "Movimiento")?.normalized.columns.find((column) => column.header === "Afecta_Resultado")?.value;
  assert.equal(preservedCurrent, "si");
  assert.equal(preservedLegacy, "SI");

  const semanticDifference = await makeSnapshot("si", "no");
  assert.equal(semanticDifference.summary.cashOverlap.exact_legacy_fields, 0);
  assert.equal(semanticDifference.summary.cashOverlap.different_legacy_fields, 1);
});

test("public staged-record projection omits restricted columns without clinical.read", () => {
  const staged = {
    id: "record-1",
    sourceTable: "REPROCAM",
    sourceKey: "PRIVATE_SOURCE_KEY",
    original: { columns: [
      { coordinate: "A2", header: "Diagnóstico", value: "PRIVATE_DIAGNOSIS" },
      { coordinate: "B2", header: "Nombre", value: "Visible name" },
      { coordinate: "C2", header: null, value: "UNCLASSIFIED_PRIVATE_VALUE" },
      { coordinate: "D2", header: "REPROCAM", value: "PRIVATE_REPROCAM_VALUE" },
      { coordinate: "E2", header: "Credencial", value: "PRIVATE_CREDENTIAL" },
      { coordinate: "F2", header: "Vigencia del permiso", value: "PRIVATE_VALIDITY" },
      { coordinate: "G2", header: "documentClinical", value: "PRIVATE_CLINICAL_DOCUMENT" },
    ] },
    normalized: { columns: [
      { coordinate: "A2", header: "Antecedente médico", value: "PRIVATE_HISTORY", exactDecimal: "123" },
      { coordinate: "B2", header: "Nombre", value: "Visible name" },
      { coordinate: "E2", header: "DoubleKey", value: "PRIVATE_DOUBLE_KEY", moneyMinorUnits: "999" },
    ] },
    resolution: { status: "mapped", evidence: "PRIVATE_REVIEW_EVIDENCE" },
  };

  const unauthorized = JSON.stringify(redactStagedRecord(staged));
  for (const privateValue of [
    "Diagnóstico", "PRIVATE_DIAGNOSIS", "PRIVATE_SOURCE_KEY", "A2", "C2", "UNCLASSIFIED_PRIVATE_VALUE",
    "REPROCAM", "PRIVATE_REPROCAM_VALUE", "Credencial", "PRIVATE_CREDENTIAL", "Vigencia del permiso",
    "PRIVATE_VALIDITY", "documentClinical", "PRIVATE_CLINICAL_DOCUMENT", "PRIVATE_HISTORY", "123",
    "PRIVATE_DOUBLE_KEY", "999", "PRIVATE_REVIEW_EVIDENCE",
  ]) assert.equal(unauthorized.includes(privateValue), false, `${privateValue} must not appear in the unauthorized projection`);
  assert.equal(unauthorized.includes("Visible name"), true);
  assert.equal(unauthorized.includes("[review evidence stored privately]"), true);

  const authorized = JSON.stringify(redactStagedRecord(staged, { includeClinical: true }));
  for (const clinicalValue of ["PRIVATE_DIAGNOSIS", "PRIVATE_REPROCAM_VALUE", "PRIVATE_VALIDITY", "PRIVATE_CLINICAL_DOCUMENT", "PRIVATE_HISTORY"])
    assert.equal(authorized.includes(clinicalValue), true, `${clinicalValue} is available to clinical.read`);
  for (const credential of ["Credencial", "PRIVATE_CREDENTIAL"])
    assert.equal(authorized.includes(credential), false, `${credential} remains excluded in this non-C_Cliente context`);
  assert.equal(authorized.includes("PRIVATE_DOUBLE_KEY"), true, "a composite key is retained for an authorized clinical reader");
});

test("C_Cliente document references stay restricted in API projections but remain available to clinical.read", () => {
  const staged = {
    sourceTable: "C_Cliente",
    sourceKey: "PRIVATE_SOURCE_KEY",
    contentHash: "PRIVATE_CONTENT_HASH",
    original: { columns: [
      { coordinate: "C2", header: "Credencial", value: "SYNTHETIC_DOCUMENT_REFERENCE" },
      { coordinate: "B2", header: "Nombre", value: "Visible name" },
    ] },
    normalized: { columns: [
      { coordinate: "C2", header: "Credencial", value: "SYNTHETIC_DOCUMENT_REFERENCE" },
      { coordinate: "B2", header: "Nombre", value: "Visible name" },
    ] },
  };
  const unauthorized = JSON.stringify(redactStagedRecord(staged));
  for (const restricted of ["Credencial", "SYNTHETIC_DOCUMENT_REFERENCE", "PRIVATE_SOURCE_KEY", "PRIVATE_CONTENT_HASH"])
    assert.equal(unauthorized.includes(restricted), false, `${restricted} stays restricted without clinical.read`);
  assert.equal(unauthorized.includes("Visible name"), true);

  const authorized = JSON.stringify(redactStagedRecord(staged, { includeClinical: true }));
  assert.equal(authorized.includes("Credencial"), true);
  assert.equal(authorized.includes("SYNTHETIC_DOCUMENT_REFERENCE"), true);
});

test("atomic snapshot command accepts the source row count and owns the extended timeout", () => {
  const spec = commandSpecs.get("LegacySnapshotStaged");
  assert.ok(spec);
  assert.equal(spec.transactionTimeoutMs, 120_000);
  assert.equal(spec.internal, true);
  assert.deepEqual(
    [...commandSpecs.entries()].filter(([, command]) => command.transactionTimeoutMs !== undefined).map(([name]) => name),
    ["LegacySnapshotStaged"],
  );
  assert.equal(commandSpecs.has("LegacySnapshotStageStarted"), false);
  assert.equal(commandSpecs.has("LegacySnapshotChunkStaged"), false);
  assert.equal(commandSpecs.has("LegacySnapshotFinalized"), false);

  const record = {
    sourceTable: "C_Cliente",
    sourceKey: "client-example",
    sourceRow: 2,
    fileHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    importerVersion: "test-reader/1",
    original: { columns: [{ coordinate: "A2", header: "Id_Cliente", value: "client-example" }] },
    normalized: { columns: [{ coordinate: "A2", header: "Id_Cliente", value: "client-example" }] },
    treatment: "fact_candidate",
    exceptions: [],
  };
  const parsed = spec.schema.parse({
    sourceSystem: "test",
    filename: "fixture.xlsx",
    fileHash: "a".repeat(64),
    importerVersion: "test-reader/1",
    controls: {},
    coverage: [],
    records: Array.from({ length: 25_945 }, () => record),
  });
  assert.equal((parsed.records as unknown[]).length, 25_945);
});

test("internal snapshot parser rejects credential headers in either serialized representation", () => {
  const spec = commandSpecs.get("LegacySnapshotStaged");
  assert.ok(spec);
  const fileHash = "a".repeat(64);
  for (const layer of ["original", "normalized"] as const) {
    const record = {
      sourceTable: "T_Usuarios",
      sourceKey: "synthetic-user",
      sourceRow: 2,
      fileHash,
      contentHash: "b".repeat(64),
      importerVersion: legacyReaderVersion,
      original: { columns: [{ coordinate: "B2", header: layer === "original" ? "Password" : "Nombre", value: "SYNTHETIC_SENTINEL" }] },
      normalized: { columns: [{ coordinate: "B2", header: layer === "normalized" ? "Password" : "Nombre", value: "SYNTHETIC_SENTINEL" }] },
      treatment: "archive_only",
      exceptions: [],
    };
    assert.throws(() => spec.schema.parse({
      sourceSystem: "parser-security-test",
      filename: "synthetic.xlsx",
      fileHash,
      importerVersion: legacyReaderVersion,
      controls: {},
      coverage: [],
      records: [record],
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "IMPORT_CREDENTIAL_HEADER_REJECTED");
      return true;
    });
  }
});

test("internal snapshot parser accepts the restricted C_Cliente document-reference context", () => {
  const spec = commandSpecs.get("LegacySnapshotStaged");
  assert.ok(spec);
  const fileHash = "c".repeat(64);
  const reference = "SYNTHETIC_DOCUMENT_REFERENCE";
  const record = {
    sourceTable: "C_Cliente",
    sourceKey: "synthetic-client",
    sourceRow: 2,
    fileHash,
    contentHash: "d".repeat(64),
    importerVersion: legacyReaderVersion,
    original: { columns: [{ coordinate: "W2", header: "Credencial", value: reference }] },
    normalized: { columns: [{ coordinate: "W2", header: "Credencial", value: reference }] },
    treatment: "archive_only",
    exceptions: [],
  };
  const parsed = spec.schema.parse({
    sourceSystem: "parser-reference-test",
    filename: "synthetic.xlsx",
    fileHash,
    importerVersion: legacyReaderVersion,
    controls: {},
    coverage: [],
    records: [record],
  });
  assert.equal(JSON.stringify(parsed).includes(reference), true);
});

test("legacy member activation reuses the strict commercial field allowlists", () => {
  const spec = commandSpecs.get("LegacyMasterActivated");
  assert.ok(spec);
  const base = {
    snapshotId: "snapshot-fixture",
    sourceRecordId: "a".repeat(64),
    destinationType: "member",
    approvedData: {
      name: "Socio de prueba",
      email: "socio@example.test",
      phone: "0000000000",
      address: { street: "Calle de prueba" },
      preferences: { preferredChannel: "delivery" },
    },
    evidence: { ticket: "approval-fixture" },
  };
  assert.doesNotThrow(() => spec.schema.parse(base));
  for (const restricted of [
    { address: { allergies: ["SYNTHETIC_CLINICAL_SENTINEL"] }, preferences: {} },
    { address: {}, preferences: { allergies: ["SYNTHETIC_CLINICAL_SENTINEL"] } },
  ]) {
    assert.throws(() => spec.schema.parse({ ...base, approvedData: { ...base.approvedData, ...restricted } }),
      (error: unknown) => (error as { code?: string }).code === "COMMERCIAL_FIELDS_RESTRICTED");
  }
});

test("staged exception projection never exposes stored evidence", () => {
  const redactedException = JSON.stringify(redactStagedException({
    kind: "source_key_header_missing",
    resolution: { expectedField: "Diagnóstico", value: "PRIVATE_EXCEPTION_EVIDENCE", coordinate: "A2" },
  }));
  assert.equal(redactedException.includes("Diagnóstico"), false);
  assert.equal(redactedException.includes("PRIVATE_EXCEPTION_EVIDENCE"), false);
  assert.equal(redactedException.includes("A2"), false);
  assert.equal(redactedException.includes("[private exception evidence stored privately]"), true);
});
