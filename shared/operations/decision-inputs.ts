export const decisionInputAttestationDomains = ["delivery_sales", "cash_plan", "payables"] as const;

export type DecisionInputAttestationDomain = typeof decisionInputAttestationDomains[number];

type DecisionInputAttestationFields = {
  requestId?: string;
  fromDate: string;
  throughDate: string;
  complete: boolean;
  sourceReference: string;
};

export type DecisionInputAttestationInput = DecisionInputAttestationFields & (
  | { domain: "delivery_sales"; scenario: null }
  | { domain: "cash_plan"; scenario: "low" | "base" | "high" }
  | { domain: "payables"; scenario: null }
);
