CREATE TABLE "LegacyImportUpload" (
  "snapshotId" TEXT PRIMARY KEY REFERENCES "LegacyImportSnapshot"("id") ON DELETE RESTRICT,
  "manifestHash" TEXT NOT NULL, "manifest" JSONB NOT NULL,
  "expectedRecords" INTEGER NOT NULL CHECK ("expectedRecords" BETWEEN 0 AND 100000),
  "expectedChunks" INTEGER NOT NULL CHECK ("expectedChunks" BETWEEN 0 AND 100000),
  "receivedRecords" INTEGER NOT NULL DEFAULT 0, "receivedBytes" BIGINT NOT NULL DEFAULT 0,
  "cutoverEpoch" INTEGER NOT NULL, "cutoverMode" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3), "quarantinedAt" TIMESTAMP(3)
);
CREATE TABLE "LegacyImportChunk" (
  "snapshotId" TEXT NOT NULL REFERENCES "LegacyImportUpload"("snapshotId") ON DELETE RESTRICT,
  "index" INTEGER NOT NULL CHECK ("index" >= 0), "contentHash" TEXT NOT NULL,
  "recordCount" INTEGER NOT NULL CHECK ("recordCount" BETWEEN 1 AND 500),
  "byteCount" INTEGER NOT NULL CHECK ("byteCount" <= 524288),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("snapshotId", "index")
);
