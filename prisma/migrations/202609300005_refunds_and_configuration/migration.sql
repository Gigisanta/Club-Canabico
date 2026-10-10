-- AlterTable
ALTER TABLE "OperationOrder" ADD COLUMN     "refundedDeliveryMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "refundedSurchargeMinor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OperationOrderLine" ADD COLUMN     "refundedMinor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OperationalConfiguration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'proposed',
    "definition" JSONB NOT NULL,
    "validFrom" TEXT NOT NULL,
    "validUntil" TEXT,
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalConfiguration_kind_state_validFrom_idx" ON "OperationalConfiguration"("kind", "state", "validFrom");

ALTER TABLE "OperationOrderLine" ADD CONSTRAINT "OperationOrderLine_refund_bound" CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= "revenueMinor");
ALTER TABLE "OperationOrder" ADD CONSTRAINT "OperationOrder_refund_components" CHECK ("refundedDeliveryMinor" >= 0 AND "refundedDeliveryMinor" <= "deliveryMinor" AND "refundedSurchargeMinor" >= 0 AND "refundedSurchargeMinor" <= "surchargeMinor");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalConfiguration_name_version_key" ON "OperationalConfiguration"("name", "version");
