CREATE TABLE "AppSheetPreorderDraft" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppSheetPreorderDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppSheetPreorderDraft_memberId_updatedAt_id_idx"
  ON "AppSheetPreorderDraft"("memberId", "updatedAt", "id");

ALTER TABLE "AppSheetPreorderDraft"
  ADD CONSTRAINT "AppSheetPreorderDraft_id_fkey"
  FOREIGN KEY ("id") REFERENCES "OperationObject"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AppSheetPreorderDraft"
  ADD CONSTRAINT "AppSheetPreorderDraft_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "OperationMember"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
