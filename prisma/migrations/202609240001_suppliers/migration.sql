CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Supplier_key_key" ON "Supplier"("key");
CREATE UNIQUE INDEX "Supplier_one_default" ON "Supplier"("isDefault") WHERE "isDefault" = true;
CREATE INDEX "Supplier_active_name_idx" ON "Supplier"("active", "name");
ALTER TABLE "Product" ADD COLUMN "supplierId" TEXT;

INSERT INTO "Supplier" ("id", "name", "key")
SELECT md5('supplier:' || normalized.key), MIN(normalized.name), normalized.key
FROM (
    SELECT btrim(regexp_replace("supplier", '[[:space:]]+', ' ', 'g')) AS name,
           lower(btrim(regexp_replace("supplier", '[[:space:]]+', ' ', 'g'))) AS key
    FROM "Product"
    WHERE btrim("supplier") <> ''
) normalized
GROUP BY normalized.key;

UPDATE "Product" p SET "supplierId" = s.id
FROM "Supplier" s
WHERE lower(btrim(regexp_replace(p."supplier", '[[:space:]]+', ' ', 'g'))) = s.key;

CREATE INDEX "Product_supplierId_idx" ON "Product"("supplierId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey"
FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
