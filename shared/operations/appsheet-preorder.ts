import { z } from "zod";

/**
 * A Bombo-native pending copy of the AppSheet Pre_Venta form. This contract
 * intentionally does not accept AppSheet row keys, capture claims, currency,
 * or client-calculated proposals.
 */
export const APPSHEET_PREORDER_DRAFT_SCHEMA_VERSION = 1 as const;

/** Semantic API names mapped to the exact source column names observed in the
 * sanitized Pre_Venta / Pre_Detalle_Fact specification. Values stay verbatim. */
export const APPSHEET_PREORDER_SOURCE_FIELDS = {
  header: {
    registeredAddress: "Pre_Domicilio_Registrado",
    declaredAddress: "Pre_Domicilio_Declarado",
    segment: "Segmento_Compra",
    grams: "Pre_Gramos",
    subtotal: "Subtotal_Venta",
    paymentForm: "fw_Forma_pago",
    saleTransfer: "Pre_Transferencia_Venta",
    transferSubtotal: "Subtotal_Venta_transferencia",
    deliveryZone: "Zona de Envío",
    deliveryDate: "Pre_Fecha_Entrega",
    motoClientTariff: "Tarifa_Moto_Cliente",
    motoTransfer: "Pre_Transferencia_Moto",
    motoServiceTotal: "Pre_Total_Servicio_Moto",
    motoAdminTariff: "Pre_Tarifa_Adm",
    total: "Total_Facturado",
    note: "Aclaración",
  },
  line: {
    article: "Pre_Artículo",
    variety: "Pre_Variedad",
    grams: "Pre_Cantidad_Gr",
    productType: "Tipo_Producto",
  },
  formula: {
    header: { saleDate: "Pre_Fechaventa" },
    line: {
      recordedAt: "Pre_Fecha",
      tariffScale: "Pre_Escala_Tarifaria",
      pricePerGram: "Pre_Precio_gramo_línea",
      total: "Pre_Valor_Total",
    },
  },
} as const;

// These are input/storage limits only. They do not assert AppSheet field
// limits, numeric validity, positivity, rounding, or business rules.
const rawText = z.string().max(512).nullable().optional();
const rawNote = z.string().max(4096).nullable().optional();
const rawFormulaText = z.string().max(256).nullable().optional();

const headerInputSchema = z.strictObject({
  registeredAddress: rawText,
  declaredAddress: rawText,
  segment: rawText,
  grams: rawText,
  subtotal: rawText,
  paymentForm: rawText,
  saleTransfer: rawText,
  transferSubtotal: rawText,
  deliveryZone: rawText,
  deliveryDate: rawText,
  motoClientTariff: rawText,
  motoTransfer: rawText,
  motoServiceTotal: rawText,
  motoAdminTariff: rawText,
  total: rawText,
  note: rawNote,
});

const headerFormulaResultsInputSchema = z.strictObject({
  saleDate: rawFormulaText,
});

const lineFormulaResultsInputSchema = z.strictObject({
  recordedAt: rawFormulaText,
  tariffScale: rawFormulaText,
  pricePerGram: rawFormulaText,
  total: rawFormulaText,
});

const lineInputFields = {
  article: rawText,
  variety: rawText,
  grams: rawText,
  productType: rawText,
};

const lineIdPattern = /^bombo-preventa-line:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const appSheetPreorderLineIdSchema = z.string().regex(lineIdPattern);
const draftIdPattern = /^bombo-preventa:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const appSheetPreorderDraftIdSchema = z.string().regex(draftIdPattern);

const saveLineSchema = z.strictObject({ ...lineInputFields, formulaResults: lineFormulaResultsInputSchema.optional() });
const updateLineSchema = z.strictObject({ lineId: appSheetPreorderLineIdSchema.optional(), ...lineInputFields });

export const sourcePreorderSavedSchema = z.strictObject({
  memberId: z.string().min(1).max(100),
  header: headerInputSchema,
  formulaResults: headerFormulaResultsInputSchema.optional(),
  lines: z.array(saveLineSchema).max(200),
});

