import { z } from "zod";

export const financialSourceReportCurrencies = ["ARS", "USD"] as const;
export type FinancialSourceReportCurrency = (typeof financialSourceReportCurrencies)[number];

export const financialSourceExclusionReasons = [
  "missingDate",
  "invalidDate",
  "futureDate",
  "nonNumericAmount",
  "negativeAmount",
  "invalidMovementType",
  "invalidCurrency",
  "blankCashBox",
  "duplicateIdentity",
] as const;
export type FinancialSourceExclusionReason = (typeof financialSourceExclusionReasons)[number];
export type FinancialSourceExclusionCounts = Record<FinancialSourceExclusionReason, number>;

export interface FinancialSourcePeriod {
  month: string;
  currency: FinancialSourceReportCurrency;
  count: number;
  inflowMinor: string;
  outflowMinor: string;
  netMovementMinor: string;
}

/** Independent per-file controls stored in the staged snapshot manifest. */
export interface FinancialSourceControl {
  fileHash: string;
  cutoffDate: string;
  rawCount: number;
  eligibleCount: number;
  excludedCount: number;
  periods: FinancialSourcePeriod[];
}

/** A deliberately narrow projection of one Movimiento_Nueva row. */
export interface FinancialSourceObservationRow {
  date: string | null;
  dateFieldAmbiguous: boolean;
  movementType: string | null;
  currency: string | null;
  amountMinor: string | null;
  hasCashBox: boolean;
  duplicateIdentity: boolean;
}

export interface FinancialSourceSnapshotInput {
  snapshotId: string;
  filename: string;
  fileHash: string;
  status: "staged";
  scopeVerified: boolean;
  expectedControl: FinancialSourceControl | null;
  rows: readonly FinancialSourceObservationRow[];
}

export interface FinancialSourceControlComparison {
  scope: boolean;
  fileHash: boolean;
  cutoffDate: boolean;
  rawCount: boolean;
  eligibleCount: boolean;
  excludedCount: boolean;
  periods: boolean;
  exact: boolean;
}

export interface FinancialSourceSnapshotReport {
  snapshotId: string;
  filename: string;
  fileHash: string;
  status: "staged";
  label: "STAGED · observación de origen sin aprobar";
  sourceReviewApproved: false;
  loadedCount: number;
  eligibleCount: number;
  excludedCount: number;
  exclusionCounts: FinancialSourceExclusionCounts;
  latestObservedDate: string | null;
  expectedControl: FinancialSourceControl | null;
  observedControl: FinancialSourceControl;
  controlComparison: FinancialSourceControlComparison;
  technicalReconciliation: "reconciled" | "unverified";
  technicalReconciliationReason:
    | "control-manifest-missing-or-invalid"
    | "source-scope-mismatch"
    | "control-file-hash-mismatch"
    | "control-cutoff-date-mismatch"
    | "control-counts-mismatch"
    | "control-periods-mismatch"
    | null;
}

export interface FinancialSourceReconciliationReport {
  report: "operations-financial-source-reconciliation";
  cutoffDate: string;
  sources: FinancialSourceSnapshotReport[];
  latestObservedDate: string | null;
  /** Null when there is no source or several snapshots could overlap. */
  periods: FinancialSourcePeriod[] | null;
  completeness: "technical-source-reconciled" | "unverified";
  sourceUnapproved: true;
  createsBalances: false;
  currentPeriodStatus: "unknown";
}

export interface FinancialSourceReconciliationBuildInput {
  cutoffDate: string;
  sources: readonly FinancialSourceSnapshotInput[];
}

const ISO_DATE = z.iso.date();
const ISO_DATETIME = z.iso.datetime({ offset: true });
const minorString = z.string().regex(/^-?(0|[1-9]\d*)$/);
const positiveMinorString = z.string().regex(/^(0|[1-9]\d*)$/);
const periodSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.enum(financialSourceReportCurrencies),
  count: z.number().int().nonnegative().safe(),
  inflowMinor: positiveMinorString,
  outflowMinor: positiveMinorString,
  netMovementMinor: minorString,
}).superRefine((period, context) => {
  if (BigInt(period.inflowMinor) - BigInt(period.outflowMinor) !== BigInt(period.netMovementMinor)) {
    context.addIssue({ code: "custom", path: ["netMovementMinor"], message: "El movimiento neto no coincide con entradas menos salidas." });
  }
});

