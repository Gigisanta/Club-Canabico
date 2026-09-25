CREATE TYPE "HistoricalImportStatus" AS ENUM ('ready', 'rejected', 'imported', 'reconciled');
CREATE TYPE "DecisionTaskCadence" AS ENUM ('none', 'weekly', 'monthly');
CREATE TYPE "DecisionEvidenceState" AS ENUM ('demo', 'missing', 'imported', 'reconciled', 'estimated', 'scenario');

CREATE TABLE "HistoricalImportBatch" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "cutoffDate" DATE NOT NULL,
    "status" "HistoricalImportStatus" NOT NULL,
    "mapping" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "factsHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL,
    "rejectedCount" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "committedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),
    CONSTRAINT "HistoricalImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalImportBatch_idempotencyKey_key" ON "HistoricalImportBatch"("idempotencyKey");
CREATE INDEX "HistoricalImportBatch_sourceSystem_createdAt_idx" ON "HistoricalImportBatch"("sourceSystem", "createdAt");
CREATE INDEX "HistoricalImportBatch_status_createdAt_idx" ON "HistoricalImportBatch"("status", "createdAt");
ALTER TABLE "HistoricalImportBatch" ADD CONSTRAINT "HistoricalImportBatch_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HistoricalImportBatch" ADD CONSTRAINT "HistoricalImportBatch_committedByUserId_fkey"
    FOREIGN KEY ("committedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "HistoricalReconciliation" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "coverageFrom" DATE,
    "coverageThrough" DATE,
    "coverageComplete" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "confirmedByUserId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "varianceCents" BIGINT,
    CONSTRAINT "HistoricalReconciliation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalReconciliation_batchId_key" ON "HistoricalReconciliation"("batchId");
CREATE INDEX "HistoricalReconciliation_asOf_idx" ON "HistoricalReconciliation"("asOf");
ALTER TABLE "HistoricalReconciliation" ADD CONSTRAINT "HistoricalReconciliation_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "HistoricalImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HistoricalReconciliation" ADD CONSTRAINT "HistoricalReconciliation_confirmedByUserId_fkey"
    FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HistoricalDeliverySale" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "saleDate" DATE NOT NULL,
    "totalCents" BIGINT NOT NULL CHECK ("totalCents" >= 0),
    "discountCents" BIGINT NOT NULL DEFAULT 0 CHECK ("discountCents" >= 0),
    CONSTRAINT "HistoricalDeliverySale_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalDeliverySale_sourceSystem_sourceId_key" ON "HistoricalDeliverySale"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalDeliverySale_saleDate_idx" ON "HistoricalDeliverySale"("saleDate");

CREATE TABLE "HistoricalDeliverySaleLine" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "itemLabel" TEXT NOT NULL,
    "productSourceId" TEXT,
    "quantityMilliunits" BIGINT NOT NULL CHECK ("quantityMilliunits" > 0),
    "quantityUnit" TEXT NOT NULL,
    "unitPriceCents" BIGINT CHECK ("unitPriceCents" IS NULL OR "unitPriceCents" >= 0),
    "lineTotalCents" BIGINT NOT NULL CHECK ("lineTotalCents" >= 0),
    CONSTRAINT "HistoricalDeliverySaleLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalDeliverySaleLine_sourceSystem_sourceId_key" ON "HistoricalDeliverySaleLine"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalDeliverySaleLine_saleId_idx" ON "HistoricalDeliverySaleLine"("saleId");
CREATE INDEX "HistoricalDeliverySaleLine_productSourceId_idx" ON "HistoricalDeliverySaleLine"("productSourceId");
ALTER TABLE "HistoricalDeliverySaleLine" ADD CONSTRAINT "HistoricalDeliverySaleLine_saleId_fkey"
    FOREIGN KEY ("saleId") REFERENCES "HistoricalDeliverySale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HistoricalPurchaseReceipt" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "receivedDate" DATE NOT NULL,
    "supplierSourceId" TEXT,
    "totalCents" BIGINT NOT NULL CHECK ("totalCents" >= 0),
    CONSTRAINT "HistoricalPurchaseReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalPurchaseReceipt_sourceSystem_sourceId_key" ON "HistoricalPurchaseReceipt"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalPurchaseReceipt_receivedDate_idx" ON "HistoricalPurchaseReceipt"("receivedDate");
CREATE INDEX "HistoricalPurchaseReceipt_supplierSourceId_receivedDate_idx" ON "HistoricalPurchaseReceipt"("supplierSourceId", "receivedDate");

CREATE TABLE "HistoricalPurchaseReceiptLine" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemLabel" TEXT NOT NULL,
    "productSourceId" TEXT,
    "quantityMilliunits" BIGINT NOT NULL CHECK ("quantityMilliunits" > 0),
    "quantityUnit" TEXT NOT NULL,
    "unitCostCents" BIGINT CHECK ("unitCostCents" IS NULL OR "unitCostCents" >= 0),
    "lineTotalCents" BIGINT NOT NULL CHECK ("lineTotalCents" >= 0),
    CONSTRAINT "HistoricalPurchaseReceiptLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalPurchaseReceiptLine_sourceSystem_sourceId_key" ON "HistoricalPurchaseReceiptLine"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalPurchaseReceiptLine_receiptId_idx" ON "HistoricalPurchaseReceiptLine"("receiptId");
CREATE INDEX "HistoricalPurchaseReceiptLine_productSourceId_idx" ON "HistoricalPurchaseReceiptLine"("productSourceId");
ALTER TABLE "HistoricalPurchaseReceiptLine" ADD CONSTRAINT "HistoricalPurchaseReceiptLine_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "HistoricalPurchaseReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HistoricalStockObservation" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "observedDate" DATE NOT NULL,
    "productSourceId" TEXT,
    "itemLabel" TEXT NOT NULL,
    "locationSourceId" TEXT,
    "quantityMilliunits" BIGINT NOT NULL CHECK ("quantityMilliunits" >= 0),
    "quantityUnit" TEXT NOT NULL,
    CONSTRAINT "HistoricalStockObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalStockObservation_sourceSystem_sourceId_key" ON "HistoricalStockObservation"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalStockObservation_observedDate_productSourceId_idx" ON "HistoricalStockObservation"("observedDate", "productSourceId");
CREATE INDEX "HistoricalStockObservation_locationSourceId_observedDate_idx" ON "HistoricalStockObservation"("locationSourceId", "observedDate");

CREATE TABLE "HistoricalStockout" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "stockoutDate" DATE NOT NULL,
    "productSourceId" TEXT,
    "itemLabel" TEXT NOT NULL,
    "locationSourceId" TEXT,
    "lostQuantityMilliunits" BIGINT CHECK ("lostQuantityMilliunits" IS NULL OR "lostQuantityMilliunits" >= 0),
    "quantityUnit" TEXT,
    CONSTRAINT "HistoricalStockout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalStockout_sourceSystem_sourceId_key" ON "HistoricalStockout"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalStockout_stockoutDate_productSourceId_idx" ON "HistoricalStockout"("stockoutDate", "productSourceId");
CREATE INDEX "HistoricalStockout_locationSourceId_stockoutDate_idx" ON "HistoricalStockout"("locationSourceId", "stockoutDate");

CREATE TABLE "HistoricalExpense" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" >= 0),
    CONSTRAINT "HistoricalExpense_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalExpense_sourceSystem_sourceId_key" ON "HistoricalExpense"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalExpense_expenseDate_category_idx" ON "HistoricalExpense"("expenseDate", "category");

CREATE TABLE "HistoricalPromotion" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "discountCents" BIGINT CHECK ("discountCents" IS NULL OR "discountCents" >= 0),
    CONSTRAINT "HistoricalPromotion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HistoricalPromotion_date_order_check" CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn")
);
CREATE UNIQUE INDEX "HistoricalPromotion_sourceSystem_sourceId_key" ON "HistoricalPromotion"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalPromotion_startsOn_endsOn_idx" ON "HistoricalPromotion"("startsOn", "endsOn");

