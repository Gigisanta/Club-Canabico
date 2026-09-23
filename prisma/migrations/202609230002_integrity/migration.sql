-- Monetary values are cents, quantities are thousandths of the displayed unit.
ALTER TABLE "Product" ADD CONSTRAINT "product_nonnegative" CHECK ("stock" >= 0 AND "minimum" >= 0 AND "cost" >= 0 AND "price" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "product_whole_units" CHECK ("unit" <> 'ud' OR ("stock" % 1000 = 0 AND "minimum" % 1000 = 0));
ALTER TABLE "Customer" ADD CONSTRAINT "customer_points_nonnegative" CHECK ("points" >= 0);
ALTER TABLE "Sale" ADD CONSTRAINT "sale_amounts_consistent" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "total" = "subtotal" - "discount" AND "total" >= 0 AND "cost" >= 0 AND "pointsEarned" >= 0 AND "pointsUsed" >= 0);
ALTER TABLE "SaleItem" ADD CONSTRAINT "sale_item_amounts_valid" CHECK ("quantity" > 0 AND "price" >= 0 AND "cost" >= 0 AND "revenue" >= 0);
ALTER TABLE "Movement" ADD CONSTRAINT "movement_balance_valid" CHECK ("beforeStock" >= 0 AND "afterStock" >= 0 AND "quantity" = "afterStock" - "beforeStock");
ALTER TABLE "Expense" ADD CONSTRAINT "expense_positive" CHECK ("amount" > 0);
ALTER TABLE "Closure" ADD CONSTRAINT "closure_amounts_consistent" CHECK ("expected" >= 0 AND "counted" >= 0 AND "difference" = "counted" - "expected");
