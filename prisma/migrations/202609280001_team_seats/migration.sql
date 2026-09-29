CREATE TABLE "TeamSeat" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "email" TEXT,
  "tokenHash" TEXT,
  "expiresAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamSeat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamSeat_email_key" ON "TeamSeat"("email");
CREATE UNIQUE INDEX "TeamSeat_tokenHash_key" ON "TeamSeat"("tokenHash");
