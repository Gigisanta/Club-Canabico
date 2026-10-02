CREATE TABLE "LegacyHistoricalFact" (
 "id" TEXT PRIMARY KEY,
 "snapshotId" TEXT NOT NULL REFERENCES "LegacyImportSnapshot"("id") ON DELETE RESTRICT,
 "sourceRecordId" TEXT NOT NULL REFERENCES "LegacySourceRecord"("id") ON DELETE RESTRICT,
 "sourceTable" TEXT NOT NULL, "sourceKey" TEXT NOT NULL, "sourceRow" INTEGER NOT NULL,
 "sourceHash" TEXT NOT NULL, "mappingId" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "occurredOn" TEXT, "dateState" TEXT NOT NULL,
 "currency" TEXT, "currencyState" TEXT NOT NULL,
 "unit" TEXT, "unitState" TEXT NOT NULL,
 "amountMinor" BIGINT, "amountState" TEXT NOT NULL,
 "quantity" DECIMAL(38,12), "quantityState" TEXT NOT NULL,
 "attributes" JSONB NOT NULL,
 "correctionOf" TEXT UNIQUE REFERENCES "LegacyHistoricalFact"("id") ON DELETE RESTRICT,
 "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LegacyHistoricalFact_states" CHECK (
   "dateState" IN ('known','absent','invalid','not-applicable') AND
   "currencyState" IN ('known','absent','invalid','not-applicable') AND
   "unitState" IN ('known','absent','invalid','not-applicable') AND
   "amountState" IN ('known','absent','invalid','not-applicable') AND
   "quantityState" IN ('known','absent','invalid','not-applicable')),
 CONSTRAINT "LegacyHistoricalFact_known_values" CHECK (
   ("dateState" = 'known') = ("occurredOn" IS NOT NULL) AND
   ("currencyState" = 'known') = ("currency" IS NOT NULL) AND
   ("unitState" = 'known') = ("unit" IS NOT NULL) AND
   ("amountState" = 'known') = ("amountMinor" IS NOT NULL) AND
   ("quantityState" = 'known') = ("quantity" IS NOT NULL))
);
CREATE INDEX "LegacyHistoricalFact_snapshotId_sourceRecordId_mappingId_idx" ON "LegacyHistoricalFact"("snapshotId","sourceRecordId","mappingId");
CREATE UNIQUE INDEX "LegacyHistoricalFact_original_projection_key" ON "LegacyHistoricalFact"("snapshotId","sourceRecordId","mappingId") WHERE "correctionOf" IS NULL;
CREATE INDEX "LegacyHistoricalFact_snapshotId_kind_occurredOn_id_idx" ON "LegacyHistoricalFact"("snapshotId","kind","occurredOn","id");
CREATE INDEX "LegacyHistoricalFact_sourceTable_sourceKey_idx" ON "LegacyHistoricalFact"("sourceTable","sourceKey");
CREATE FUNCTION "preserve_legacy_historical_fact"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Historical facts are append-only; record a correction' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "LegacyHistoricalFact_immutable" BEFORE UPDATE OR DELETE ON "LegacyHistoricalFact" FOR EACH ROW EXECUTE FUNCTION "preserve_legacy_historical_fact"();
CREATE FUNCTION "preserve_legacy_source_record"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
   RAISE EXCEPTION 'Source evidence cannot be deleted' USING ERRCODE = '23514';
 END IF;
 IF (to_jsonb(NEW) - 'resolution') IS DISTINCT FROM (to_jsonb(OLD) - 'resolution') THEN
   RAISE EXCEPTION 'Source evidence is immutable; resolutions are separate' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "LegacySourceRecord_immutable" BEFORE UPDATE OR DELETE ON "LegacySourceRecord" FOR EACH ROW EXECUTE FUNCTION "preserve_legacy_source_record"();
CREATE TABLE "LegacyHistoryPublication" (
 "sourceSystem" TEXT PRIMARY KEY,
 "snapshotId" TEXT NOT NULL REFERENCES "LegacyImportSnapshot"("id") ON DELETE RESTRICT,
 "fileHash" TEXT NOT NULL, "mappingId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "publishedBy" TEXT NOT NULL, "evidence" JSONB NOT NULL,
 "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
