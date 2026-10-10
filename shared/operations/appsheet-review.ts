import { z } from "zod";

export type AppSheetReviewTarget = "isolated-test" | "production";

const appSheetTechnicalReviewFields = {
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
};

/** Version 1 reviews predate target binding and are accepted only for isolated tests. */
const legacyAppSheetTechnicalReviewSchema = z.object({
  schemaVersion: z.literal(1),
  ...appSheetTechnicalReviewFields,
}).strict();

/** Version 2 reviews bind the technical review to one destination and environment. */
const boundAppSheetTechnicalReviewSchema = z.object({
  schemaVersion: z.literal(2),
  ...appSheetTechnicalReviewFields,
  target: z.enum(["isolated-test", "production"]),
  destinationIdentity: z.string().regex(/^appsheet-db-v1:[a-f0-9]{64}$/),
}).strict();

/** Technical review of a specific projection and destination. This is never operational approval. */
export const appSheetTechnicalReviewSchema = z.discriminatedUnion("schemaVersion", [
  legacyAppSheetTechnicalReviewSchema,
  boundAppSheetTechnicalReviewSchema,
]);

export type AppSheetTechnicalReview = z.infer<typeof appSheetTechnicalReviewSchema>;

export function requireAppSheetTechnicalReview(input: unknown, expected: {
  captureId: string;
  manifestHash: string;
  definitionHash?: string | null;
  projectionKind: "masters" | "history";
  projectionHash: string;
  commitSha: string;
  importer: string;
  target: AppSheetReviewTarget;
  destinationIdentity: string;
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
  if (review.schemaVersion === 1) {
    if (expected.target !== "isolated-test")
      throw new Error("La revisión técnica legacy sólo puede usarse en destino aislado.");
  } else if (review.target !== expected.target || review.destinationIdentity !== expected.destinationIdentity) {
    throw new Error("La revisión técnica no corresponde al destino solicitado.");
  }
  if (Date.parse(review.reviewedAt) > Date.now() + 60_000) {
    throw new Error("La fecha de revisión técnica está en el futuro.");
  }
  return review;
}
