import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { defaults } from "../shared/domain.js";
import type { Settings } from "../shared/types.js";
// A warm function shares a bounded pool; never create or disconnect a client per request.
function connectionUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw || process.env.NODE_ENV !== "production") return raw;
  const url = new URL(raw);
  for (const [key, value] of Object.entries({ connection_limit: "4", pool_timeout: "10", connect_timeout: "8" }))
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  return url.toString();
}
const instance = globalThis as typeof globalThis & { bomboPrisma?: PrismaClient };
export const db = instance.bomboPrisma ??= new PrismaClient({
  ...(connectionUrl() ? { datasourceUrl: connectionUrl() } : {}),
});
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
        { await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt + Math.floor(Math.random() * 20))); continue; }
      throw error;
    }
  }
}
