import { afterEach, describe, expect, it } from "vitest";
import { getMinkConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getMinkConfig", () => {
  it("enables by default and uses the production model defaults", () => {
    delete process.env.MINK_AI_ENABLED;
    delete process.env.MINK_VERTEX_MODEL;
    delete process.env.MINK_VERTEX_LOCATION;
    delete process.env.MINK_IMAGE_MODEL;
    delete process.env.MINK_IMAGE_LOCATION;
    process.env.GCP_PROJECT_ID = "storemink-test";

    expect(getMinkConfig()).toMatchObject({
      enabled: true,
      betaRequireInvite: true,
      projectId: "storemink-test",
      location: "global",
      model: "gemini-3.7-flash",
      imageModel: "gemini-2.5-flash-image",
      imageLocation: "global",
      maxSteps: 8,
      maxToolCalls: 16,
      maxParallelReadTools: 4,
      maxOutputTokens: 2_048,
      maxModelRetries: 1,
      runTimeoutMs: 180_000,
    });
  });

  it("requires a store invitation unless a controlled environment opts out", () => {
    expect(getMinkConfig().betaRequireInvite).toBe(true);
  });

  it("allows an explicit false value to disable the default-on runtime", () => {
    delete process.env.MINK_AI_ENABLED;
    expect(getMinkConfig().enabled).toBe(true);
    for (const value of ["false", "0", "yes", "TRUE", "enabled", ""]) {
      process.env.MINK_AI_ENABLED = value;
      expect(getMinkConfig().enabled, value).toBe(false);
    }
    process.env.MINK_AI_ENABLED = "true";
    expect(getMinkConfig().enabled).toBe(true);
    process.env.MINK_AI_ENABLED = "1";
    expect(getMinkConfig().enabled).toBe(true);
  });

  it("rejects unsafe numeric limits instead of trusting environment input", () => {
    process.env.MINK_MAX_STEPS_PER_RUN = "999";
    process.env.MINK_MAX_TOOL_CALLS_PER_RUN = "0";
    process.env.MINK_MAX_PARALLEL_READ_TOOLS = "not-a-number";
    process.env.MINK_MAX_OUTPUT_TOKENS = "12.5";
    process.env.MINK_MAX_MODEL_RETRIES = "9";
    process.env.MINK_RUN_TIMEOUT_SECONDS = "5";

    expect(getMinkConfig()).toMatchObject({
      maxSteps: 8,
      maxToolCalls: 16,
      maxParallelReadTools: 4,
      maxOutputTokens: 2_048,
      maxModelRetries: 1,
      runTimeoutMs: 180_000,
    });
  });
});
