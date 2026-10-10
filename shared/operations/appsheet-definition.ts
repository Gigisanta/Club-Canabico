import { z } from "zod";

export const APPSHEET_DEFINITION_SCHEMA_VERSION = 1 as const;
export const APPSHEET_DEFINITION_PARSER_VERSION = "bombo-appsheet-definition/1.2.0";

export const APPSHEET_DEFINITION_CATEGORIES = [
  "tables",
  "columns",
  "slices",
  "views",
  "formatRules",
  "actions",
  "bots",
  "workflowRules",
  "security",
  "settings",
  "other",
] as const;
export type AppSheetDefinitionCategory = (typeof APPSHEET_DEFINITION_CATEGORIES)[number];

export const APPSHEET_DEFINITION_COUNT_KEYS = [
  "tables",
  "columns",
  "slices",
  "views",
  "formatRules",
  "actions",
  "bots",
  "workflowRules",
] as const;
export type AppSheetDefinitionCountKey = (typeof APPSHEET_DEFINITION_COUNT_KEYS)[number];

export const APPSHEET_DEFINITION_FIELD_STATES = ["observed", "redacted", "ambiguous", "missing"] as const;
export type AppSheetDefinitionFieldState = (typeof APPSHEET_DEFINITION_FIELD_STATES)[number];

export interface AppSheetDefinitionPosition {
  offset: number;
  line: number;
  column: number;
}

export interface AppSheetDefinitionEvidence {
  id: string;
  kind: "heading" | "table" | "row" | "definition" | "paragraph" | "list-item";
  sectionPath: string[];
  position: AppSheetDefinitionPosition;
  label: string | null;
  excerpt: string | null;
}

export interface AppSheetDefinitionField {
  label: string;
  semanticKey: string | null;
  value: string | null;
  state: AppSheetDefinitionFieldState;
  evidenceId: string;
}

export interface AppSheetDefinitionRecord {
  category: AppSheetDefinitionCategory;
  name: string | null;
  fields: AppSheetDefinitionField[];
  evidenceId: string;
  children: AppSheetDefinitionRecord[];
}

export interface AppSheetDefinitionSection {
  category: AppSheetDefinitionCategory;
  title: string;
  sectionPath: string[];
  evidenceId: string;
  records: AppSheetDefinitionRecord[];
}

export type AppSheetDefinitionCounts = Partial<Record<AppSheetDefinitionCountKey, number>>;

export interface AppSheetDefinitionIdentity {
  method: "app-document-header" | "referenced-process-state-namespace" | "ambiguous" | "unverified";
  evidenceId: string | null;
  evidenceIds: string[];
  sourcePathReferenceCount: number;
  candidateCount: number;
}

export interface AppSheetDefinitionCoverage {
  category: AppSheetDefinitionCategory;
  state: "observed" | "matched_declared_count" | "count_mismatch" | "not_declared" | "unsupported" | "redacted";
  declaredCount: number | null;
  observedCount: number;
  missingCount: number | null;
  redactedFieldCount: number;
  ambiguousFieldCount: number;
  evidenceCount: number;
  note: string;
}

export interface AppSheetDefinitionInventory {
  schemaVersion: typeof APPSHEET_DEFINITION_SCHEMA_VERSION;
  parserVersion: string;
  source: {
    sha256: string;
    byteLength: number;
    encoding: "utf-8";
  };
  app: {
    id: string | null;
    name: string | null;
    version: string | null;
    deploymentState: string | null;
    generatedAt: string | null;
    identity?: AppSheetDefinitionIdentity;
  };
  declaredCounts: AppSheetDefinitionCounts;
  observedCounts: AppSheetDefinitionCounts;
  descriptorSha256: string;
  coverage: AppSheetDefinitionCoverage[];
  sections: AppSheetDefinitionSection[];
  evidence: AppSheetDefinitionEvidence[];
  redactedFieldCount: number;
  warnings: string[];
}

const positionSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});

export const appSheetDefinitionEvidenceSchema = z.strictObject({
  id: z.string().min(1).max(80),
  kind: z.enum(["heading", "table", "row", "definition", "paragraph", "list-item"]),
  sectionPath: z.array(z.string().max(1_000)).max(32),
  position: positionSchema,
  label: z.string().max(4_000).nullable(),
  excerpt: z.string().max(4_000).nullable(),
});

export const appSheetDefinitionFieldSchema = z.strictObject({
  label: z.string().min(1).max(4_000),
  semanticKey: z.string().max(120).nullable(),
  value: z.string().max(64_000).nullable(),
  state: z.enum(APPSHEET_DEFINITION_FIELD_STATES),
  evidenceId: z.string().min(1).max(80),
});

const appSheetDefinitionRecordSchema: z.ZodType<AppSheetDefinitionRecord> = z.lazy(() => z.strictObject({
  category: z.enum(APPSHEET_DEFINITION_CATEGORIES),
  name: z.string().max(4_000).nullable(),
  fields: z.array(appSheetDefinitionFieldSchema).max(512),
  evidenceId: z.string().min(1).max(80),
  children: z.array(appSheetDefinitionRecordSchema).max(100_000),
}));

export const appSheetDefinitionCoverageSchema = z.strictObject({
  category: z.enum(APPSHEET_DEFINITION_CATEGORIES),
  state: z.enum(["observed", "matched_declared_count", "count_mismatch", "not_declared", "unsupported", "redacted"]),
  declaredCount: z.number().int().nonnegative().nullable(),
  observedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nullable(),
  redactedFieldCount: z.number().int().nonnegative(),
  ambiguousFieldCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  note: z.string().max(1_000),
});

export const appSheetDefinitionInventorySchema: z.ZodType<AppSheetDefinitionInventory> = z.strictObject({
  schemaVersion: z.literal(APPSHEET_DEFINITION_SCHEMA_VERSION),
  parserVersion: z.string().min(1).max(120),
  source: z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    encoding: z.literal("utf-8"),
  }),
  app: z.strictObject({
    id: z.string().max(200).nullable(),
    name: z.string().max(1_000).nullable(),
    version: z.string().max(200).nullable(),
    deploymentState: z.string().max(200).nullable(),
    generatedAt: z.string().max(500).nullable(),
    identity: z.strictObject({
      method: z.enum(["app-document-header", "referenced-process-state-namespace", "ambiguous", "unverified"]),
      evidenceId: z.string().min(1).max(80).nullable(),
      evidenceIds: z.array(z.string().min(1).max(80)).max(250_000),
      sourcePathReferenceCount: z.number().int().nonnegative(),
      candidateCount: z.number().int().nonnegative(),
    }).optional(),
  }),
  declaredCounts: z.partialRecord(z.enum(APPSHEET_DEFINITION_COUNT_KEYS), z.number().int().nonnegative()),
  observedCounts: z.partialRecord(z.enum(APPSHEET_DEFINITION_COUNT_KEYS), z.number().int().nonnegative()),
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.array(appSheetDefinitionCoverageSchema).max(APPSHEET_DEFINITION_CATEGORIES.length),
  sections: z.array(z.strictObject({
    category: z.enum(APPSHEET_DEFINITION_CATEGORIES),
    title: z.string().max(4_000),
    sectionPath: z.array(z.string().max(1_000)).max(32),
    evidenceId: z.string().min(1).max(80),
    records: z.array(appSheetDefinitionRecordSchema).max(100_000),
  })).max(10_000),
  evidence: z.array(appSheetDefinitionEvidenceSchema).max(1_000_000),
  redactedFieldCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_000)).max(1_000),
});