export const sourcePreorderUpdatedSchema = z.strictObject({
  // Member identity is deliberately immutable on edit.
  header: headerInputSchema,
  lines: z.array(updateLineSchema).max(200),
});

const rawFieldStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent") }),
  z.strictObject({ state: z.literal("null") }),
  z.strictObject({ state: z.literal("value"), raw: z.string().max(4096) }),
]);

const headerRawValuesSchema = z.strictObject({
  registeredAddress: rawFieldStateSchema,
  declaredAddress: rawFieldStateSchema,
  segment: rawFieldStateSchema,
  grams: rawFieldStateSchema,
  subtotal: rawFieldStateSchema,
  paymentForm: rawFieldStateSchema,
  saleTransfer: rawFieldStateSchema,
  transferSubtotal: rawFieldStateSchema,
  deliveryZone: rawFieldStateSchema,
  deliveryDate: rawFieldStateSchema,
  motoClientTariff: rawFieldStateSchema,
  motoTransfer: rawFieldStateSchema,
  motoServiceTotal: rawFieldStateSchema,
  motoAdminTariff: rawFieldStateSchema,
  total: rawFieldStateSchema,
  note: rawFieldStateSchema,
});

const lineRawValuesSchema = z.strictObject({
  article: rawFieldStateSchema,
  variety: rawFieldStateSchema,
  grams: rawFieldStateSchema,
  productType: rawFieldStateSchema,
});

const formulaResultsSchema = (shape: Record<string, z.ZodTypeAny>) => z.strictObject({
  verification: z.literal("unverified"),
  values: z.strictObject(shape),
});

const notEvaluatedProposalSchema = (shape: Record<string, z.ZodTypeAny>) => z.strictObject({
  status: z.literal("not_evaluated"),
  values: z.strictObject(shape),
});

const headerFormulaShape = { saleDate: rawFieldStateSchema };
const lineFormulaShape = {
  recordedAt: rawFieldStateSchema,
  tariffScale: rawFieldStateSchema,
  pricePerGram: rawFieldStateSchema,
  total: rawFieldStateSchema,
};
const headerProposalShape = { saleDate: z.null() };
const lineProposalShape = { recordedAt: z.null(), tariffScale: z.null(), pricePerGram: z.null(), total: z.null() };

const headerSnapshotSchema = z.strictObject({
  rawValues: headerRawValuesSchema,
  formulaResults: formulaResultsSchema(headerFormulaShape),
  calculationProposal: notEvaluatedProposalSchema(headerProposalShape),
});

const lineSnapshotSchema = z.strictObject({
  lineId: appSheetPreorderLineIdSchema,
  rawValues: lineRawValuesSchema,
  formulaResults: formulaResultsSchema(lineFormulaShape),
  calculationProposal: notEvaluatedProposalSchema(lineProposalShape),
});

export const appSheetPreorderDraftPayloadSchema = z.strictObject({
  schemaVersion: z.literal(APPSHEET_PREORDER_DRAFT_SCHEMA_VERSION),
  memberId: z.string().min(1).max(100),
  origin: z.literal("bombo_native"),
  appsheetCapture: z.null(),
  appsheetKeys: z.null(),
  header: headerSnapshotSchema,
  lines: z.array(lineSnapshotSchema).max(200),
});

