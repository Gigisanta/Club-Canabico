-- Keep AppSheet-only catalogue fields separate from the stock SKU identity.
ALTER TABLE "CatalogSku" ADD COLUMN "appSheet" JSONB;
