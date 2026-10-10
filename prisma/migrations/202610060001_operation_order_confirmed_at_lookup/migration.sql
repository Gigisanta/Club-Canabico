-- Match product-contribution reports by commercial state and confirmation date.
CREATE INDEX "OperationOrder_commercialState_confirmedAt_idx"
ON "OperationOrder"("commercialState", "confirmedAt");
