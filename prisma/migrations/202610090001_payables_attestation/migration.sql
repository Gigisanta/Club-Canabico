ALTER TABLE "DecisionInputAttestation"
  DROP CONSTRAINT "DecisionInputAttestation_domain_check",
  DROP CONSTRAINT "DecisionInputAttestation_domain_scenario_check",
  ADD CONSTRAINT "DecisionInputAttestation_domain_check"
    CHECK ("domain" IN ('delivery_sales', 'cash_plan', 'payables')),
  ADD CONSTRAINT "DecisionInputAttestation_domain_scenario_check"
    CHECK (
      ("domain" IN ('delivery_sales', 'payables') AND "scenario" IS NULL)
      OR ("domain" = 'cash_plan' AND "scenario" IS NOT NULL)
    );
