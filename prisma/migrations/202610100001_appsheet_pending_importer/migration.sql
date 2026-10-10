CREATE TABLE "AppSheetPendingImportBatch" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "projectionHash" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "dataHash" TEXT NOT NULL,
  "historyRecordsHash" TEXT NOT NULL,
  "mappingId" TEXT NOT NULL,
  "mappingHash" TEXT NOT NULL,
  "sourceSpecHash" TEXT NOT NULL,
  "sourceCoverageHash" TEXT NOT NULL,
  "dispositionHash" TEXT NOT NULL,
  "destinationHash" TEXT NOT NULL,
  "destinationVersion" INTEGER NOT NULL DEFAULT 1,
  "target" TEXT NOT NULL,
  "destinationIdentity" TEXT NOT NULL,
  "commitSha" TEXT NOT NULL,
  "backupManifestHash" TEXT NOT NULL,
  "backupSnapshotAt" TIMESTAMP(3) NOT NULL,
  "stageReview" JSONB,
  "sourceRecordCount" INTEGER NOT NULL,
  "dispositionCount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'staged',
  "createdBy" TEXT NOT NULL,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewedObjectVersion" INTEGER,
  "reviewEvidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppSheetPendingImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppSheetPendingImportDisposition" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "sourceTable" TEXT NOT NULL,
  "sourceRow" INTEGER NOT NULL,
  "sourceRecordHash" TEXT NOT NULL,
  "reconciliationHash" TEXT NOT NULL,
  "mappingHash" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "sourceStatus" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "reason" TEXT,
  "destinationType" TEXT,
  "destinationId" TEXT,
  "destinationVersion" INTEGER,
  "destinationHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSheetPendingImportDisposition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppSheetLegacySettlement" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "dispositionId" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "sourceRecordHash" TEXT NOT NULL,
  "reconciliationHash" TEXT NOT NULL,
  "mappingHash" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "sourceKeyHash" TEXT NOT NULL,
  "operationOrderId" TEXT NOT NULL,
  "operationOrderMemberId" TEXT NOT NULL,
  "financialBasisHash" TEXT NOT NULL,
  "operationOrderVersion" INTEGER NOT NULL,
  "operationOrderHash" TEXT NOT NULL,
  "orderMappingReviewerId" TEXT NOT NULL,
  "orderMappingEvidenceHash" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "dueMinor" BIGINT NOT NULL,
  "legacyPaidMinor" BIGINT NOT NULL,
  "remainingMinor" BIGINT NOT NULL,
  "paymentRowsHash" TEXT NOT NULL,
  "paymentReferences" JSONB NOT NULL,
  "destinationHash" TEXT NOT NULL,
  "destinationVersion" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'staged',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSheetLegacySettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppSheetPendingImportBatch_snapshotId_mappingId_mappingHash_sourceSpecHash_key"
  ON "AppSheetPendingImportBatch"("snapshotId", "mappingId", "mappingHash", "sourceSpecHash");
CREATE UNIQUE INDEX "AppSheetPendingImportBatch_captureId_manifestHash_mappingId_mappingHash_sourceSpecHash_key"
  ON "AppSheetPendingImportBatch"("captureId", "manifestHash", "mappingId", "mappingHash", "sourceSpecHash");
CREATE INDEX "AppSheetPendingImportBatch_captureId_status_idx"
  ON "AppSheetPendingImportBatch"("captureId", "status");
CREATE UNIQUE INDEX "AppSheetPendingImportDisposition_batchId_sourceRecordId_dimension_key"
  ON "AppSheetPendingImportDisposition"("batchId", "sourceRecordId", "dimension");
CREATE INDEX "AppSheetPendingImportDisposition_sourceRecordId_dimension_state_idx"
  ON "AppSheetPendingImportDisposition"("sourceRecordId", "dimension", "state");
CREATE UNIQUE INDEX "AppSheetLegacySettlement_dispositionId_key"
  ON "AppSheetLegacySettlement"("dispositionId");
CREATE UNIQUE INDEX "AppSheetLegacySettlement_sourceRecordId_key"
  ON "AppSheetLegacySettlement"("sourceRecordId");
CREATE UNIQUE INDEX "AppSheetLegacySettlement_operationOrderId_key"
  ON "AppSheetLegacySettlement"("operationOrderId");
CREATE INDEX "AppSheetLegacySettlement_operationOrderId_status_idx"
  ON "AppSheetLegacySettlement"("operationOrderId", "status");
CREATE INDEX "AppSheetLegacySettlement_captureId_status_idx"
  ON "AppSheetLegacySettlement"("captureId", "status");

ALTER TABLE "AppSheetPendingImportBatch"
  ADD CONSTRAINT "AppSheetPendingImportBatch_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "LegacyImportSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetPendingImportBatch"
  ADD CONSTRAINT "AppSheetPendingImportBatch_captureId_fkey"
  FOREIGN KEY ("captureId") REFERENCES "AppSheetCaptureManifest"("captureId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetPendingImportDisposition"
  ADD CONSTRAINT "AppSheetPendingImportDisposition_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AppSheetPendingImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetPendingImportDisposition"
  ADD CONSTRAINT "AppSheetPendingImportDisposition_sourceRecordId_fkey"
  FOREIGN KEY ("sourceRecordId") REFERENCES "LegacySourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetLegacySettlement"
  ADD CONSTRAINT "AppSheetLegacySettlement_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "AppSheetPendingImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetLegacySettlement"
  ADD CONSTRAINT "AppSheetLegacySettlement_dispositionId_fkey"
  FOREIGN KEY ("dispositionId") REFERENCES "AppSheetPendingImportDisposition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetLegacySettlement"
  ADD CONSTRAINT "AppSheetLegacySettlement_sourceRecordId_fkey"
  FOREIGN KEY ("sourceRecordId") REFERENCES "LegacySourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetLegacySettlement"
  ADD CONSTRAINT "AppSheetLegacySettlement_operationOrderId_fkey"
  FOREIGN KEY ("operationOrderId") REFERENCES "OperationOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSheetLegacySettlement"
  ADD CONSTRAINT "AppSheetLegacySettlement_money_check"
  CHECK ("dueMinor" > 0 AND "legacyPaidMinor" >= 0 AND "remainingMinor" > 0 AND "dueMinor" - "legacyPaidMinor" = "remainingMinor");
ALTER TABLE "AppSheetPendingImportBatch"
  ADD CONSTRAINT "AppSheetPendingImportBatch_target_check"
  CHECK ("target" IN ('isolated-test', 'production'));
