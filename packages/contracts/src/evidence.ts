import { z } from "zod";
import { EntityRefSchema, IsoDateTime, TimeWindowSchema } from "./entities.js";

export const EvidenceSourceSchema = z.object({
  system: z.string().min(1),
  datasetVersion: z.string().min(1),
  retrievedAt: IsoDateTime,
  asOf: IsoDateTime,
  timezone: z.string().min(1),
  units: z.string().optional(),
  currency: z.string().length(3).toUpperCase().optional()
});

export const PaginationSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean()
});

export const EvidenceEnvelopeSchema = z.object({
  evidenceId: z.string().min(1),
  tool: z.string().min(1),
  toolVersion: z.string().min(1),
  source: EvidenceSourceSchema,
  arguments: z.record(z.string(), z.unknown()),
  filters: z.record(z.string(), z.unknown()),
  window: TimeWindowSchema.optional(),
  result: z.unknown(),
  pagination: PaginationSchema.optional(),
  completeness: z.enum(["complete", "partial", "empty"]),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  entities: z.array(EntityRefSchema).default([])
});

export const EvidenceErrorSchema = z.object({
  code: z.enum(["INVALID_ARGUMENT", "NOT_FOUND", "TIMEOUT", "CANCELLED", "INTERNAL"]),
  message: z.string().min(1),
  retryable: z.boolean()
});

export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;
export type EvidenceError = z.infer<typeof EvidenceErrorSchema>;
