ALTER TABLE "SaleItem" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'g';
UPDATE "SaleItem" AS item SET "unit" = product."unit"
FROM "Product" AS product WHERE item."productId" = product."id";
