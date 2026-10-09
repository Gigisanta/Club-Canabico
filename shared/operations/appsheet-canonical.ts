import { z } from "zod";

export const APPSHEET_CANONICAL_SOURCE_SYSTEM = "appsheet-live-verified" as const;
export const APPSHEET_CANONICAL_IMPORTER_VERSION = "bombo-appsheet-canonical/1.0.0" as const;
export const APPSHEET_CANONICAL_MAPPING_ID = "appsheet-live-masters-v1" as const;
export const APPSHEET_CANONICAL_SCHEMA_VERSION = "appsheet-capture-manifest/v1" as const;
export type AppSheetProjectionStabilityMode = "stable" | "staged-delta";

export const APPSHEET_MASTER_TABLES = {
  members: "C_Cliente",
  catalogue: "D_Catalogo_Mercaderia",
} as const;

/**
 * `CatalogoID` is the AppSheet key. `Codigo_Detalle` is a business code and
 * may repeat; it is never substituted for the source identity.
 */
export const APPSHEET_MASTER_KEY_FIELDS = {
  C_Cliente: "Id_Cliente",
  D_Catalogo_Mercaderia: "CatalogoID",
} as const;

export type AppSheetMasterTable = keyof typeof APPSHEET_MASTER_KEY_FIELDS;
export type AppSheetEffectiveScalar = string | number | boolean;
export type AppSheetEffectiveValue =
  | { kind: "missing" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; value: { type: string; message: string } };

type CellDataLike = {
  userEnteredValue?: { formulaValue?: unknown };
  effectiveValue?: {
    stringValue?: unknown;
    numberValue?: unknown;
    boolValue?: unknown;
    errorValue?: { type?: unknown; message?: unknown };
  };
};

/** Read the cached/effective Sheets value without evaluating formulas or coercing types. */
export function appSheetCellEffectiveValue(cell: unknown): AppSheetEffectiveValue {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return { kind: "missing" };
  const effective = (cell as CellDataLike).effectiveValue;
  if (!effective || typeof effective !== "object" || Array.isArray(effective)) return { kind: "missing" };

  if (effective.errorValue && typeof effective.errorValue === "object") {
    const error = effective.errorValue;
    return {
      kind: "error",
      value: {
        type: typeof error.type === "string" ? error.type : "UNKNOWN_ERROR",
        message: typeof error.message === "string" ? error.message : "",
      },
    };
  }

  const candidates: Array<{ kind: "string" | "number" | "boolean"; value: unknown }> = [];
  if (Object.hasOwn(effective, "stringValue")) candidates.push({ kind: "string", value: effective.stringValue });
  if (Object.hasOwn(effective, "numberValue")) candidates.push({ kind: "number", value: effective.numberValue });
  if (Object.hasOwn(effective, "boolValue")) candidates.push({ kind: "boolean", value: effective.boolValue });
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "error", value: { type: "INVALID_EFFECTIVE_VALUE", message: "" } };

  const candidate = candidates[0]!;
  if (candidate.kind === "string" && typeof candidate.value === "string") return { kind: "string", value: candidate.value };
  if (candidate.kind === "number" && typeof candidate.value === "number" && Number.isFinite(candidate.value))
    return { kind: "number", value: candidate.value };
  if (candidate.kind === "boolean" && typeof candidate.value === "boolean") return { kind: "boolean", value: candidate.value };
  return { kind: "error", value: { type: "INVALID_EFFECTIVE_VALUE", message: "" } };
}

