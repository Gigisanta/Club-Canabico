DROP INDEX "Expense_date_idx";
DROP INDEX "Expense_date_ownerId_idx";
CREATE INDEX "Expense_date_id_idx" ON "Expense"("date", "id");
CREATE INDEX "Expense_ownerId_date_id_idx" ON "Expense"("ownerId", "date", "id");
