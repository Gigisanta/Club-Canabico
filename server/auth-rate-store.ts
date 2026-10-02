import { createHmac } from "node:crypto";
import type { Store, Options } from "express-rate-limit";
import { db } from "./db.js";

/** Shared across instances and restarts; IP identifiers are keyed hashes, never stored in clear. */
export class AuthRateStore implements Store {
  localKeys = false;
  private windowMs = 900_000;
  constructor(public prefix: string) {}
  init(options: Options) { this.windowMs = options.windowMs; }
  private key(value: string) {
    return createHmac("sha256", process.env.JWT_SECRET!).update(this.prefix + "\0" + value).digest("hex");
  }
  async increment(value: string) {
    const key = this.key(value), until = new Date(Date.now() + this.windowMs);
    const [row] = await db.$queryRaw<Array<{ hits: number; expiresAt: Date }>>`
      INSERT INTO "AuthRateBucket" ("key", "hits", "expiresAt") VALUES (${key}, 1, ${until})
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "AuthRateBucket"."expiresAt" <= NOW() THEN 1 ELSE LEAST("AuthRateBucket"."hits" + 1, 1000000) END,
        "expiresAt" = CASE WHEN "AuthRateBucket"."expiresAt" <= NOW() THEN ${until} ELSE "AuthRateBucket"."expiresAt" END
      RETURNING "hits", "expiresAt"`;
    return { totalHits: row.hits, resetTime: row.expiresAt };
  }
  async decrement(value: string) {
    await db.$executeRaw`UPDATE "AuthRateBucket" SET "hits" = GREATEST(0, "hits" - 1) WHERE "key" = ${this.key(value)}`;
  }
  async resetKey(value: string) { await db.authRateBucket.deleteMany({ where: { key: this.key(value) } }); }
}
