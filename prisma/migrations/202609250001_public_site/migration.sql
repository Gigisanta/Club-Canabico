CREATE TABLE "ShowcaseItem" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShowcaseItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShowcaseItem_slug_key" ON "ShowcaseItem"("slug");
CREATE INDEX "ShowcaseItem_status_sortOrder_createdAt_idx" ON "ShowcaseItem"("status", "sortOrder", "createdAt");

CREATE TABLE "ShowcaseImage" (
    "itemId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShowcaseImage_pkey" PRIMARY KEY ("itemId")
);
ALTER TABLE "ShowcaseImage" ADD CONSTRAINT "ShowcaseImage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ShowcaseItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublicInquiry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "interest" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT NOT NULL DEFAULT '',
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublicInquiry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PublicInquiry_status_createdAt_idx" ON "PublicInquiry"("status", "createdAt");

CREATE TABLE "SiteChannels" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "whatsappPhone" TEXT NOT NULL DEFAULT '',
    "instagramUrl" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteChannels_pkey" PRIMARY KEY ("id")
);