CREATE TABLE "HistoricalCashReconciliation" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "reconciledDate" DATE NOT NULL,
    "account" TEXT NOT NULL,
    "expectedCents" BIGINT NOT NULL CHECK ("expectedCents" >= 0),
    "countedCents" BIGINT NOT NULL CHECK ("countedCents" >= 0),
    "varianceCents" BIGINT NOT NULL,
    CONSTRAINT "HistoricalCashReconciliation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HistoricalCashReconciliation_variance_check" CHECK ("varianceCents" = "countedCents" - "expectedCents")
);
CREATE UNIQUE INDEX "HistoricalCashReconciliation_sourceSystem_sourceId_key" ON "HistoricalCashReconciliation"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalCashReconciliation_reconciledDate_account_idx" ON "HistoricalCashReconciliation"("reconciledDate", "account");

CREATE TABLE "HistoricalCashMovement" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "movementDate" DATE NOT NULL,
    "account" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" <> 0),
    CONSTRAINT "HistoricalCashMovement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalCashMovement_sourceSystem_sourceId_key" ON "HistoricalCashMovement"("sourceSystem", "sourceId");
CREATE INDEX "HistoricalCashMovement_movementDate_account_idx" ON "HistoricalCashMovement"("movementDate", "account");
CREATE INDEX "HistoricalCashMovement_category_movementDate_idx" ON "HistoricalCashMovement"("category", "movementDate");

