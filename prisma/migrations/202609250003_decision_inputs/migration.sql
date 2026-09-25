CREATE TABLE "DecisionStockMapping" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('shared', 'separate')),
  "sharedLocationIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "localLocationIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "deliveryLocationIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "reference" TEXT NOT NULL,
  "confirmedByUserId" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionStockMapping_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DecisionStockMapping" ADD CONSTRAINT "DecisionStockMapping_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionSupplierRule" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "leadTimeDays" INTEGER NOT NULL CHECK ("leadTimeDays" >= 0),
  "minimumOrderQuantityMilliunits" INTEGER NOT NULL CHECK ("minimumOrderQuantityMilliunits" >= 0),
  "reviewPeriodDays" INTEGER NOT NULL CHECK ("reviewPeriodDays" >= 1),
  "sourceReference" TEXT NOT NULL,
  "confirmedByUserId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DecisionSupplierRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionSupplierRule_productId_updatedAt_idx" ON "DecisionSupplierRule"("productId", "updatedAt");
ALTER TABLE "DecisionSupplierRule" ADD CONSTRAINT "DecisionSupplierRule_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionSupplierRule" ADD CONSTRAINT "DecisionSupplierRule_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionReplacementQuote" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quotedOn" DATE NOT NULL,
  "validUntil" DATE,
  "unitCostCentsPerUnit" BIGINT NOT NULL CHECK ("unitCostCentsPerUnit" >= 0),
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'cancelled')),
  "sourceReference" TEXT NOT NULL,
  "enteredByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionReplacementQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DecisionReplacementQuote_validUntil_check" CHECK ("validUntil" IS NULL OR "validUntil" >= "quotedOn")
);
CREATE INDEX "DecisionReplacementQuote_productId_quotedOn_idx" ON "DecisionReplacementQuote"("productId", "quotedOn");
ALTER TABLE "DecisionReplacementQuote" ADD CONSTRAINT "DecisionReplacementQuote_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionReplacementQuote" ADD CONSTRAINT "DecisionReplacementQuote_enteredByUserId_fkey"
  FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionInboundOrder" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "locationId" TEXT,
  "quantityMilliunits" INTEGER NOT NULL CHECK ("quantityMilliunits" > 0),
  "arrivalDate" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'received', 'cancelled')),
  "sourceReference" TEXT NOT NULL,
  "enteredByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionInboundOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionInboundOrder_productId_arrivalDate_idx" ON "DecisionInboundOrder"("productId", "arrivalDate");
ALTER TABLE "DecisionInboundOrder" ADD CONSTRAINT "DecisionInboundOrder_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionInboundOrder" ADD CONSTRAINT "DecisionInboundOrder_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionInboundOrder" ADD CONSTRAINT "DecisionInboundOrder_enteredByUserId_fkey"
  FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionCashSnapshot" (
  "id" TEXT NOT NULL,
  "asOf" DATE NOT NULL,
  "floorCents" BIGINT NOT NULL CHECK ("floorCents" >= 0),
  "sourceReference" TEXT NOT NULL,
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "reconciledByUserId" TEXT NOT NULL,
  "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionCashSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionCashSnapshot_asOf_reconciledAt_idx" ON "DecisionCashSnapshot"("asOf", "reconciledAt");
ALTER TABLE "DecisionCashSnapshot" ADD CONSTRAINT "DecisionCashSnapshot_reconciledByUserId_fkey"
  FOREIGN KEY ("reconciledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionCashSnapshotAccount" (
  "snapshotId" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  CONSTRAINT "DecisionCashSnapshotAccount_pkey" PRIMARY KEY ("snapshotId", "account")
);
ALTER TABLE "DecisionCashSnapshotAccount" ADD CONSTRAINT "DecisionCashSnapshotAccount_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "DecisionCashSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionCashPlanEvent" (
  "id" TEXT NOT NULL,
  "scenario" TEXT NOT NULL CHECK ("scenario" IN ('low', 'base', 'high')),
  "date" DATE NOT NULL,
  "account" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL CHECK ("amountCents" <> 0),
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'cancelled')),
  "sourceReference" TEXT NOT NULL,
  "enteredByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionCashPlanEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionCashPlanEvent_scenario_date_idx" ON "DecisionCashPlanEvent"("scenario", "date");
ALTER TABLE "DecisionCashPlanEvent" ADD CONSTRAINT "DecisionCashPlanEvent_enteredByUserId_fkey"
  FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionInputAttestation" (
  "id" TEXT NOT NULL,
  "domain" TEXT NOT NULL CHECK ("domain" IN ('delivery_sales', 'cash_plan')),
  "scenario" TEXT CHECK ("scenario" IS NULL OR "scenario" IN ('low', 'base', 'high')),
  "fromDate" DATE NOT NULL,
  "throughDate" DATE NOT NULL,
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "sourceReference" TEXT NOT NULL,
  "confirmedByUserId" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionInputAttestation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DecisionInputAttestation_dates_check" CHECK ("fromDate" <= "throughDate"),
  CONSTRAINT "DecisionInputAttestation_domain_scenario_check" CHECK (("domain" = 'delivery_sales' AND "scenario" IS NULL) OR ("domain" = 'cash_plan' AND "scenario" IS NOT NULL))
);
CREATE INDEX "DecisionInputAttestation_domain_scenario_dates_idx" ON "DecisionInputAttestation"("domain", "scenario", "fromDate", "throughDate");
ALTER TABLE "DecisionInputAttestation" ADD CONSTRAINT "DecisionInputAttestation_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
