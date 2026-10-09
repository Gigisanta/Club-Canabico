/** The two staged AppSheet source identities are evidence/reconciliation only. */
export const technicalLegacySourceSystems = [
  "appsheet-business-archive",
  "appsheet-finance-observations",
] as const;

export function isTechnicalLegacySource(sourceSystem: string): boolean {
  return (technicalLegacySourceSystems as readonly string[]).includes(sourceSystem);
}

export type LegacySourceFollowUpStatus = "pending" | "reviewing" | "explained";

export interface LegacySourceFollowUp {
  status: LegacySourceFollowUpStatus;
  note: string;
  evidence: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface LegacySourceTableSummary {
  tableName: string;
  rowCount: number;
  exceptionCount: number;
}

export interface LegacyCoordinateOnlySheet {
  name: string;
  extracted: false;
  dimension: string | null;
}

export interface LegacySourceSummary {
  snapshotId: string;
  sourceSystem: string;
  filename: string;
  fileHash: string;
  importerVersion: string;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  rowCount: number;
  exceptionCount: number;
  unattachedExceptionCount: number;
  tables: LegacySourceTableSummary[];
  coordinateOnlySheets?: LegacyCoordinateOnlySheet[];
  technicalSource: boolean;
  allowedActions: {
    recordFollowUp: true;
    genericLegacyWorkflow: boolean;
  };
}

export interface LegacySourceExceptionView {
  exceptionId: string;
  code: string;
  severity: string;
  status: string;
}

export interface LegacySourceRecordView {
  recordId: string;
  tableName: string;
  rowNumber: number;
  treatment: string;
  original: unknown;
  normalized: unknown;
  exceptionCount: number;
  exceptions: LegacySourceExceptionView[];
  exceptionsTruncated: boolean;
  exceptionsNextCursor: string | null;
  canRecordFollowUp: boolean;
  followUp: LegacySourceFollowUp | null;
}

export interface LegacySourceExceptionPage {
  items: LegacySourceExceptionView[];
  nextCursor: string | null;
}

export function legacySourceFollowUpObjectId(recordId: string): string {
  return `legacy-source-follow-up:${recordId}`;
}
