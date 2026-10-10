ALTER TABLE "OperationAuthority"
  ADD COLUMN "cutoverProfile" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "captureManifestId" TEXT,
  ADD CONSTRAINT "OperationAuthority_cutoverProfile_check"
    CHECK ("cutoverProfile" IN ('legacy', 'appsheet-replacement')),
  ADD CONSTRAINT "OperationAuthority_captureProfile_check"
    CHECK ("cutoverProfile" <> 'appsheet-replacement' OR "captureManifestId" IS NOT NULL);

ALTER TABLE "LegacyImportSnapshot"
  ADD COLUMN "captureManifestId" TEXT;

CREATE TABLE "AppSheetCaptureManifest" (
  "captureId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "spreadsheetId" TEXT NOT NULL,
  "metadataHash" TEXT NOT NULL,
  "headersHash" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "dataHash" TEXT NOT NULL,
  "definitionHash" TEXT,
  "stability" JSONB NOT NULL,
  "firstReadAt" TIMESTAMP(3) NOT NULL,
  "verificationStartedAt" TIMESTAMP(3) NOT NULL,
  "verificationCompletedAt" TIMESTAMP(3) NOT NULL,
  "cutoffAt" TIMESTAMP(3) NOT NULL,
  "dataCoverage" JSONB NOT NULL,
  "pageManifest" JSONB NOT NULL,
  "definitionCoverage" JSONB,
  "dataSheetCount" INTEGER NOT NULL,
  "dataPageCount" INTEGER NOT NULL,
  "dataRecordCount" INTEGER NOT NULL,
  "dataFormulaCount" INTEGER NOT NULL,
  "dataUnresolvedFormulaCount" INTEGER NOT NULL,
  "definitionTableCount" INTEGER,
  "definitionColumnCount" INTEGER,
  "definitionSliceCount" INTEGER,
  "definitionViewCount" INTEGER,
  "definitionActionCount" INTEGER,
  "definitionBotCount" INTEGER,
  "definitionWorkflowRuleCount" INTEGER,
  "definitionFormatRuleCount" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSheetCaptureManifest_pkey" PRIMARY KEY ("captureId"),
  CONSTRAINT "AppSheetCaptureManifest_source_check" CHECK (
    "sourceSystem" = 'appsheet-live-verified' AND
    "sourceId" = "spreadsheetId" AND
    "spreadsheetId" <> '' AND
    "captureId" ~ '^appsreal-[a-f0-9]{16}$'
  ),
  CONSTRAINT "AppSheetCaptureManifest_hashes_check" CHECK (
    "metadataHash" ~ '^[a-f0-9]{64}$' AND
    "headersHash" ~ '^[a-f0-9]{64}$' AND
    "manifestHash" ~ '^[a-f0-9]{64}$' AND
    "dataHash" ~ '^[a-f0-9]{64}$' AND
    ("definitionHash" IS NULL OR "definitionHash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "AppSheetCaptureManifest_timestamps_check" CHECK (
    "firstReadAt" <= "verificationStartedAt" AND
    "verificationStartedAt" <= "verificationCompletedAt" AND
    "verificationCompletedAt" <= "cutoffAt"
  ),
  CONSTRAINT "AppSheetCaptureManifest_counts_check" CHECK (
    "dataSheetCount" >= 0 AND "dataPageCount" >= 0 AND
    "dataRecordCount" >= 0 AND "dataFormulaCount" >= 0 AND
    "dataUnresolvedFormulaCount" >= 0 AND
    ("definitionTableCount" IS NULL OR "definitionTableCount" >= 0) AND
    ("definitionColumnCount" IS NULL OR "definitionColumnCount" >= 0) AND
    ("definitionSliceCount" IS NULL OR "definitionSliceCount" >= 0) AND
    ("definitionViewCount" IS NULL OR "definitionViewCount" >= 0) AND
    ("definitionActionCount" IS NULL OR "definitionActionCount" >= 0) AND
    ("definitionBotCount" IS NULL OR "definitionBotCount" >= 0) AND
    ("definitionWorkflowRuleCount" IS NULL OR "definitionWorkflowRuleCount" >= 0) AND
    ("definitionFormatRuleCount" IS NULL OR "definitionFormatRuleCount" >= 0) AND
    (("definitionHash" IS NULL) = ("definitionCoverage" IS NULL))
  )
);

CREATE UNIQUE INDEX "AppSheetCaptureManifest_sourceSystem_sourceId_manifestHash_key"
  ON "AppSheetCaptureManifest"("sourceSystem", "sourceId", "manifestHash");
CREATE INDEX "AppSheetCaptureManifest_sourceSystem_sourceId_cutoffAt_idx"
  ON "AppSheetCaptureManifest"("sourceSystem", "sourceId", "cutoffAt");
CREATE INDEX "LegacyImportSnapshot_captureManifestId_idx"
  ON "LegacyImportSnapshot"("captureManifestId");
ALTER TABLE "LegacyImportSnapshot"
  ADD CONSTRAINT "LegacyImportSnapshot_captureManifestId_fkey"
    FOREIGN KEY ("captureManifestId") REFERENCES "AppSheetCaptureManifest"("captureId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OperationAuthority"
  ADD CONSTRAINT "OperationAuthority_captureManifestId_fkey"
    FOREIGN KEY ("captureManifestId") REFERENCES "AppSheetCaptureManifest"("captureId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CutoverGate"
  ADD COLUMN "captureManifestId" TEXT,
  ADD CONSTRAINT "CutoverGate_captureManifestId_fkey"
    FOREIGN KEY ("captureManifestId") REFERENCES "AppSheetCaptureManifest"("captureId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "CutoverGate_captureManifestId_idx" ON "CutoverGate"("captureManifestId");

CREATE FUNCTION "preserve_appsheet_capture_manifest"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AppSheet source captures are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "AppSheetCaptureManifest_immutable"
  BEFORE UPDATE OR DELETE ON "AppSheetCaptureManifest"
  FOR EACH ROW EXECUTE FUNCTION "preserve_appsheet_capture_manifest"();
CREATE TRIGGER "AppSheetCaptureManifest_no_truncate"
  BEFORE TRUNCATE ON "AppSheetCaptureManifest"
  FOR EACH STATEMENT EXECUTE FUNCTION "preserve_appsheet_capture_manifest"();

CREATE FUNCTION "preserve_authority_cutover_profile"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."mode" = 'active' AND (
    NEW."cutoverProfile" IS DISTINCT FROM OLD."cutoverProfile" OR
    NEW."captureManifestId" IS DISTINCT FROM OLD."captureManifestId"
  ) THEN
    RAISE EXCEPTION 'Active cutover profile and capture are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OperationAuthority_cutoverProfile_immutable_when_active"
  BEFORE UPDATE ON "OperationAuthority"
  FOR EACH ROW EXECUTE FUNCTION "preserve_authority_cutover_profile"();

ALTER TABLE "LedgerEvent"
  ADD COLUMN "sourceRecordId" TEXT,
  ADD CONSTRAINT "LedgerEvent_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "LegacySourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LedgerEvent_opening_source_only"
    CHECK ("sourceRecordId" IS NULL OR "kind" = 'opening');
CREATE INDEX "LedgerEvent_sourceRecordId_idx" ON "LedgerEvent"("sourceRecordId");

ALTER TABLE "StockFact"
  ADD COLUMN "sourceRecordId" TEXT,
  ADD CONSTRAINT "StockFact_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "LegacySourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StockFact_opening_source_only"
    CHECK ("sourceRecordId" IS NULL OR "kind" = 'opening');
CREATE INDEX "StockFact_sourceRecordId_idx" ON "StockFact"("sourceRecordId");

CREATE FUNCTION "preserve_legacy_snapshot_capture_link"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','reviewedBy','reviewedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','reviewedBy','reviewedAt']) THEN
    RAISE EXCEPTION 'Snapshot source and capture linkage are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LegacyImportSnapshot_source_capture_immutable"
  BEFORE UPDATE ON "LegacyImportSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "preserve_legacy_snapshot_capture_link"();
