ALTER TABLE "HistoricalPurchaseReceipt"
  ADD COLUMN "orderDate" DATE;

ALTER TABLE "HistoricalPurchaseReceipt"
  ADD CONSTRAINT "HistoricalPurchaseReceipt_orderDate_check"
  CHECK ("orderDate" IS NULL OR "orderDate" <= "receivedDate");

CREATE INDEX "HistoricalPurchaseReceipt_supplierSourceId_orderDate_idx"
  ON "HistoricalPurchaseReceipt"("supplierSourceId", "orderDate");
