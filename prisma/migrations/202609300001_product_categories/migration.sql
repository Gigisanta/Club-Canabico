-- Commercial category of a lot (for example "Interior Premium") and the minimum number of distinct varieties
-- the club wants in stock for it. A variety is a product name; several lots of the same name count once.
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "minVarieties" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_category_min_varieties" CHECK ("minVarieties" >= 0 AND "minVarieties" <= 500)
);
CREATE UNIQUE INDEX "ProductCategory_key_key" ON "ProductCategory"("key");
CREATE INDEX "ProductCategory_active_name_idx" ON "ProductCategory"("active", "name");
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