/** Formula expressions are evidence only; callers must use effective values for projection. */
export function appSheetCellFormula(cell: unknown): string | null {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return null;
  const entered = (cell as CellDataLike).userEnteredValue;
  return entered && typeof entered === "object" && typeof entered.formulaValue === "string"
    ? entered.formulaValue
    : null;
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonnegative = z.number().int().nonnegative();

/** Immutable capture metadata shared by the master and historical projectors. */
export const preparedAppSheetCaptureManifestSchema = z.strictObject({
  captureId: z.string().regex(/^appsreal-[a-f0-9]{16}$/),
  sourceSystem: z.literal(APPSHEET_CANONICAL_SOURCE_SYSTEM),
  sourceId: z.string().min(1).max(300),
  spreadsheetId: z.string().min(1).max(256),
  metadataHash: hashSchema,
  headersHash: hashSchema,
  manifestHash: hashSchema,
  dataHash: hashSchema,
  definitionHash: hashSchema.nullable(),
  stability: z.record(z.string(), z.unknown()),
  firstReadAt: z.iso.datetime({ offset: true }),
  verificationStartedAt: z.iso.datetime({ offset: true }),
  verificationCompletedAt: z.iso.datetime({ offset: true }),
  cutoffAt: z.iso.datetime({ offset: true }),
  dataCoverage: z.record(z.string(), z.unknown()),
  pageManifest: z.array(z.record(z.string(), z.unknown())).max(2_000),
  definitionCoverage: z.record(z.string(), z.unknown()).nullable(),
  dataSheetCount: nonnegative,
  dataPageCount: nonnegative,
  dataRecordCount: nonnegative,
  dataFormulaCount: nonnegative,
  dataUnresolvedFormulaCount: nonnegative,
  definitionTableCount: nonnegative.nullable(),
  definitionColumnCount: nonnegative.nullable(),
  definitionSliceCount: nonnegative.nullable(),
  definitionViewCount: nonnegative.nullable(),
  definitionActionCount: nonnegative.nullable(),
  definitionBotCount: nonnegative.nullable(),
  definitionWorkflowRuleCount: nonnegative.nullable(),
  definitionFormatRuleCount: nonnegative.nullable(),
});

export type PreparedAppSheetCaptureManifest = z.infer<typeof preparedAppSheetCaptureManifestSchema>;

/**
 * Source evidence consumed by the canonical projection. Preliminary captures
 * are intentionally projection-only: they cannot be inserted as a verified
 * AppSheetCaptureManifest because they have no cutoffAt.
 */
export type AppSheetProjectionCaptureManifest = Omit<PreparedAppSheetCaptureManifest, "firstReadAt" | "verificationStartedAt" | "verificationCompletedAt" | "cutoffAt"> & {
  firstReadAt: string | null;
  verificationStartedAt: string | null;
  verificationCompletedAt: string | null;
  cutoffAt: string | null;
  timestampGaps: string[];
  stabilityMode: AppSheetProjectionStabilityMode;
};

const projectionCaptureSchema = z.object({
  schemaVersion: z.literal(APPSHEET_CANONICAL_SCHEMA_VERSION),
  captureId: z.string().regex(/^appsreal-[a-f0-9]{16}$/),
  sourceSystem: z.literal(APPSHEET_CANONICAL_SOURCE_SYSTEM),
  sourceId: z.string().min(1).max(300),
  spreadsheetId: z.string().min(1).max(256),
  metadataHash: hashSchema,
  headersHash: hashSchema,
  manifestHash: hashSchema,
  dataHash: hashSchema,
  definitionHash: hashSchema.nullable(),
  stability: z.record(z.string(), z.unknown()),
  firstReadAt: z.iso.datetime({ offset: true }).nullable(),
  verificationStartedAt: z.iso.datetime({ offset: true }).nullable(),
  verificationCompletedAt: z.iso.datetime({ offset: true }).nullable(),
  cutoffAt: z.iso.datetime({ offset: true }).nullable(),
  coverage: z.record(z.string(), z.unknown()),
  pages: z.array(z.record(z.string(), z.unknown())).max(2_000),
  dataSheetCount: nonnegative,
  dataPageCount: nonnegative,
  dataRecordCount: nonnegative,
  dataFormulaCount: nonnegative,
  dataUnresolvedFormulaCount: nonnegative,
  definitionCoverage: z.record(z.string(), z.unknown()).nullable().optional(),
  definitionTableCount: nonnegative.nullable(),
  definitionColumnCount: nonnegative.nullable(),
  definitionSliceCount: nonnegative.nullable(),
  definitionViewCount: nonnegative.nullable(),
  definitionActionCount: nonnegative.nullable(),
  definitionBotCount: nonnegative.nullable(),
  definitionWorkflowRuleCount: nonnegative.nullable(),
  definitionFormatRuleCount: nonnegative.nullable(),
  timestampGaps: z.array(z.string().max(2_000)).max(100),
}).strict();

/**
 * Parse stable or explicitly authorized preliminary-delta evidence. The
 * capture loader remains responsible for validating the source files, hashes,
 * pass-two/pass-three evidence, and complete global page manifest. Global
 * deltas outside the selected master pages remain explicit blocking evidence.
 */
export function prepareAppSheetProjectionCaptureManifest(
  value: unknown,
  options: { mode: "stable" | "preliminary-delta"; allowStagedDelta?: boolean },
): AppSheetProjectionCaptureManifest {
  const normalized = normalizeSourceManifest(value);
  if (options.mode === "stable") {
    const stable = prepareAppSheetCaptureManifest(normalized);
    return { ...stable, timestampGaps: normalized.timestampGaps, stabilityMode: "stable" };
  }
  if (options.mode !== "preliminary-delta" || options.allowStagedDelta !== true)
    throw new Error("La derivación preliminar requiere autorización explícita para staged-delta.");

  const manifest = projectionCaptureSchema.parse(normalized);
  const stability = manifest.stability;
  const validFirstRead = typeof manifest.firstReadAt === "string" && Number.isFinite(Date.parse(manifest.firstReadAt));
  const validVerificationWindow = manifest.verificationStartedAt === null || manifest.verificationCompletedAt === null ||
    Date.parse(manifest.verificationStartedAt) <= Date.parse(manifest.verificationCompletedAt);
  const validVerificationOrder = !manifest.firstReadAt || !manifest.verificationStartedAt ||
    Date.parse(manifest.verificationStartedAt) >= Date.parse(manifest.firstReadAt);
  const stablePages = manifest.pages.filter((page) => page.stable === true && page.pageHash === page.verifiedPageHash);
  const changedPages = manifest.pages.filter((page) => page.stable === false && page.pageHash !== page.verifiedPageHash);
  if (manifest.cutoffAt !== null || manifest.sourceId !== manifest.spreadsheetId ||
      manifest.captureId !== `appsreal-${manifest.manifestHash.slice(0, 16)}` || stability.stable !== false ||
      stability.metadataStable !== true || stability.headersStable !== true || stability.pageHashesStable !== false ||
      stability.scanComplete !== true || !validFirstRead || !validVerificationWindow || !validVerificationOrder || changedPages.length === 0 ||
      stablePages.length + changedPages.length !== manifest.pages.length ||
      stability.firstPassPages !== manifest.pages.length || stability.verifiedPages !== manifest.pages.length ||
      stability.matchedPages !== stablePages.length || stability.changedPages !== changedPages.length || stability.failedPages !== 0 ||
      manifest.pages.some((page) => page.stable !== (page.pageHash === page.verifiedPageHash))) {
    throw new Error("La evidencia delta no está completa para una derivación preliminar.");
  }

  const { schemaVersion: _schemaVersion, coverage, pages, definitionCoverage, timestampGaps, ...fields } = manifest;
  return preparedAppSheetProjectionCaptureSchema.parse({
    ...fields,
    cutoffAt: null,
    dataCoverage: coverage,
    pageManifest: pages,
    definitionCoverage: definitionCoverage ?? null,
    timestampGaps,
    stabilityMode: "staged-delta",
  });
}

function normalizeSourceManifest(value: unknown) {
  const source = z.object({
    schemaVersion: z.literal(APPSHEET_CANONICAL_SCHEMA_VERSION),
    captureId: z.string(), sourceSystem: z.string(), sourceId: z.string(), spreadsheetId: z.string(),
    metadataHash: z.string(), headersHash: z.string(), manifestHash: z.string(), dataHash: z.string(),
    definitionHash: z.string().nullable().optional(), stability: z.record(z.string(), z.unknown()),
    timestamps: z.object({
      firstReadAt: z.iso.datetime({ offset: true }).nullable().optional(),
      verificationStartedAt: z.iso.datetime({ offset: true }).nullable().optional(),
      verificationCompletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
      cutoffAt: z.iso.datetime({ offset: true }).nullable().optional(),
    }).passthrough().optional(),
    firstReadAt: z.iso.datetime({ offset: true }).nullable().optional(),
    verificationStartedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    verificationCompletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    cutoffAt: z.iso.datetime({ offset: true }).nullable().optional(),
    timestampGaps: z.array(z.string().max(2_000)).max(100).optional(),
    coverage: z.record(z.string(), z.unknown()),
    pages: z.array(z.record(z.string(), z.unknown())).max(2_000),
    dataSheetCount: nonnegative.optional(), dataPageCount: nonnegative.optional(), dataRecordCount: nonnegative.optional(),
    dataFormulaCount: nonnegative.optional(), dataUnresolvedFormulaCount: nonnegative.optional(),
    definitionCoverage: z.record(z.string(), z.unknown()).nullable().optional(),
    definitionTableCount: nonnegative.nullable().optional(), definitionColumnCount: nonnegative.nullable().optional(),
    definitionSliceCount: nonnegative.nullable().optional(), definitionViewCount: nonnegative.nullable().optional(),
    definitionActionCount: nonnegative.nullable().optional(), definitionBotCount: nonnegative.nullable().optional(),
    definitionWorkflowRuleCount: nonnegative.nullable().optional(), definitionFormatRuleCount: nonnegative.nullable().optional(),
  }).passthrough().parse(value);
  const chooseTimestamp = (flat: string | null | undefined, nested: string | null | undefined): string | null => {
    if (flat !== undefined && nested !== undefined && flat !== nested) throw new Error("capture_timestamp_mismatch");
    return flat ?? nested ?? null;
  };
  const count = (supplied: number | undefined, coverageName: string, fallback: number): number => {
    const fromCoverage = source.coverage[coverageName];
    const normalizedCoverage = typeof fromCoverage === "number" ? fromCoverage : fallback;
    if (supplied !== undefined && supplied !== normalizedCoverage) throw new Error("capture_coverage_count_mismatch");
    return supplied ?? normalizedCoverage;
  };
  const pageSheetIds = new Set(source.pages.map((page) => page.sheetId).filter((sheetId): sheetId is number => typeof sheetId === "number"));
  const pageCount = source.pages.length;
  const sumPageCount = (key: string): number => source.pages.reduce((sum, page) => {
    const value = (page.counts as Record<string, unknown> | undefined)?.[key];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  const pageRowsWithValues = sumPageCount("rowsWithValues");
  const coverageRowsWithValues = source.coverage.rowsWithValues;
  if (typeof coverageRowsWithValues === "number" && coverageRowsWithValues !== pageRowsWithValues)
    throw new Error("capture_coverage_count_mismatch");
  const capturedRowsWithValues = typeof coverageRowsWithValues === "number" ? coverageRowsWithValues : pageRowsWithValues;
  const dataRecordCount = source.dataRecordCount ?? (typeof source.coverage.dataRecordCount === "number" ? source.coverage.dataRecordCount : undefined);
  // `coverage.rowsWithValues` counts populated spreadsheet rows, including
  // any populated headers. The loader derives dataRecordCount only after
  // checking which header rows actually contain captured values. Keep the
  // measures distinct; sheet count is not a safe proxy for populated headers.
  if (dataRecordCount === undefined || dataRecordCount > capturedRowsWithValues)
    throw new Error("capture_data_record_count_missing_or_invalid");
  return {
    schemaVersion: source.schemaVersion,
    captureId: source.captureId,
    sourceSystem: source.sourceSystem,
    sourceId: source.sourceId,
    spreadsheetId: source.spreadsheetId,
    metadataHash: source.metadataHash,
    headersHash: source.headersHash,
    manifestHash: source.manifestHash,
    dataHash: source.dataHash,
    definitionHash: source.definitionHash ?? null,
    stability: source.stability,
    firstReadAt: chooseTimestamp(source.firstReadAt, source.timestamps?.firstReadAt),
    verificationStartedAt: chooseTimestamp(source.verificationStartedAt, source.timestamps?.verificationStartedAt),
    verificationCompletedAt: chooseTimestamp(source.verificationCompletedAt, source.timestamps?.verificationCompletedAt),
    cutoffAt: chooseTimestamp(source.cutoffAt, source.timestamps?.cutoffAt),
    timestampGaps: source.timestampGaps ?? [],
    coverage: source.coverage,
    pages: source.pages,
    dataSheetCount: count(source.dataSheetCount, "bodySheetsCaptured", pageSheetIds.size),
    dataPageCount: count(source.dataPageCount, "totalPages", pageCount),
    dataRecordCount,
    dataFormulaCount: count(source.dataFormulaCount, "formulaCellCount", sumPageCount("formulaCellCount")),
    dataUnresolvedFormulaCount: count(source.dataUnresolvedFormulaCount, "unresolvedFormulaCount", sumPageCount("unresolvedFormulaCount")),
    definitionCoverage: source.definitionCoverage ?? null,
    definitionTableCount: source.definitionTableCount ?? null,
    definitionColumnCount: source.definitionColumnCount ?? null,
    definitionSliceCount: source.definitionSliceCount ?? null,
    definitionViewCount: source.definitionViewCount ?? null,
    definitionActionCount: source.definitionActionCount ?? null,
    definitionBotCount: source.definitionBotCount ?? null,
    definitionWorkflowRuleCount: source.definitionWorkflowRuleCount ?? null,
    definitionFormatRuleCount: source.definitionFormatRuleCount ?? null,
  };
}

const preparedAppSheetProjectionCaptureSchema = preparedAppSheetCaptureManifestSchema
  .omit({ firstReadAt: true, verificationStartedAt: true, verificationCompletedAt: true, cutoffAt: true })
  .extend({
    firstReadAt: z.iso.datetime({ offset: true }).nullable(),
    verificationStartedAt: z.iso.datetime({ offset: true }).nullable(),
    verificationCompletedAt: z.iso.datetime({ offset: true }).nullable(),
    cutoffAt: z.iso.datetime({ offset: true }).nullable(),
    timestampGaps: z.array(z.string().max(2_000)).max(100),
    stabilityMode: z.enum(["stable", "staged-delta"]),
  });

/**
 * Convert a verified source manifest into the exact immutable Prisma payload.
 * Null cutoffs are rejected because the database contract only admits stable
 * captures; callers must use the capture loader that verifies page hashes.
 */
export function prepareAppSheetCaptureManifest(value: unknown): PreparedAppSheetCaptureManifest {
  const manifest = z.object({
    schemaVersion: z.literal(APPSHEET_CANONICAL_SCHEMA_VERSION),
    captureId: z.string(), sourceSystem: z.string(), sourceId: z.string(), spreadsheetId: z.string(),
    metadataHash: z.string(), headersHash: z.string(), manifestHash: z.string(), dataHash: z.string(),
    definitionHash: z.string().nullable(), stability: z.record(z.string(), z.unknown()),
    firstReadAt: z.iso.datetime({ offset: true }), verificationStartedAt: z.iso.datetime({ offset: true }),
    verificationCompletedAt: z.iso.datetime({ offset: true }), cutoffAt: z.iso.datetime({ offset: true }).nullable(),
    coverage: z.record(z.string(), z.unknown()), pages: z.array(z.record(z.string(), z.unknown())),
    dataSheetCount: nonnegative, dataPageCount: nonnegative, dataRecordCount: nonnegative,
    dataFormulaCount: nonnegative, dataUnresolvedFormulaCount: nonnegative,
    definitionCoverage: z.record(z.string(), z.unknown()).nullable().optional(),
    definitionTableCount: nonnegative.nullable(), definitionColumnCount: nonnegative.nullable(),
    definitionSliceCount: nonnegative.nullable(), definitionViewCount: nonnegative.nullable(),
    definitionActionCount: nonnegative.nullable(), definitionBotCount: nonnegative.nullable(),
    definitionWorkflowRuleCount: nonnegative.nullable(), definitionFormatRuleCount: nonnegative.nullable(),
  }).passthrough().parse(value);

  if (!manifest.cutoffAt) throw new Error("La captura AppSheet no tiene un corte estable verificado.");
  const populatedRows = manifest.pages.reduce((sum, page) => {
    const counts = page.counts as Record<string, unknown> | undefined;
    return sum + (typeof counts?.rowsWithValues === "number" ? counts.rowsWithValues : 0);
  }, 0);
  const coverageRows = manifest.coverage.rowsWithValues;
  const coverageRecords = manifest.coverage.dataRecordCount;
  if (manifest.dataPageCount !== manifest.pages.length ||
      (typeof manifest.coverage.totalPages === "number" && manifest.coverage.totalPages !== manifest.dataPageCount) ||
      (typeof coverageRows === "number" && coverageRows !== populatedRows) ||
      manifest.dataRecordCount > populatedRows ||
      (typeof coverageRecords === "number" && coverageRecords !== manifest.dataRecordCount)) {
    throw new Error("La captura AppSheet no concilia filas pobladas, registros y páginas.");
  }
  const prepared = {
    captureId: manifest.captureId,
    sourceSystem: manifest.sourceSystem,
    sourceId: manifest.sourceId,
    spreadsheetId: manifest.spreadsheetId,
    metadataHash: manifest.metadataHash,
    headersHash: manifest.headersHash,
    manifestHash: manifest.manifestHash,
    dataHash: manifest.dataHash,
    definitionHash: manifest.definitionHash,
    stability: manifest.stability,
    firstReadAt: manifest.firstReadAt,
    verificationStartedAt: manifest.verificationStartedAt,
    verificationCompletedAt: manifest.verificationCompletedAt,
    cutoffAt: manifest.cutoffAt,
    dataCoverage: manifest.coverage,
    pageManifest: manifest.pages,
    definitionCoverage: manifest.definitionCoverage ?? null,
    dataSheetCount: manifest.dataSheetCount,
    dataPageCount: manifest.dataPageCount,
    dataRecordCount: manifest.dataRecordCount,
    dataFormulaCount: manifest.dataFormulaCount,
    dataUnresolvedFormulaCount: manifest.dataUnresolvedFormulaCount,
    definitionTableCount: manifest.definitionTableCount,
    definitionColumnCount: manifest.definitionColumnCount,
    definitionSliceCount: manifest.definitionSliceCount,
    definitionViewCount: manifest.definitionViewCount,
    definitionActionCount: manifest.definitionActionCount,
    definitionBotCount: manifest.definitionBotCount,
    definitionWorkflowRuleCount: manifest.definitionWorkflowRuleCount,
    definitionFormatRuleCount: manifest.definitionFormatRuleCount,
  };
  if (prepared.sourceId !== prepared.spreadsheetId ||
      prepared.captureId !== `appsreal-${prepared.manifestHash.slice(0, 16)}` ||
      prepared.stability.stable !== true ||
      Date.parse(prepared.verificationStartedAt) < Date.parse(prepared.firstReadAt) ||
      Date.parse(prepared.verificationCompletedAt) < Date.parse(prepared.verificationStartedAt) ||
      Date.parse(prepared.cutoffAt) < Date.parse(prepared.verificationCompletedAt)) {
    throw new Error("La captura AppSheet no supera la validación de identidad y estabilidad.");
  }
  return preparedAppSheetCaptureManifestSchema.parse(prepared);
}
