CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Location_key_key" ON "Location"("key");
CREATE UNIQUE INDEX "Location_one_default" ON "Location"("isDefault") WHERE "isDefault" = true;
CREATE INDEX "Location_active_name_idx" ON "Location"("active", "name");
ALTER TABLE "Product" ADD COLUMN "locationId" TEXT;

INSERT INTO "Location" ("id", "name", "key")
SELECT md5('location:' || normalized.key), MIN(normalized.name), normalized.key
FROM (
    SELECT btrim(regexp_replace("location", '[[:space:]]+', ' ', 'g')) AS name,
           lower(btrim(regexp_replace("location", '[[:space:]]+', ' ', 'g'))) AS key
    FROM "Product"
    WHERE btrim("location") <> ''
) normalized
GROUP BY normalized.key;

UPDATE "Product" p SET "locationId" = l.id, "location" = l.name
FROM "Location" l
WHERE lower(btrim(regexp_replace(p."location", '[[:space:]]+', ' ', 'g'))) = l.key;

CREATE INDEX "Product_locationId_idx" ON "Product"("locationId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_locationId_fkey"
FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
