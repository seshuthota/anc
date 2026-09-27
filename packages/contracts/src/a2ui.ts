import { z } from "zod";

export const A2UI_CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

export const A2UIMessageSchema = z.object({
  version: z.literal("v0.9"),
}).and(z.union([
  z.object({ createSurface: z.object({ surfaceId: z.string().min(1), catalogId: z.string().min(1) }) }),
  z.object({ updateComponents: z.object({ surfaceId: z.string().min(1), components: z.array(z.record(z.string(), z.unknown())) }) }),
  z.object({ updateDataModel: z.object({ surfaceId: z.string().min(1), path: z.string().optional(), value: z.unknown().optional() }) }),
  z.object({ deleteSurface: z.object({ surfaceId: z.string().min(1) }) }),
]));

export type A2UIMessage = z.infer<typeof A2UIMessageSchema>;

export const PresentationMetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  detail: z.string().optional(),
  evidenceId: z.string().min(1),
  tone: z.enum(["danger", "warning", "neutral"]).optional()
});

export const PresentationFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.enum(["observation", "hypothesis", "unresolved_question"]),
  evidenceIds: z.array(z.string().min(1))
});

export const PresentationRowSchema = z.object({
  id: z.string().min(1),
  cells: z.array(z.string()),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actionName: z.string().min(1).optional()
});

export const PresentationTableSchema = z.object({
  id: z.string().min(1),
  columns: z.array(z.string().min(1)),
  rows: z.array(PresentationRowSchema),
  evidenceId: z.string().optional()
});

export const PresentationActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1),
  entities: z.array(z.object({ type: z.string(), id: z.string(), label: z.string().optional() })).default([])
});

export const PresentationInputSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  metrics: z.array(PresentationMetricSchema).default([]),
  findings: z.array(PresentationFindingSchema).default([]),
  table: PresentationTableSchema.optional(),
  form: z.object({
    id: z.string().min(1),
    fields: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      name: z.string().min(1),
      value: z.string().optional(),
      options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    })),
    submitLabel: z.string().min(1),
    submitAction: z.string().min(1),
  }).optional(),
  receipt: z.object({
    operationId: z.string().min(1),
    status: z.string().min(1),
    summary: z.string().min(1),
  }).optional(),
  actions: z.array(PresentationActionSchema).default([]),
  limitations: z.array(z.string()).default([])
});

export type PresentationInput = z.infer<typeof PresentationInputSchema>;
