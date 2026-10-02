-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "authorizationEpoch" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "OperationAuthority" (
    "id" TEXT NOT NULL DEFAULT 'operations',
    "mode" TEXT NOT NULL DEFAULT 'shadow',
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "firstRealWriteAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "evidence" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationObject" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandReceipt" (
    "requestId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "resultingVersion" INTEGER NOT NULL,
    "authorityEpoch" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "OperationOutbox" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OperationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationAudit" (
    "id" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "requestId" TEXT,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationAccess" (
    "userId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationAccess_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "OperationSession" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "authorizationEpoch" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationDevice" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageCertified" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineLease" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "authorizationEpoch" INTEGER NOT NULL,
    "authorityEpoch" INTEGER NOT NULL,
    "assignments" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineBackup" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "package" JSONB NOT NULL,
    "recoveredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineBackup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineQuarantine" (
    "requestId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "targetId" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedBy" TEXT,
    "resolutionRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineQuarantine_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "OfflineRecovery" (
    "id" UUID NOT NULL,
    "backupId" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "OfflineRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationMember" (
    "id" TEXT NOT NULL,
    "legacyCustomerId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "address" JSONB NOT NULL,
    "preferences" JSONB NOT NULL,
    "sourceSystem" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberClinicalRecord" (
    "memberId" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "encryptedObjectKey" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'unverified',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "MemberClinicalRecord_pkey" PRIMARY KEY ("memberId")
);

-- CreateTable
CREATE TABLE "MemberPermission" (
    "id" UUID NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "validFrom" TEXT,
    "validUntil" TEXT,
    "evidenceDocumentId" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "MemberPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationDocument" (
    "id" UUID NOT NULL,
    "memberId" TEXT,
    "orderId" TEXT,
    "deliveryId" TEXT,
    "kind" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'referenced',
    "objectKey" TEXT,
    "checksum" TEXT,
    "objectVersion" TEXT,
    "mediaType" TEXT,
    "bytes" INTEGER,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "validUntil" TEXT,
    "metadata" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAuthorization" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedBy" TEXT NOT NULL,

    CONSTRAINT "DocumentAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSku" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variety" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "minQuantity" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "minVarieties" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "CatalogSku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePolicy" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "validFrom" TEXT NOT NULL,
    "validUntil" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "PricePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialPack" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "components" JSONB NOT NULL,
    "allocationWeights" JSONB NOT NULL,
    "validFrom" TEXT NOT NULL,
    "validUntil" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "CommercialPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialPromotion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "validFrom" TEXT NOT NULL,
    "validUntil" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "CommercialPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "responsibleId" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "links" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "OperationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "agreementDate" TEXT NOT NULL,
    "expectedDate" TEXT,
    "currency" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "items" JSONB NOT NULL,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "receivedDate" TEXT NOT NULL,
    "receivedBy" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "receiptId" TEXT,
    "purchaseLineId" TEXT,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitCost" DECIMAL(38,12) NOT NULL,
    "costCurrency" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "expiresOn" TEXT,
    "legacyProductId" TEXT,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "custodianId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "reserved" DECIMAL(38,12) NOT NULL DEFAULT 0,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "balanceId" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "consumed" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockFact" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "lotId" TEXT NOT NULL,
    "orderId" TEXT,
    "lineId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "unit" TEXT NOT NULL,
    "fromLocationId" TEXT,
    "toLocationId" TEXT,
    "fromCustodianId" TEXT,
    "toCustodianId" TEXT,
    "costMinor" BIGINT,
    "currency" TEXT,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationOrder" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "commercialState" TEXT NOT NULL DEFAULT 'draft',
    "quote" JSONB NOT NULL,
    "quoteVersion" INTEGER NOT NULL DEFAULT 0,
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "deliveryMinor" BIGINT NOT NULL DEFAULT 0,
    "surchargeMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "verifiedMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    "fulfillmentState" TEXT NOT NULL DEFAULT 'unprepared',
    "financialState" TEXT NOT NULL DEFAULT 'unpaid',
    "address" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacySaleId" TEXT,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "OperationOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "requested" DECIMAL(38,12) NOT NULL,
    "prepared" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "delivered" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "cancelled" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "returned" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "extra" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(38,12) NOT NULL,
    "referenceMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "revenueMinor" BIGINT NOT NULL,
    "costMinor" BIGINT NOT NULL DEFAULT 0,
    "policyId" TEXT,
    "policyVersion" INTEGER,
    "packId" TEXT,
    "packCount" INTEGER,

    CONSTRAINT "OperationOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreparationAllocation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "balanceId" TEXT NOT NULL,
    "requestedQuantity" DECIMAL(38,12) NOT NULL,
    "actualQuantity" DECIMAL(38,12) NOT NULL,
    "deliveredQuantity" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "returnedQuantity" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "costMinor" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'prepared',

    CONSTRAINT "PreparationAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "routeId" TEXT,
    "driverId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stopSequence" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TEXT,
    "windowEnd" TEXT,
    "address" JSONB NOT NULL,
    "eta" TEXT,
    "etaIsEstimate" BOOLEAN NOT NULL DEFAULT true,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "incidents" JSONB NOT NULL,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRoute" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "shiftDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "custodianAccountId" TEXT,
    "remunerationMinor" BIGINT NOT NULL DEFAULT 0,
    "remunerationCurrency" TEXT NOT NULL DEFAULT 'ARS',
    "remunerationApprovedBy" TEXT,
    "closedWithPending" BOOLEAN NOT NULL DEFAULT false,
    "exportBackupId" TEXT,

    CONSTRAINT "DeliveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionReport" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "reporterId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "accountId" TEXT,
    "custodianId" TEXT,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reported',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "appliedMinor" BIGINT NOT NULL DEFAULT 0,
    "excessMinor" BIGINT NOT NULL DEFAULT 0,
    "exchangeRate" DECIMAL(38,12),

    CONSTRAINT "CollectionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberCredit" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "resolvedMinor" BIGINT NOT NULL DEFAULT 0,
    "treatment" TEXT NOT NULL,

    CONSTRAINT "MemberCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rendition" (
    "id" TEXT NOT NULL,
    "routeId" TEXT,
    "driverId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "deliveredMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL DEFAULT 'gross',
    "acceptedBy" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rendition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "custodianId" TEXT,
    "openingMinor" BIGINT NOT NULL DEFAULT 0,
    "openingApprovedBy" TEXT,
    "openingEvidence" JSONB,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "OperationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceObjectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "LedgerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerLeg" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,

    CONSTRAINT "LedgerLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountReconciliation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "calculatedMinor" BIGINT NOT NULL,
    "countedMinor" BIGINT NOT NULL,
    "differenceMinor" BIGINT NOT NULL,
    "evidence" JSONB NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationPayable" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT,
    "beneficiaryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "dueDate" TEXT NOT NULL,
    "accrualPeriod" TEXT,
    "evidence" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "sourceSystem" TEXT,
    "sourceId" TEXT,

    CONSTRAINT "OperationPayable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayablePayment" (
    "id" TEXT NOT NULL,
    "payableId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "appliedMinor" BIGINT NOT NULL,
    "exchangeRate" DECIMAL(38,12),
    "date" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "PayablePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyImportSnapshot" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "importerVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "createdBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "controls" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyImportSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacySourceRecord" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "importerVersion" TEXT NOT NULL,
    "original" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "treatment" TEXT NOT NULL,
    "resolution" JSONB,

    CONSTRAINT "LegacySourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyIdentity" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "approvedBy" TEXT,

    CONSTRAINT "LegacyIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyException" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "sourceRecordId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" JSONB,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "LegacyException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutoverGate" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidence" JSONB,
    "approvedBy" TEXT,
    "reviewedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "CutoverGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationObject_kind_updatedAt_idx" ON "OperationObject"("kind", "updatedAt");

-- CreateIndex
CREATE INDEX "CommandReceipt_actorId_committedAt_idx" ON "CommandReceipt"("actorId", "committedAt");

-- CreateIndex
CREATE INDEX "CommandReceipt_targetId_committedAt_idx" ON "CommandReceipt"("targetId", "committedAt");

-- CreateIndex
CREATE INDEX "OperationOutbox_status_createdAt_idx" ON "OperationOutbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationAudit_objectId_createdAt_idx" ON "OperationAudit"("objectId", "createdAt");

-- CreateIndex
CREATE INDEX "OperationSession_userId_expiresAt_idx" ON "OperationSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "OperationDevice_userId_idx" ON "OperationDevice"("userId");

-- CreateIndex
CREATE INDEX "OfflineLease_userId_expiresAt_idx" ON "OfflineLease"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineBackup_userId_deviceId_sha256_key" ON "OfflineBackup"("userId", "deviceId", "sha256");

-- CreateIndex
CREATE INDEX "OfflineQuarantine_userId_createdAt_idx" ON "OfflineQuarantine"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationMember_legacyCustomerId_key" ON "OperationMember"("legacyCustomerId");

-- CreateIndex
CREATE INDEX "OperationMember_name_id_idx" ON "OperationMember"("name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OperationMember_sourceSystem_sourceId_key" ON "OperationMember"("sourceSystem", "sourceId");

-- CreateIndex
CREATE INDEX "MemberPermission_memberId_kind_status_idx" ON "MemberPermission"("memberId", "kind", "status");

-- CreateIndex
CREATE INDEX "OperationDocument_memberId_kind_idx" ON "OperationDocument"("memberId", "kind");

-- CreateIndex
CREATE INDEX "OperationDocument_deliveryId_idx" ON "OperationDocument"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAuthorization_documentId_userId_key" ON "DocumentAuthorization"("documentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_id_version_key" ON "DocumentTemplate"("id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSku_code_key" ON "CatalogSku"("code");

-- CreateIndex
CREATE INDEX "CatalogSku_category_active_idx" ON "CatalogSku"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSku_sourceSystem_sourceId_key" ON "CatalogSku"("sourceSystem", "sourceId");

-- CreateIndex
CREATE INDEX "PricePolicy_status_validFrom_idx" ON "PricePolicy"("status", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_sourceSystem_sourceId_key" ON "PurchaseOrder"("sourceSystem", "sourceId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_purchaseId_idx" ON "GoodsReceipt"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_legacyProductId_key" ON "InventoryLot"("legacyProductId");

-- CreateIndex
CREATE INDEX "InventoryLot_skuId_receivedAt_id_idx" ON "InventoryLot"("skuId", "receivedAt", "id");

-- CreateIndex
CREATE INDEX "InventoryLot_label_idx" ON "InventoryLot"("label");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_sourceSystem_sourceId_key" ON "InventoryLot"("sourceSystem", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_lotId_locationId_custodianId_key" ON "StockBalance"("lotId", "locationId", "custodianId");

-- CreateIndex
CREATE INDEX "StockReservation_orderId_status_idx" ON "StockReservation"("orderId", "status");

-- CreateIndex
CREATE INDEX "StockReservation_balanceId_status_idx" ON "StockReservation"("balanceId", "status");

-- CreateIndex
CREATE INDEX "StockFact_lotId_occurredAt_idx" ON "StockFact"("lotId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockFact_orderId_idx" ON "StockFact"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationOrder_legacySaleId_key" ON "OperationOrder"("legacySaleId");

-- CreateIndex
CREATE INDEX "OperationOrder_commercialState_createdAt_idx" ON "OperationOrder"("commercialState", "createdAt");

-- CreateIndex
CREATE INDEX "OperationOrder_memberId_createdAt_idx" ON "OperationOrder"("memberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationOrder_sourceSystem_sourceId_key" ON "OperationOrder"("sourceSystem", "sourceId");

-- CreateIndex
CREATE INDEX "OperationOrderLine_orderId_idx" ON "OperationOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "PreparationAllocation_orderId_state_idx" ON "PreparationAllocation"("orderId", "state");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_driverId_status_idx" ON "DeliveryAssignment"("driverId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_routeId_stopSequence_idx" ON "DeliveryAssignment"("routeId", "stopSequence");

-- CreateIndex
CREATE INDEX "DeliveryRoute_driverId_shiftDate_idx" ON "DeliveryRoute"("driverId", "shiftDate");

-- CreateIndex
CREATE INDEX "CollectionReport_orderId_status_idx" ON "CollectionReport"("orderId", "status");

-- CreateIndex
CREATE INDEX "CollectionReport_custodianId_status_idx" ON "CollectionReport"("custodianId", "status");

-- CreateIndex
CREATE INDEX "OperationAccount_currency_kind_idx" ON "OperationAccount"("currency", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "OperationAccount_sourceSystem_sourceId_key" ON "OperationAccount"("sourceSystem", "sourceId");

-- CreateIndex
CREATE INDEX "LedgerEvent_kind_occurredAt_idx" ON "LedgerEvent"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerEvent_sourceObjectId_idx" ON "LedgerEvent"("sourceObjectId");

-- CreateIndex
CREATE INDEX "LedgerLeg_accountId_eventId_idx" ON "LedgerLeg"("accountId", "eventId");

-- CreateIndex
CREATE INDEX "OperationPayable_dueDate_verified_idx" ON "OperationPayable"("dueDate", "verified");

-- CreateIndex
CREATE UNIQUE INDEX "OperationPayable_sourceSystem_sourceId_key" ON "OperationPayable"("sourceSystem", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyImportSnapshot_sourceSystem_fileHash_importerVersion_key" ON "LegacyImportSnapshot"("sourceSystem", "fileHash", "importerVersion");

-- CreateIndex
CREATE INDEX "LegacySourceRecord_sourceTable_sourceKey_idx" ON "LegacySourceRecord"("sourceTable", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "LegacySourceRecord_snapshotId_sourceTable_sourceRow_key" ON "LegacySourceRecord"("snapshotId", "sourceTable", "sourceRow");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyIdentity_sourceSystem_sourceTable_sourceKey_destinati_key" ON "LegacyIdentity"("sourceSystem", "sourceTable", "sourceKey", "destinationType");

-- CreateIndex
CREATE INDEX "LegacyException_snapshotId_status_idx" ON "LegacyException"("snapshotId", "status");

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "CatalogSku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "InventoryLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationOrderLine" ADD CONSTRAINT "OperationOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OperationOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLeg" ADD CONSTRAINT "LedgerLeg_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "LedgerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLeg" ADD CONSTRAINT "LedgerLeg_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OperationAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_nonnegative" CHECK (quantity >= 0 AND reserved >= 0 AND reserved <= quantity);
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantities" CHECK (quantity >= 0 AND consumed >= 0 AND consumed <= quantity);
ALTER TABLE "OperationOrder" ADD CONSTRAINT "OperationOrder_money" CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "discountMinor" <= "subtotalMinor" AND "totalMinor" >= 0 AND "verifiedMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "verifiedMinor");
ALTER TABLE "OperationOrderLine" ADD CONSTRAINT "OperationOrderLine_quantities" CHECK (requested > 0 AND prepared >= 0 AND delivered >= 0 AND returned >= 0 AND cancelled >= 0 AND extra >= 0 AND returned <= delivered AND delivered <= prepared);
ALTER TABLE "OperationAccount" ADD CONSTRAINT "OperationAccount_currency" CHECK (currency IN ('ARS','USD'));
ALTER TABLE "OperationPayable" ADD CONSTRAINT "OperationPayable_money" CHECK ("amountMinor" >= 0 AND "paidMinor" >= 0 AND "paidMinor" <= "amountMinor");
