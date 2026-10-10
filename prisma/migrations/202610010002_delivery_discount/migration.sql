ALTER TABLE "OperationOrder" ADD COLUMN "deliveryDiscountMinor" BIGINT NOT NULL DEFAULT 0;

-- Preserve an already frozen benefit if an unreleased checkout had produced it.
-- Invalid or out-of-range source values must fail rather than be silently cast.
UPDATE "OperationOrder"
SET "deliveryDiscountMinor" = ("quote" ->> 'deliveryDiscountMinor')::BIGINT
WHERE "quote" ? 'deliveryDiscountMinor';

ALTER TABLE "OperationOrder" ADD CONSTRAINT "OperationOrder_deliveryDiscount_range"
CHECK ("deliveryDiscountMinor" >= 0 AND "deliveryDiscountMinor" <= "deliveryMinor");
