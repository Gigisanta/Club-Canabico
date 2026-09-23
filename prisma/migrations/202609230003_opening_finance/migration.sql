ALTER TABLE "Product" ADD COLUMN "supplier" TEXT NOT NULL DEFAULT '', ADD COLUMN "sourceSystem" TEXT, ADD COLUMN "sourceId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "permitStatus" TEXT NOT NULL DEFAULT 'unverified', ADD COLUMN "permitValidUntil" TEXT, ADD COLUMN "permitCheckedAt" TIMESTAMP(3), ADD COLUMN "sourceSystem" TEXT, ADD COLUMN "sourceId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'local';
CREATE UNIQUE INDEX "Product_sourceSystem_sourceId_key" ON "Product"("sourceSystem", "sourceId");
CREATE UNIQUE INDEX "Customer_sourceSystem_sourceId_key" ON "Customer"("sourceSystem", "sourceId");
CREATE TABLE "CashEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "date" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "sourceSystem" TEXT,
  "sourceId" TEXT,
  "saleId" TEXT,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CashEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CashEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashEntry_sourceSystem_sourceId_key" ON "CashEntry"("sourceSystem", "sourceId");
CREATE UNIQUE INDEX "CashEntry_saleId_key" ON "CashEntry"("saleId");
CREATE INDEX "CashEntry_date_account_idx" ON "CashEntry"("date", "account");
INSERT INTO "CashEntry" ("id", "date", "account", "category", "amount", "description", "saleId", "userId")
SELECT concat('legacy-sale-', "id"), "date", CASE WHEN "payment" = 'cash' THEN 'cash' ELSE 'bank' END, 'sale', "total", 'Venta histórica migrada', "id", "userId" FROM "Sale";
CREATE TABLE "CashPlan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "date" TEXT NOT NULL,
  "scenario" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CashPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CashPlan_date_scenario_idx" ON "CashPlan"("date", "scenario");
