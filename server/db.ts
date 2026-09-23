import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { defaults } from "../shared/domain.js";
import type { Settings } from "../shared/types.js";
export const db = new PrismaClient();
export const getSettings = async (): Promise<Settings> => ({
  ...defaults,
  ...(((await db.setting.findUnique({ where: { id: 1 } }))
    ?.value as Partial<Settings>) || {}),
});
// Serializable transactions retry only serialization conflicts, never validation failures.
export async function atomic<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: "Serializable",
        timeout: 15000,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}
