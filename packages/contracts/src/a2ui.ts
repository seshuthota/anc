import { z } from "zod";

import { WORKSPACE_CATALOG_ID } from "./catalog.js";

export const A2UI_CATALOG_ID = WORKSPACE_CATALOG_ID;

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
  /** Canonical registry id of a reconciled metric. */
  metricId: z.string().min(1).optional(),
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
  /** Lets a briefing lead with what matters most. */
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  evidenceIds: z.array(z.string().min(1))
});

export const PRESENTATION_VIEWS = ["summary", "table", "comparison", "queue", "form", "trend"] as const;

export const PresentationRowSchema = z.object({
  id: z.string().min(1),
  cells: z.array(z.string()),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actionName: z.string().min(1).optional(),
  /** Optional numeric hint per column so the renderer can sort numerically instead of lexically. */
  sortValues: z.array(z.number()).optional()
});

export const PresentationTableSchema = z.object({
  id: z.string().min(1),
  columns: z.array(z.string().min(1)),
  rows: z.array(PresentationRowSchema),
  evidenceId: z.string().optional(),
  /** Column index the table starts sorted by, ascending. */
  defaultSort: z.number().int().nonnegative().optional(),
  /** Pre-computed totals row. Deterministic arithmetic belongs in the tool, not the model. */
  totals: z.array(z.string()).optional(),
  /** Shown under the table when the artifact is a partial or paginated read. */
  completeness: z.enum(["complete", "partial", "empty"]).optional()
});

export const PresentationDraftStepSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean().optional()
});

export const PresentationDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(PresentationDraftStepSchema).min(1),
  /** Model-authored statements the draft does not know to be true. Rendered as first-class, not buried. */
  assumptions: z.array(z.string()).default([]),
  /** Marks the draft as model-authored rather than observed fact. */
  status: z.enum(["proposed", "edited", "confirmed"]).default("proposed")
});

export const PresentationChartPointSchema = z.object({
  label: z.string().min(1),
  value: z.number()
});

export const PresentationChartSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  unit: z.string().default(""),
  points: z.array(PresentationChartPointSchema).min(2),
  evidenceId: z.string().optional(),
  caption: z.string().optional()
});

export const PresentationSelectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
  selected: z.array(z.string()).default([])
});

export const PresentationActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1),
  entities: z.array(z.object({ type: z.string(), id: z.string(), label: z.string().optional() })).default([])
});

const SynthesisPointSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  findingIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1))
});

/** The lead analyst's account connecting separate findings: a headline, the chain behind it, and unrelated issues. */
export const PresentationSynthesisSchema = z.object({
  headline: z.string().min(1),
  /** In order of cause and effect. An inferred step is the analyst's link between findings, not something a tool observed. */
  steps: z.array(SynthesisPointSchema.extend({ kind: z.enum(["observed", "inferred"]) })).min(1),
  separate: z.array(SynthesisPointSchema).default([])
});

export const PresentationInputSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  /** Drives layout. Previously computed by the planner and then ignored by the composer. */
  view: z.enum(PRESENTATION_VIEWS).default("summary"),
  synthesis: PresentationSynthesisSchema.optional(),
  metrics: z.array(PresentationMetricSchema).default([]),
  findings: z.array(PresentationFindingSchema).default([]),
  table: PresentationTableSchema.optional(),
  chart: PresentationChartSchema.optional(),
  draft: PresentationDraftSchema.optional(),
  selection: PresentationSelectionSchema.optional(),
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
