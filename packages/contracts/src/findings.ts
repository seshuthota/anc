import { z } from "zod";
import { EntityRefSchema, IsoDateTime, TimeWindowSchema } from "./entities.js";

export const FindingKindSchema = z.enum(["observation", "hypothesis", "unresolved_question"]);
export const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);

export const MetricScopeSchema = z.object({
  type: z.enum(["network", "hub", "shipper", "district", "locker"]),
  id: z.string().min(1).optional()
});

export const MetricSchema = z.object({
  name: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  aggregation: z.enum(["sum", "count", "rate", "average", "percentile", "distinct_count"]),
  window: TimeWindowSchema.optional(),
  comparisonValue: z.number().finite().optional(),
  comparisonWindow: TimeWindowSchema.optional(),
  metricId: z.string().min(1).optional(),
  scope: MetricScopeSchema.optional(),
  denominator: z.object({
    value: z.number().finite(),
    metricId: z.string().min(1).optional()
  }).optional()
});

export const ClaimSchema = z.object({
  claimId: z.string().min(1),
  statement: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1),
  resultPaths: z.array(z.string().min(1)).default([]),
  entities: z.array(EntityRefSchema).default([]),
  metrics: z.array(MetricSchema).default([]),
  limitations: z.array(z.string().min(1)).default([]),
  contradictoryEvidenceIds: z.array(z.string().min(1)).default([])
});

export const AgentFindingSchema = z.object({
  findingId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  kind: FindingKindSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  entities: z.array(EntityRefSchema).default([]),
  window: TimeWindowSchema.optional(),
  severity: SeveritySchema,
  createdAt: IsoDateTime,
  limitations: z.array(z.string().min(1)).default([])
});

export type FindingKind = z.infer<typeof FindingKindSchema>;
export type MetricScope = z.infer<typeof MetricScopeSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type AgentFinding = z.infer<typeof AgentFindingSchema>;
