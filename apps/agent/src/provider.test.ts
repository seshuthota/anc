import { describe, expect, it } from "vitest";
import { resolveModelConfig } from "./provider.js";

describe("model provider", () => {
  it("uses Explabs OpenAI-compatible settings", () => {
    const config = resolveModelConfig({
      MODEL_PROVIDER: "explabs",
      EXPLABS_API_KEY: "xpl_test",
      EXPLABS_BASE_URL: "https://api.experientiallabs.ai/v1/",
      EXPLABS_MODEL: "gpt-oss-120b",
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      provider: "explabs",
      apiKey: "xpl_test",
      baseURL: "https://api.experientiallabs.ai/v1",
      model: "gpt-oss-120b",
    });
  });

  it("defaults to fixture", () => {
    expect(resolveModelConfig({} as NodeJS.ProcessEnv).provider).toBe("fixture");
  });
});

describe("execution mode", () => {
  it("keeps fixture provider in fixture mode", async () => {
    const { resolveExecutionMode } = await import("./provider.js");
    expect(resolveExecutionMode({ MODEL_PROVIDER: "fixture" } as NodeJS.ProcessEnv)).toBe("fixture");
  });

  it("defaults live providers to live-strict", async () => {
    const { resolveExecutionMode } = await import("./provider.js");
    expect(resolveExecutionMode({ MODEL_PROVIDER: "explabs" } as NodeJS.ProcessEnv)).toBe("live-strict");
  });

  it("requires live-fallback to be explicit", async () => {
    const { resolveExecutionMode } = await import("./provider.js");
    expect(resolveExecutionMode({
      MODEL_PROVIDER: "explabs",
      MODEL_EXECUTION_MODE: "live-fallback",
    } as NodeJS.ProcessEnv)).toBe("live-fallback");
  });
});
