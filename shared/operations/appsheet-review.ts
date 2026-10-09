import { z } from "zod";

/** Technical review of a specific projection. This is never operational approval. */
export const appSheetTechnicalReviewSchema = z.object({
  schemaVersion: z.literal(1),
  reviewKind: z.literal("independent-technical"),
  captureId: z.string().min(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  projectionKind: z.enum(["masters", "history"]),
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  importer: z.string().min(1),
  reviewer: z.string().min(1),
  approved: z.literal(true),
  reviewedAt: z.iso.datetime(),
  findings: z.array(z.string()),
}).strict();

export type AppSheetTechnicalReview = z.infer<typeof appSheetTechnicalReviewSchema>;

export function requireAppSheetTechnicalReview(input: unknown, expected: {
  captureId: string;
  manifestHash: string;
  definitionHash?: string | null;
  projectionKind: "masters" | "history";
  projectionHash: string;
  commitSha: string;
  importer: string;
}): AppSheetTechnicalReview {
  const review = appSheetTechnicalReviewSchema.parse(input);
  if (review.reviewer.trim().toLowerCase() === review.importer.trim().toLowerCase()) {
    throw new Error("La revisión requiere un revisor independiente del importador.");
  }
  if (review.captureId !== expected.captureId || review.manifestHash !== expected.manifestHash ||
      (review.definitionHash ?? null) !== (expected.definitionHash ?? null) ||
      review.projectionKind !== expected.projectionKind || review.projectionHash !== expected.projectionHash ||
      review.commitSha !== expected.commitSha ||
      review.importer !== expected.importer) {
    throw new Error("La revisión técnica no corresponde a esta captura y proyección.");
  }
  if (Date.parse(review.reviewedAt) > Date.now() + 60_000) {
    throw new Error("La fecha de revisión técnica está en el futuro.");
  }
  return review;
}
