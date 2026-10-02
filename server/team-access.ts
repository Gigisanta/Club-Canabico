import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { HttpError } from "./validation.js";
import { z } from "zod";

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/, "Usá de 2 a 32 letras, números, puntos, guiones o guiones bajos.");

export const setupHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function findValidSeat(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const seat = await db.teamSeat.findUnique({ where: { tokenHash: setupHash(token) } });
  if (!seat?.email || seat.activatedAt || !seat.expiresAt || seat.expiresAt <= new Date()) return null;
  return seat;
}

export async function prepareSeat(id: string, email: string) {
  const seat = await db.teamSeat.findUnique({ where: { id } });
  if (!seat || seat.activatedAt) throw new HttpError(404, "Acceso pendiente no encontrado");
  const normalizedEmail = email.trim().toLowerCase();
  if (await db.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }))
    throw new HttpError(409, "Ese correo ya tiene una cuenta");
  const otherSeat = await db.teamSeat.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (otherSeat && otherSeat.id !== id)
    throw new HttpError(409, "Ese correo ya está reservado para otra persona");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await db.teamSeat.update({ where: { id }, data: { email: normalizedEmail, tokenHash: setupHash(token), expiresAt } });
  return { path: `/app/activar#token=${token}`, expiresAt };
}
