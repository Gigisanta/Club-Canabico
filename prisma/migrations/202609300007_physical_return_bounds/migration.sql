-- returned/prepared are physical quantities; delivered/cancelled are billed quantities.
-- An undelivered parcel may return before any billed quantity has been delivered.
ALTER TABLE "OperationOrderLine" DROP CONSTRAINT "OperationOrderLine_quantities";
ALTER TABLE "OperationOrderLine" ADD CONSTRAINT "OperationOrderLine_quantities" CHECK (
  requested > 0 AND prepared >= 0 AND delivered >= 0 AND returned >= 0
  AND cancelled >= 0 AND extra >= 0 AND returned <= prepared
  AND delivered + cancelled <= requested
);
