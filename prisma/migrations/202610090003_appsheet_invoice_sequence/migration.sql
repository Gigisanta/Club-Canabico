CREATE TABLE "AppSheetInvoiceSequence" (
  "namespace" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "dataHash" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "mappingId" TEXT NOT NULL,
  "publicationFingerprint" TEXT NOT NULL,
  "sourceBindingHash" TEXT NOT NULL,
  "lastValue" BIGINT NOT NULL,
  "seededValue" BIGINT NOT NULL,
  "invoiceRecordCount" INTEGER NOT NULL,
  "numberedInvoiceCount" INTEGER NOT NULL,
  "unnumberedInvoiceCount" INTEGER NOT NULL,
  "duplicateInvoiceNumberCount" INTEGER NOT NULL,
  "duplicateHiddenIdCount" INTEGER NOT NULL,
  "seedEvidence" JSONB NOT NULL,
  "seededBy" TEXT NOT NULL,
  "seededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppSheetInvoiceSequence_pkey" PRIMARY KEY ("namespace"),
  CONSTRAINT "AppSheetInvoiceSequence_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "AppSheetCaptureManifest"("captureId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AppSheetInvoiceSequence_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "LegacyImportSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AppSheetInvoiceSequence_namespace_capture_check" CHECK ("namespace" = "captureId"),
  CONSTRAINT "AppSheetInvoiceSequence_hash_check" CHECK ("manifestHash" ~ '^[a-f0-9]{64}$' AND "dataHash" ~ '^[a-f0-9]{64}$' AND "publicationFingerprint" ~ '^[a-f0-9]{64}$' AND "sourceBindingHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AppSheetInvoiceSequence_values_check" CHECK ("lastValue" >= "seededValue" AND "seededValue" >= 0 AND "invoiceRecordCount" >= 0 AND "numberedInvoiceCount" >= 0 AND "unnumberedInvoiceCount" >= 0 AND "duplicateInvoiceNumberCount" >= 0 AND "duplicateHiddenIdCount" >= 0 AND "numberedInvoiceCount" + "unnumberedInvoiceCount" = "invoiceRecordCount" AND "duplicateInvoiceNumberCount" <= "numberedInvoiceCount" AND "duplicateHiddenIdCount" <= "invoiceRecordCount")
);

CREATE UNIQUE INDEX "AppSheetInvoiceSequence_captureId_key" ON "AppSheetInvoiceSequence"("captureId");
CREATE UNIQUE INDEX "AppSheetInvoiceSequence_namespace_captureId_manifestHash_key" ON "AppSheetInvoiceSequence"("namespace", "captureId", "manifestHash");
CREATE INDEX "AppSheetInvoiceSequence_captureId_manifestHash_idx" ON "AppSheetInvoiceSequence"("captureId", "manifestHash");

CREATE TABLE "AppSheetInvoiceNumberReservation" (
  "id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "orderId" TEXT,
  "sourceReferenceCount" INTEGER NOT NULL DEFAULT 0,
  "sourceReferences" JSONB NOT NULL,
  "generatedId" BIGINT,
  "generatedYear" INTEGER,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSheetInvoiceNumberReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppSheetInvoiceNumberReservation_sequence_fkey" FOREIGN KEY ("namespace", "captureId", "manifestHash") REFERENCES "AppSheetInvoiceSequence"("namespace", "captureId", "manifestHash") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AppSheetInvoiceNumberReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OperationOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AppSheetInvoiceNumberReservation_origin_check" CHECK (
    ("origin" = 'historical' AND "orderId" IS NULL AND "sourceReferenceCount" > 0 AND "generatedId" IS NULL AND "generatedYear" IS NULL AND "createdBy" IS NULL)
    OR ("origin" = 'bombo' AND "orderId" IS NOT NULL AND "sourceReferenceCount" = 0 AND "generatedId" > 0 AND "generatedYear" BETWEEN 1 AND 9999 AND "createdBy" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AppSheetInvoiceNumberReservation_invoiceNumber_key" ON "AppSheetInvoiceNumberReservation"("invoiceNumber");
CREATE UNIQUE INDEX "AppSheetInvoiceNumberReservation_orderId_key" ON "AppSheetInvoiceNumberReservation"("orderId");
CREATE INDEX "AppSheetInvoiceNumberReservation_captureId_origin_idx" ON "AppSheetInvoiceNumberReservation"("captureId", "origin");
