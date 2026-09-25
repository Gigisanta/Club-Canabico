import { Router, raw } from "express";
import rateLimit from "express-rate-limit";
import sharp from "sharp";
import { z } from "zod";
import { db } from "./db.js";
import { HttpError } from "./validation.js";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const octets = ipv4.split(".");
  return octets.length === 4 && octets[0] === "127" &&
    octets.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

const localPreview = process.env.PUBLIC_SITE_PREVIEW === "true" &&
  process.env.NODE_ENV === "development" &&
  isLoopbackHost(process.env.HOST || "127.0.0.1");
const publicSiteApproved = process.env.PUBLIC_SITE_APPROVED === "true" || localPreview;
const previewOnly = Router();
previewOnly.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  if (!publicSiteApproved) return res.status(404).json({ error: "Sitio público pendiente de aprobación" });
  next();
});

const imageUrl = (slug: string) => `/api/site/showcase/${encodeURIComponent(slug)}/image`;
const publicItem = (item: {
  slug: string; title: string; category: string; description: string;
  image: { itemId: string } | null;
}) => ({
  slug: item.slug,
  title: item.title,
  category: item.category,
  description: item.description,
  imageUrl: item.image ? imageUrl(item.slug) : null,
});
const publicSelect = {
  slug: true, title: true, category: true, description: true,
  image: { select: { itemId: true } },
} as const;

