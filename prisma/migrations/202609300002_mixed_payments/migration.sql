-- A sale paid partly in cash and partly by transfer or card records one cash entry per account.
-- The unique index keeps it at one entry per sale and account.
DROP INDEX "CashEntry_saleId_key";
CREATE UNIQUE INDEX "CashEntry_saleId_account_key" ON "CashEntry"("saleId", "account");
ALTER TABLE "Sale" ADD COLUMN "paymentSplit" JSONB;