export const financialSourceControlSchema = z.strictObject({
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  cutoffDate: ISO_DATE,
  rawCount: z.number().int().nonnegative().safe(),
  eligibleCount: z.number().int().nonnegative().safe(),
  excludedCount: z.number().int().nonnegative().safe(),
  periods: z.array(periodSchema).max(1000),
}).superRefine((control, context) => {
  if (control.eligibleCount + control.excludedCount !== control.rawCount) {
    context.addIssue({ code: "custom", path: ["excludedCount"], message: "El control debe particionar la población cargada." });
  }
  const keys = control.periods.map(period => `${period.month}\u0000${period.currency}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["periods"], message: "El control repite un período y una moneda." });
  }
  if (control.periods.reduce((sum, period) => sum + period.count, 0) !== control.eligibleCount) {
    context.addIssue({ code: "custom", path: ["periods"], message: "Los períodos no cubren la cantidad elegible." });
  }
});

function sourceDate(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const candidate = value.trim();
  if (ISO_DATE.safeParse(candidate).success) return candidate;
  if (ISO_DATETIME.safeParse(candidate).success) return candidate.slice(0, 10);
  return null;
}

function validMinor(value: string | null): bigint | null {
  if (value === null || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
  try {
    const amount = BigInt(value);
    return amount >= -9_223_372_036_854_775_808n && amount <= 9_223_372_036_854_775_807n ? amount : null;
  } catch {
    return null;
  }
}

function emptyExclusionCounts(): FinancialSourceExclusionCounts {
  return {
    missingDate: 0,
    invalidDate: 0,
    futureDate: 0,
    nonNumericAmount: 0,
    negativeAmount: 0,
    invalidMovementType: 0,
    invalidCurrency: 0,
    blankCashBox: 0,
    duplicateIdentity: 0,
  };
}

function comparePeriods(left: readonly FinancialSourcePeriod[], right: readonly FinancialSourcePeriod[]): boolean {
  if (left.length !== right.length) return false;
  const keyOrder = (a: FinancialSourcePeriod, b: FinancialSourcePeriod) =>
    a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency);
  const orderedLeft = [...left].sort(keyOrder);
  const orderedRight = [...right].sort(keyOrder);
  return orderedLeft.every((period, index) => {
    const candidate = orderedRight[index]!;
    return period.month === candidate.month
      && period.currency === candidate.currency
      && period.count === candidate.count
      && period.inflowMinor === candidate.inflowMinor
      && period.outflowMinor === candidate.outflowMinor
      && period.netMovementMinor === candidate.netMovementMinor;
  });
}

function compareControl(
  expected: FinancialSourceControl | null,
  observed: FinancialSourceControl,
  snapshotFileHash: string,
  cutoffDate: string,
  inputScopeMatches: boolean,
): FinancialSourceControlComparison {
  const comparison: FinancialSourceControlComparison = {
    scope: inputScopeMatches,
    fileHash: expected !== null && expected.fileHash === snapshotFileHash && observed.fileHash === snapshotFileHash,
    cutoffDate: expected !== null && expected.cutoffDate === cutoffDate && observed.cutoffDate === cutoffDate,
    rawCount: expected !== null && expected.rawCount === observed.rawCount,
    eligibleCount: expected !== null && expected.eligibleCount === observed.eligibleCount,
    excludedCount: expected !== null && expected.excludedCount === observed.excludedCount,
    periods: expected !== null && comparePeriods(expected.periods, observed.periods),
    exact: false,
  };
  comparison.exact = comparison.scope
    && comparison.fileHash
    && comparison.cutoffDate
    && comparison.rawCount
    && comparison.eligibleCount
    && comparison.excludedCount
    && comparison.periods;
  return comparison;
}

function reconcileSnapshot(
  input: FinancialSourceSnapshotInput,
  cutoffDate: string,
): FinancialSourceSnapshotReport {
  const exclusionCounts = emptyExclusionCounts();
  const periods = new Map<string, {
    month: string;
    currency: FinancialSourceReportCurrency;
    count: number;
    inflow: bigint;
    outflow: bigint;
  }>();
  let eligibleCount = 0;
  let latestObservedDate: string | null = null;

  for (const row of input.rows) {
    const date = sourceDate(row.date);
    const parsedAmount = validMinor(row.amountMinor);
    const excludedReasons: FinancialSourceExclusionReason[] = [];

    if (row.dateFieldAmbiguous) exclusionCounts.invalidDate++;
    else if (row.date === null || row.date.trim() === "") exclusionCounts.missingDate++;
    else if (date === null) exclusionCounts.invalidDate++;
    else if (date > cutoffDate) {
      exclusionCounts.futureDate++;
      excludedReasons.push("futureDate");
    }
    if (parsedAmount === null) {
      exclusionCounts.nonNumericAmount++;
      excludedReasons.push("nonNumericAmount");
    } else if (parsedAmount < 0n) {
      exclusionCounts.negativeAmount++;
      excludedReasons.push("negativeAmount");
    }
    if (row.movementType !== "Ingreso" && row.movementType !== "Egreso") {
      exclusionCounts.invalidMovementType++;
      excludedReasons.push("invalidMovementType");
    }
    const currency = row.currency === "ARS" || row.currency === "USD" ? row.currency : null;
    if (currency === null) {
      exclusionCounts.invalidCurrency++;
      excludedReasons.push("invalidCurrency");
    }
    if (!row.hasCashBox) {
      exclusionCounts.blankCashBox++;
      excludedReasons.push("blankCashBox");
    }
    if (row.duplicateIdentity) {
      exclusionCounts.duplicateIdentity++;
      excludedReasons.push("duplicateIdentity");
    }
    if (row.dateFieldAmbiguous) excludedReasons.push("invalidDate");
    else if (row.date === null || row.date.trim() === "") excludedReasons.push("missingDate");
    else if (date === null) excludedReasons.push("invalidDate");

    if (excludedReasons.length > 0 || date === null || parsedAmount === null || currency === null) continue;

    const month = date.slice(0, 7);
    const key = `${month}\u0000${currency}`;
    const bucket = periods.get(key) ?? { month, currency, count: 0, inflow: 0n, outflow: 0n };
    bucket.count++;
    if (row.movementType === "Ingreso") bucket.inflow += parsedAmount;
    else bucket.outflow += parsedAmount;
    periods.set(key, bucket);
    eligibleCount++;
    if (latestObservedDate === null || date > latestObservedDate) latestObservedDate = date;
  }

  const observedPeriods = [...periods.values()]
    .map(({ month, currency, count, inflow, outflow }) => ({
      month,
      currency,
      count,
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
      netMovementMinor: (inflow - outflow).toString(),
    }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
  const excludedCount = input.rows.length - eligibleCount;
  const observedControl: FinancialSourceControl = {
    fileHash: input.fileHash,
    cutoffDate,
    rawCount: input.rows.length,
    eligibleCount,
    excludedCount,
    periods: observedPeriods,
  };
  const controlComparison = compareControl(input.expectedControl, observedControl, input.fileHash, cutoffDate, input.scopeVerified);
  const technicalReconciliationReason: FinancialSourceSnapshotReport["technicalReconciliationReason"] =
    input.expectedControl === null ? "control-manifest-missing-or-invalid"
      : !controlComparison.scope ? "source-scope-mismatch"
      : !controlComparison.fileHash ? "control-file-hash-mismatch"
        : !controlComparison.cutoffDate ? "control-cutoff-date-mismatch"
          : !controlComparison.rawCount || !controlComparison.eligibleCount || !controlComparison.excludedCount ? "control-counts-mismatch"
            : !controlComparison.periods ? "control-periods-mismatch"
              : null;

  return {
    snapshotId: input.snapshotId,
    filename: input.filename,
    fileHash: input.fileHash,
    status: input.status,
    label: "STAGED · observación de origen sin aprobar",
    sourceReviewApproved: false,
    loadedCount: input.rows.length,
    eligibleCount,
    excludedCount,
    exclusionCounts,
    latestObservedDate,
    expectedControl: input.expectedControl,
    observedControl,
    controlComparison,
    technicalReconciliation: controlComparison.exact ? "reconciled" : "unverified",
    technicalReconciliationReason,
  };
}

/** Builds a source-only, exact minor-unit view; it never certifies balances or results. */
export function buildFinancialSourceReconciliationReport(
  input: FinancialSourceReconciliationBuildInput,
): FinancialSourceReconciliationReport {
  if (!ISO_DATE.safeParse(input.cutoffDate).success) throw new TypeError("cutoffDate must be a valid civil date");
  const sources = input.sources.map(source => reconcileSnapshot(source, input.cutoffDate));
  const latestObservedDate = sources
    .map(source => source.latestObservedDate)
    .filter((date): date is string => date !== null)
    .sort()
    .at(-1) ?? null;
  const oneUnambiguousSource = sources.length === 1;
  const periods = oneUnambiguousSource ? sources[0]!.observedControl.periods : null;
  const complete = oneUnambiguousSource && sources[0]!.technicalReconciliation === "reconciled";

  return {
    report: "operations-financial-source-reconciliation",
    cutoffDate: input.cutoffDate,
    sources,
    latestObservedDate,
    periods,
    completeness: complete ? "technical-source-reconciled" : "unverified",
    sourceUnapproved: true,
    createsBalances: false,
    currentPeriodStatus: "unknown",
  };
}
