import type { CommandEnvelope } from "../../shared/operations/contracts";

export type JsonRecord = Record<string, unknown>;

export interface OperationsContext {
  userId: string;
  profile: string;
  isOwner?: boolean;
  canManageDecisionInputs: boolean;
  operationalApprovalConfigured: boolean;
  capabilities: string[];
  rehearsal: boolean;
  authority: {
    mode: "shadow" | "active" | string;
    epoch: number;
    firstRealWriteAt: string | null;
  };
  timeZone: string;
  commands: Array<{ command: string; kind: string; create: boolean }>;
}

export interface VersionedResponse<T> {
  items: T[];
  versions?: Record<string, number>;
  [key: string]: unknown;
}

export type FieldType = "text" | "email" | "tel" | "date" | "month" | "datetime-local" | "select" | "textarea" | "integer" | "decimal" | "amount" | "checkbox" | "repeat";

export interface ActionField {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  lookupPath?: string;
  defaultValue?: string | boolean;
  min?: string;
  max?: string;
  step?: string;
  fields?: ActionField[];
  rowFields?: (values: Record<string, string | boolean>) => ActionField[];
  autoSelectSingleOption?: boolean;
  initialRows?: number;
  maxRows?: number;
  addLabel?: string;
}

export interface CommandAction {
  command: string;
  title: string;
  description?: string;
  targetId?: string;
  expectedVersion?: number;
  requestIdIsTarget?: boolean;
  submitLabel?: string;
  fields: ActionField[];
  toData: (values: Record<string, string | boolean>) => JsonRecord;
}

export type RunCommand = (
  command: string,
  targetId: string,
  expectedVersion: number,
  data: JsonRecord,
  requestIdIsTarget?: boolean,
) => Promise<unknown>;

export interface CommandEnvelopeV1 extends CommandEnvelope {}
