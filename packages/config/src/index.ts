import { z } from "zod";

export const EnvSchema = z.object({
  MODEL_PROVIDER: z.enum(["fixture", "explabs", "xai", "openai"]).default("fixture"),
  MODEL_EXECUTION_MODE: z.enum(["fixture", "live-strict", "live-fallback"]).optional(),
  MODEL_ID: z.string().min(1).default("gpt-oss-120b"),
  INVESTIGATION_STEP_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
  MODEL_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  EXPLABS_API_KEY: z.string().optional(),
  EXPLABS_BASE_URL: z.string().optional(),
  EXPLABS_MODEL: z.string().optional(),
  LOGISTICS_DB_PATH: z.string().min(1).default("./data/logistics.sqlite"),
  RUNTIME_DB_PATH: z.string().min(1).default("./data/runtime.sqlite"),
  DATASET_VERSION: z.string().min(1).default("india-parcel-network-v1"),
  DEMO_CLOCK: z.string().datetime({ offset: true }).default("2026-09-20T08:00:00.000Z"),
  DEMO_TIMEZONE: z.string().min(1).default("UTC"),
  MAX_INVESTIGATION_ROUNDS: z.coerce.number().int().positive().default(8),
  MAX_TOOL_CALLS: z.coerce.number().int().positive().default(32),
  MAX_RUNTIME_MS: z.coerce.number().int().positive().default(120000),
  MAX_MODEL_TOKENS: z.coerce.number().int().positive().default(24000),
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WEB_HOST: z.string().min(1).default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000)
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}