export const appSheetPreorderDraftDtoSchema = z.strictObject({
  id: appSheetPreorderDraftIdSchema,
  memberId: z.string().min(1).max(100),
  version: z.number().int().min(1),
  schemaVersion: z.literal(APPSHEET_PREORDER_DRAFT_SCHEMA_VERSION),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: appSheetPreorderDraftPayloadSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const appSheetPreorderDraftCollectionSchema = z.strictObject({
  items: z.array(appSheetPreorderDraftDtoSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).nullable(),
});

export const appSheetPreorderDraftDetailSchema = z.strictObject({ item: appSheetPreorderDraftDtoSchema });

export type SourcePreorderSavedInput = z.infer<typeof sourcePreorderSavedSchema>;
export type SourcePreorderUpdatedInput = z.infer<typeof sourcePreorderUpdatedSchema>;
export type AppSheetPreorderDraftPayload = z.infer<typeof appSheetPreorderDraftPayloadSchema>;
export type AppSheetPreorderDraftDto = z.infer<typeof appSheetPreorderDraftDtoSchema>;
export type AppSheetPreorderDraftCollection = z.infer<typeof appSheetPreorderDraftCollectionSchema>;

function fieldState(values: Record<string, unknown>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) return { state: "absent" as const };
  const value = values[key];
  if (value === null) return { state: "null" as const };
  if (typeof value === "string") return { state: "value" as const, raw: value };
  throw new TypeError("appsheet_preorder_raw_field_invalid");
}

function rawValues(values: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, fieldState(values, key)]));
}

function formulaValues(values: Record<string, unknown> | undefined, keys: readonly string[]) {
  const supplied = values ?? {};
  return Object.fromEntries(keys.map(key => [key, fieldState(supplied, key)]));
}

function emptyLineFormulaResults() {
  return {
    verification: "unverified" as const,
    values: formulaValues(undefined, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.formula.line)),
  };
}

function emptyLineProposal() {
  return { status: "not_evaluated" as const, values: { recordedAt: null, tariffScale: null, pricePerGram: null, total: null } };
}

export function buildSourcePreorderDraftPayload(
  inputValue: unknown,
  createLineId: () => string,
): AppSheetPreorderDraftPayload {
  const input = sourcePreorderSavedSchema.parse(inputValue);
  const headerFormulaResults = input.formulaResults as Record<string, unknown> | undefined;
  const payload = {
    schemaVersion: APPSHEET_PREORDER_DRAFT_SCHEMA_VERSION,
    memberId: input.memberId,
    origin: "bombo_native" as const,
    appsheetCapture: null,
    appsheetKeys: null,
    header: {
      rawValues: rawValues(input.header as Record<string, unknown>, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.header)),
      formulaResults: {
        verification: "unverified" as const,
        values: formulaValues(headerFormulaResults, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.formula.header)),
      },
      calculationProposal: { status: "not_evaluated" as const, values: { saleDate: null } },
    },
    lines: input.lines.map(line => {
      const lineFormulaResults = line.formulaResults as Record<string, unknown> | undefined;
      return {
        lineId: createLineId(),
        rawValues: rawValues(line as Record<string, unknown>, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.line)),
        formulaResults: {
          verification: "unverified" as const,
          values: formulaValues(lineFormulaResults, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.formula.line)),
        },
        calculationProposal: emptyLineProposal(),
      };
    }),
  };
  return appSheetPreorderDraftPayloadSchema.parse(payload);
}

export function updateSourcePreorderDraftPayload(
  inputValue: unknown,
  existing: AppSheetPreorderDraftPayload,
  createLineId: () => string,
): AppSheetPreorderDraftPayload {
  const input = sourcePreorderUpdatedSchema.parse(inputValue);
  const previousLines = new Map(existing.lines.map(line => [line.lineId, line]));
  const seen = new Set<string>();
  const lines = input.lines.map(line => {
    const lineId = line.lineId ?? createLineId();
    if (seen.has(lineId)) throw new TypeError("appsheet_preorder_duplicate_line_id");
    seen.add(lineId);
    const previous = previousLines.get(lineId);
    if (line.lineId && !previous) throw new TypeError("appsheet_preorder_unknown_line_id");
    return {
      lineId,
      rawValues: rawValues(line as Record<string, unknown>, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.line)),
      formulaResults: previous?.formulaResults ?? emptyLineFormulaResults(),
      calculationProposal: previous?.calculationProposal ?? emptyLineProposal(),
    };
  });
  const payload = {
    ...existing,
    header: {
      ...existing.header,
      rawValues: rawValues(input.header as Record<string, unknown>, Object.keys(APPSHEET_PREORDER_SOURCE_FIELDS.header)),
    },
    lines,
  };
  return appSheetPreorderDraftPayloadSchema.parse(payload);
}

