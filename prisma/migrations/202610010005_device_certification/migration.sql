ALTER TABLE "OperationDevice" ADD COLUMN "storageCertifiedAt" TIMESTAMP(3);
-- Existing flags do not establish when a device passed the storage/restart journey.
