ALTER TABLE "HistoricalReconciliation"
  ADD COLUMN "sourceRecordCount" INTEGER,
  ADD COLUMN "sourceTotalCents" BIGINT,
  ADD COLUMN "calculatedTotalCents" BIGINT;

ALTER TABLE "HistoricalReconciliation"
  ADD CONSTRAINT "HistoricalReconciliation_sourceRecordCount_check"
  CHECK ("sourceRecordCount" IS NULL OR "sourceRecordCount" >= 0);
