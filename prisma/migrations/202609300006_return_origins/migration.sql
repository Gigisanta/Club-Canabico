-- AlterTable
ALTER TABLE "OperationOrderLine" ADD COLUMN     "costCoverage" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "costCurrency" TEXT;

-- AlterTable
ALTER TABLE "PreparationAllocation" ADD COLUMN     "returnedDeliveredQuantity" DECIMAL(38,12) NOT NULL DEFAULT 0;

ALTER TABLE "PreparationAllocation" ADD CONSTRAINT "PreparationAllocation_return_origin_bounds" CHECK ("returnedDeliveredQuantity" >= 0 AND "returnedDeliveredQuantity" <= "returnedQuantity" AND "returnedDeliveredQuantity" <= "deliveredQuantity" AND "returnedQuantity" - "returnedDeliveredQuantity" <= "actualQuantity" - "deliveredQuantity");
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_resolved_bounds" CHECK ("resolvedMinor" >= 0 AND "resolvedMinor" <= "amountMinor");
