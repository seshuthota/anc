import { z } from "zod";
import { EntityRefSchema, TimeWindowSchema } from "./entities.js";
import { AgentFindingSchema } from "./findings.js";

export const DomainSchema = z.enum(["reliability", "product", "customer", "finance"]);
export const TaskStatusSchema = z.enum(["pending", "running", "completed", "partial", "failed", "cancelled"]);

export const InvestigationTaskSchema = z.object({
  taskId: z.string().min(1),
  domain: DomainSchema,
  question: z.string().min(1),
  entityScope: z.array(EntityRefSchema).default([]),
  window: TimeWindowSchema.optional(),
  dependencies: z.array(z.string().min(1)).default([]),
  status: TaskStatusSchema,
  attemptCount: z.number().int().nonnegative().default(0),
  capabilities: z.array(z.string().min(1)).default([])
});

export const TaskResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "partial", "failed"]),
  findingIds: z.array(z.string().min(1)).default([]),
  findings: z.array(AgentFindingSchema).default([]),
  unresolvedQuestions: z.array(z.string().min(1)).default([]),
  suggestedFollowUps: z.array(z.string().min(1)).default([]),
  error: z.string().optional()
});

export type Domain = z.infer<typeof DomainSchema>;
export type InvestigationTask = z.infer<typeof InvestigationTaskSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
