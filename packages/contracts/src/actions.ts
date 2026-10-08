import { z } from "zod";
import { EntityRefSchema } from "./entities.js";

export const ActionNameSchema = z.enum([
  "investigate",
  "show_evidence",
  "retry_task",
  "show_as_table",
  "prepare_assignment",
  "commit_assignment",
  "select_assignee",
  "save_draft",
  "set_selection",
  // Briefing operations (Slice 4): a catalog action is proposed, then confirmed or cancelled on the same surface.
  "propose_action",
  "confirm_action",
  "cancel_action",
  // Follow-ups (Slice 5): a drill-down's context header returns to the briefing revision it came from.
  "back_to_briefing"
]);

export const SemanticActionSchema = z.object({
  actionId: z.string().min(1),
  name: ActionNameSchema,
  threadId: z.string().min(1),
  investigationId: z.string().min(1),
  surfaceId: z.string().min(1),
  surfaceRevision: z.number().int().positive(),
  entities: z.array(EntityRefSchema).default([]),
  parameters: z.record(z.string(), z.unknown()).default({})
});

export type ActionName = z.infer<typeof ActionNameSchema>;
export type SemanticAction = z.infer<typeof SemanticActionSchema>;
