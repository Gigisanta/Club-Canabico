/** Public decision support contract. Money is serialized as signed integer centavos. */
export type EvidenceState =
  | "demo"
  | "missing"
  | "imported"
  | "reconciled"
  | "estimated"
  | "scenario";

export type DecisionKind = "replenishment" | "commercial" | "cash";

export interface DecisionCard {
  kind: DecisionKind;
  title: string;
  summary: string;
  nextStep: string;
  path: string;
  owner: string;
  evidence: EvidenceState;
  source: string;
  asOf: string;
  calculationVersion: string;
  impactCents: string | null;
  quantityMilli: number | null;
  limitation: string | null;
}

export interface DecisionTaskView {
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string;
  dueDate: string;
  cadence: "none" | "weekly" | "monthly";
  status: "todo" | "doing" | "done";
}

export interface MonthlyReviewView {
  id: string;
  period: string;
  metric: string;
  actualCents: string | null;
  planCents: string | null;
  deviationCents: string | null;
  cause: string;
  decision: string;
  ownerId: string | null;
  ownerName: string;
  followUpDate: string | null;
  source: string;
  evidence: EvidenceState;
}

export interface DecisionCenterPayload {
  asOf: string;
  demo: boolean;
  cards: [DecisionCard, DecisionCard, DecisionCard];
  dataQuality: {
    state: EvidenceState;
    latestCutoff: string | null;
    latestSource: string | null;
    pendingConflicts: number;
    note: string;
  };
  tasks: DecisionTaskView[];
  reviews: MonthlyReviewView[];
  users: { id: string; name: string }[];
}
