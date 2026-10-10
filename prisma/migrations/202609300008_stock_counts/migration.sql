CREATE TABLE "OperationalStockCount" (
  "id" TEXT PRIMARY KEY, "balanceId" TEXT NOT NULL, "unit" TEXT NOT NULL,
  "recordedQuantity" DECIMAL(38,12) NOT NULL, "recordedReserved" DECIMAL(38,12) NOT NULL,
  "countedQuantity" DECIMAL(38,12) NOT NULL, "countedBy" TEXT NOT NULL, "countedAt" TIMESTAMP(3) NOT NULL,
  "evidence" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3), "resolution" JSONB,
  CONSTRAINT "OperationalStockCount_bounds" CHECK ("countedQuantity" >= 0 AND "recordedReserved" >= 0 AND "recordedQuantity" >= "recordedReserved")
);
CREATE INDEX "OperationalStockCount_balanceId_countedAt_idx" ON "OperationalStockCount"("balanceId","countedAt");
