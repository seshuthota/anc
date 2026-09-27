import { z } from "zod";

export const ActivityKindSchema = z.enum([
  "agent_started",
  "agent_completed",
  "tool_queried",
  "finding_discovered",
  "task_delegated",
  "investigation_completed",
  "status",
  "action"
]);

export const ActivityEventSchema = z.object({
  id: z.string().min(1),
  kind: ActivityKindSchema,
  message: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  runId: z.string().optional(),
  taskId: z.string().optional()
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
