-- Contact email is optional; login usernames are explicit, canonical identities.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_username_canonical"
  CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9][a-z0-9._-]{1,31}$');
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