export const publicSite = Router();
publicSite.use(previewOnly);
publicSite.get("/", async (_req, res) => {
  const channels = await db.siteChannels.findUnique({ where: { id: 1 } });
  res.json({
    whatsappAvailable: Boolean(channels?.whatsappPhone),
    instagramUrl: channels?.instagramUrl || null,
  });
});
publicSite.get("/showcase", async (_req, res) => {
  const items = await db.showcaseItem.findMany({
    where: { status: "published" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    select: publicSelect,
    take: 100,
  });
  res.json({ items: items.map(publicItem) });
});
publicSite.get("/showcase/:slug", async (req, res) => {
  const item = await db.showcaseItem.findFirst({
    where: { slug: z.string().parse(req.params.slug), status: "published" },
    select: publicSelect,
  });
  if (!item) throw new HttpError(404, "Ficha no encontrada");
  res.json(publicItem(item));
});
publicSite.get("/showcase/:slug/image", async (req, res) => {
  const item = await db.showcaseItem.findFirst({
    where: { slug: z.string().parse(req.params.slug), status: "published" },
    select: { image: { select: { data: true, mime: true } } },
  });
  if (!item?.image) throw new HttpError(404, "Imagen no encontrada");
  res.type(item.image.mime).send(Buffer.from(item.image.data));
});
const inquirySchema = z.object({
  name: z.string().trim().min(2).max(100),
  contact: z.string().trim().min(5).max(160).refine(
    value => z.email().safeParse(value).success || /^\+?[\d\s()\-]{7,25}$/.test(value),
    "Ingresá un correo o teléfono válido",
  ),
  interest: z.string().trim().min(2).max(100),
  message: z.string().trim().min(10).max(2000),
  source: z.string().trim().min(1).max(100),
  consent: z.literal(true),
  website: z.string().max(0).optional(),
});
publicSite.post("/inquiries", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Reintentá más tarde." },
}), async (req, res) => {
  const value = inquirySchema.parse(req.body);
  let whatsappPhone: string | null = null;
  try {
    const channels = await db.siteChannels.findUnique({ where: { id: 1 } });
    whatsappPhone = channels?.whatsappPhone || null;
  } catch {
    // Contact channels are optional; their unavailability must not block an inquiry.
  }
  await db.publicInquiry.create({
    data: {
      name: value.name, contact: value.contact, interest: value.interest,
      message: value.message, source: value.source, consentAt: new Date(),
    },
  });
  const message = encodeURIComponent("Hola Bombo, envié una consulta desde la web.");
  res.status(201).json({
    saved: true,
    whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}?text=${message}` : null,
  });
});

const itemSchema = z.object({
  title: z.string().trim().min(2).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(20).max(4000),
  sortOrder: z.number().int().min(0).max(10000),
});
const statusSchema = z.object({ status: z.enum(["draft", "published"]) });
const channelsSchema = z.object({
  whatsappPhone: z.string().trim().max(30).transform(v => v.replace(/[^\d]/g, ""))
    .refine(v => !v || /^\d{8,15}$/.test(v), "Usá un número internacional de 8 a 15 dígitos"),
  instagramUrl: z.string().trim().max(250).refine(v => {
    if (!v) return true;
    try { const url = new URL(v); return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname) && /^\/[A-Za-z0-9._]+\/?$/.test(url.pathname); }
    catch { return false; }
  }, "Usá la URL oficial del perfil de Instagram"),
});

export const adminSite = Router();
adminSite.get("/channels", async (_req, res) => {
  res.json((await db.siteChannels.findUnique({ where: { id: 1 } })) || { whatsappPhone: "", instagramUrl: "" });
});
adminSite.put("/channels", async (req, res) => {
  const value = channelsSchema.parse(req.body);
  res.json(await db.siteChannels.upsert({
    where: { id: 1 }, create: { id: 1, ...value }, update: value,
  }));
});
adminSite.get("/showcase", async (_req, res) => {
  const items = await db.showcaseItem.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    include: { image: { select: { itemId: true } } },
  });
  res.json({ items: items.map(item => ({
    id: item.id, slug: item.slug, title: item.title, category: item.category,
    description: item.description, status: item.status, sortOrder: item.sortOrder,
    updatedAt: item.updatedAt, imageUrl: item.image ? `/api/site/admin/showcase/${item.id}/image` : null,
  })) });
});
adminSite.post("/showcase", async (req, res) => {
  const value = itemSchema.parse(req.body);
  const item = await db.showcaseItem.create({ data: value });
  res.status(201).json(item);
});
adminSite.put("/showcase/:id", async (req, res) => {
  const value = itemSchema.parse(req.body);
  res.json(await db.showcaseItem.update({ where: { id: z.string().parse(req.params.id) }, data: value }));
});
adminSite.patch("/showcase/:id/status", async (req, res) => {
  const { status } = statusSchema.parse(req.body);
  const id = z.string().parse(req.params.id);
  const item = await db.showcaseItem.findUnique({ where: { id }, include: { image: { select: { itemId: true } } } });
  if (!item) throw new HttpError(404, "Ficha no encontrada");
  if (status === "published" && !item.image) throw new HttpError(400, "Subí una imagen antes de publicar");
  res.json(await db.showcaseItem.update({ where: { id }, data: { status } }));
});
adminSite.delete("/showcase/:id", async (req, res) => {
  await db.showcaseItem.delete({ where: { id: z.string().parse(req.params.id) } });
  res.json({ deleted: true });
});
adminSite.put("/showcase/:id/image", raw({
  type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb",
}), async (req, res) => {
  const id = z.string().parse(req.params.id);
  const input = req.body;
  if (!Buffer.isBuffer(input) || input.length < 100 || input.length > 6 * 1024 * 1024)
    throw new HttpError(400, "Elegí una imagen JPEG, PNG o WebP de hasta 6 MB");
  let buffer: Buffer, info: sharp.OutputInfo;
  try {
    const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format || "") || !metadata.width || !metadata.height)
      throw new Error("Formato inválido");
    ({ data: buffer, info } = await sharp(input, { limitInputPixels: 40_000_000 })
      .autoOrient().resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer({ resolveWithObject: true }));
  } catch { throw new HttpError(400, "No se pudo procesar la imagen"); }
  const image = await db.showcaseImage.upsert({
    where: { itemId: id },
    create: { itemId: id, data: new Uint8Array(buffer), mime: "image/webp", width: info.width, height: info.height },
    update: { data: new Uint8Array(buffer), mime: "image/webp", width: info.width, height: info.height },
    select: { itemId: true, width: true, height: true },
  });
  res.json(image);
});
adminSite.get("/showcase/:id/image", async (req, res) => {
  const image = await db.showcaseImage.findUnique({
    where: { itemId: z.string().parse(req.params.id) }, select: { data: true, mime: true },
  });
  if (!image) throw new HttpError(404, "Imagen no encontrada");
  res.type(image.mime).send(Buffer.from(image.data));
});
adminSite.get("/inquiries", async (req, res) => {
  const status = req.query.status ? z.enum(["new", "contacted", "closed"]).parse(req.query.status) : undefined;
  const cursor = req.query.cursor ? z.string().min(1).max(100).parse(req.query.cursor) : undefined;
  const items = await db.publicInquiry.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 51,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  res.json({ items: items.slice(0, 50), nextCursor: items.length > 50 ? items[49].id : null });
});
adminSite.patch("/inquiries/:id", async (req, res) => {
  const value = z.object({
    status: z.enum(["new", "contacted", "closed"]),
    notes: z.string().trim().max(2000),
  }).parse(req.body);
  res.json(await db.publicInquiry.update({ where: { id: z.string().parse(req.params.id) }, data: value }));
});
adminSite.delete("/inquiries/:id", async (req, res) => {
  await db.publicInquiry.delete({ where: { id: z.string().parse(req.params.id) } });
  res.json({ deleted: true });
});
