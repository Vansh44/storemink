import "server-only";

export interface MinkConfig {
  enabled: boolean;
  betaRequireInvite: boolean;
  projectId: string | null;
  location: string;
  model: string;
  /** The image model has its own override even when it shares Vertex's region. */
  imageModel: string;
  imageLocation: string;
  maxSteps: number;
  maxToolCalls: number;
  maxParallelReadTools: number;
  maxOutputTokens: number;
  maxModelRetries: number;
  runTimeoutMs: number;
  /**
   * Whether a conversation actually spends the merchant's AI credits.
   *
   * ⚠ OPT-IN, unlike `enabled` above, which defaults ON when unset. Turning
   * this on starts billing for something that has always been free and raises
   * every plan's allowance in the same move, so it must never be reachable by
   * forgetting to set a variable. It is a pricing decision, taken once the
   * shadow bands have been calibrated against live traffic.
   */
  chargeCredits: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === undefined || value === "true" || value === "1";
}

/** Opt-IN: only an explicit true. The inverse of `enabled` above, and the
 *  difference is deliberate — see MinkConfig.chargeCredits. */
function optIn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    return fallback;
  return parsed;
}

/** Read at request time so Cloud Run revisions and tests can change config safely. */
export function getMinkConfig(): MinkConfig {
  return {
    // The runtime is enabled by default. Store access still fails closed behind
    // the independent, default-on invitation requirement below.
    enabled: enabled(process.env.MINK_AI_ENABLED),
    // Phase 2 is an invited beta. An explicit false is required to retain the
    // all-store internal-alpha behavior in a controlled environment.
    // The operator's single store switch must not be bypassed by an old
    // deployment's beta flag. Explicit read/delete-only actor options remain.
    betaRequireInvite: true,
    projectId: process.env.GCP_PROJECT_ID?.trim() || null,
    location:
      process.env.MINK_VERTEX_LOCATION?.trim() ||
      process.env.GCP_LOCATION?.trim() ||
      "global",
    model: process.env.MINK_VERTEX_MODEL?.trim() || "gemini-3.7-flash",
    imageModel:
      process.env.MINK_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image",
    // Gemini image generation is served at the global Vertex endpoint. Keep a
    // separate override so an operator can move it without moving chat.
    imageLocation: process.env.MINK_IMAGE_LOCATION?.trim() || "global",
    maxSteps: boundedInt(process.env.MINK_MAX_STEPS_PER_RUN, 8, 1, 20),
    maxToolCalls: boundedInt(
      process.env.MINK_MAX_TOOL_CALLS_PER_RUN,
      16,
      1,
      40,
    ),
    maxParallelReadTools: boundedInt(
      process.env.MINK_MAX_PARALLEL_READ_TOOLS,
      4,
      1,
      8,
    ),
    maxOutputTokens: boundedInt(
      process.env.MINK_MAX_OUTPUT_TOKENS,
      2_048,
      256,
      8_192,
    ),
    // One retry is enough to absorb a transient 429/5xx without hiding a
    // persistent outage behind a long backoff chain.
    chargeCredits: optIn(process.env.MINK_CHARGE_CREDITS),
    maxModelRetries: boundedInt(process.env.MINK_MAX_MODEL_RETRIES, 1, 0, 2),
    runTimeoutMs:
      boundedInt(process.env.MINK_RUN_TIMEOUT_SECONDS, 180, 15, 300) * 1_000,
  };
}
