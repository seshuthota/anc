export type ModelConfig = {
  provider: "fixture" | "explabs" | "xai" | "openai";
  apiKey?: string;
  baseURL?: string;
  model: string;
};

function trimSlash(url: string) {
  return url.replace(/\/+$/, "");
}

export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = (env.MODEL_PROVIDER ?? "fixture") as ModelConfig["provider"];
  if (provider === "explabs") {
    return {
      provider: "explabs",
      apiKey: env.EXPLABS_API_KEY,
      baseURL: trimSlash(env.EXPLABS_BASE_URL || "https://api.experientiallabs.ai/v1"),
      model: env.EXPLABS_MODEL || env.MODEL_ID || "gpt-oss-120b",
    };
  }
  if (provider === "xai") {
    return {
      provider: "xai",
      apiKey: env.XAI_API_KEY ?? env.MODEL_API_KEY,
      baseURL: "https://api.x.ai/v1",
      model: env.MODEL_ID || "grok-4.5",
    };
  }
  if (provider === "openai") {
    return {
      provider: "openai",
      apiKey: env.MODEL_API_KEY ?? env.OPENAI_API_KEY,
      baseURL: trimSlash(env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      model: env.MODEL_ID || "gpt-4.1-mini",
    };
  }
  return { provider: "fixture", model: "fixture" };
}

export function isLiveProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveModelConfig(env).provider !== "fixture";
}

export type ExecutionMode = "fixture" | "live-strict" | "live-fallback";

export function resolveExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  const provider = env.MODEL_PROVIDER ?? "fixture";
  const requested = env.MODEL_EXECUTION_MODE;
  if (provider === "fixture") return "fixture";
  if (requested === "fixture" || requested === "live-strict" || requested === "live-fallback") return requested;
  return "live-strict";
}