CREATE TABLE "HistoricalMember" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "memberKey" TEXT NOT NULL,
    "permitStatus" TEXT NOT NULL CHECK ("permitStatus" IN ('active', 'valid', 'expired', 'pending', 'revoked', 'unknown', 'missing')),
    "permitExpiryDate" DATE,
    "permitCheckedAt" DATE,
    CONSTRAINT "HistoricalMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalMember_sourceSystem_sourceId_key" ON "HistoricalMember"("sourceSystem", "sourceId");
CREATE UNIQUE INDEX "HistoricalMember_sourceSystem_memberKey_key" ON "HistoricalMember"("sourceSystem", "memberKey");

CREATE TABLE "HistoricalImportProvenance" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "factKind" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factHash" TEXT NOT NULL,
    "disposition" TEXT NOT NULL CHECK ("disposition" IN ('inserted', 'skipped')),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistoricalImportProvenance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalImportProvenance_batchId_factKind_sourceSystem_sourceId_key"
    ON "HistoricalImportProvenance"("batchId", "factKind", "sourceSystem", "sourceId");
CREATE INDEX "HistoricalImportProvenance_sourceSystem_factKind_sourceId_idx"
    ON "HistoricalImportProvenance"("sourceSystem", "factKind", "sourceId");
CREATE INDEX "HistoricalImportProvenance_batchId_recordedAt_idx"
    ON "HistoricalImportProvenance"("batchId", "recordedAt");
ALTER TABLE "HistoricalImportProvenance" ADD CONSTRAINT "HistoricalImportProvenance_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "HistoricalImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DecisionTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueDate" DATE NOT NULL,
    "cadence" "DecisionTaskCadence" NOT NULL DEFAULT 'none',
    "status" TEXT NOT NULL DEFAULT 'todo' CHECK ("status" IN ('todo', 'doing', 'done')),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DecisionTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionTask_status_dueDate_idx" ON "DecisionTask"("status", "dueDate");
CREATE INDEX "DecisionTask_ownerId_dueDate_idx" ON "DecisionTask"("ownerId", "dueDate");
ALTER TABLE "DecisionTask" ADD CONSTRAINT "DecisionTask_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MonthlyReview" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "actualCents" BIGINT,
    "planCents" BIGINT,
    "deviationCents" BIGINT,
    "cause" TEXT NOT NULL DEFAULT '',
    "decision" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT,
    "followUpDate" DATE,
    "source" TEXT NOT NULL,
    "evidence" "DecisionEvidenceState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonthlyReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonthlyReview_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
CREATE INDEX "MonthlyReview_period_idx" ON "MonthlyReview"("period");
CREATE INDEX "MonthlyReview_ownerId_period_idx" ON "MonthlyReview"("ownerId", "period");
ALTER TABLE "MonthlyReview" ADD CONSTRAINT "MonthlyReview_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SensitiveAccessAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "SensitiveAccessAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SensitiveAccessAudit_userId_at_idx" ON "SensitiveAccessAudit"("userId", "at");
CREATE INDEX "SensitiveAccessAudit_area_at_idx" ON "SensitiveAccessAudit"("area", "at");
ALTER TABLE "SensitiveAccessAudit" ADD CONSTRAINT "SensitiveAccessAudit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_sensitive_access_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SensitiveAccessAudit is append-only';
END;
$$;
CREATE TRIGGER "SensitiveAccessAudit_no_update_delete"
  BEFORE UPDATE OR DELETE ON "SensitiveAccessAudit"
  FOR EACH ROW EXECUTE FUNCTION "reject_sensitive_access_audit_mutation"();
CREATE TRIGGER "SensitiveAccessAudit_no_truncate"
  BEFORE TRUNCATE ON "SensitiveAccessAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_sensitive_access_audit_mutation"();
