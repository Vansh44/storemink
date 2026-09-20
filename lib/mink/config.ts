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
   * Whether a conversation actually spends the merchant's Mink credits.
   *
   * ★★ ON BY DEFAULT since 2026-09-21 (owner's decision). It shipped OPT-IN so
   * that billing something which had always been free could not be reached by
   * forgetting to set a variable, and it then stayed unset in every
   * environment — `MINK_CHARGE_CREDITS` was in no `cloudbuild.yaml`
   * substitution and on no Cloud Run revision — so the shadow meter ran for
   * weeks while nothing was billed. Measured on production before the flip:
   * 28 runs, 6 credits charged (both of them PROPOSAL weights, never the
   * conversation) against 80 the meter says it would have charged.
   *
   * ★ IT IS `enabled()`, NOT A LITERAL `true`, so `MINK_CHARGE_CREDITS=false`
   * is a real emergency stop — the same shape as `MINK_AI_ENABLED`, and the
   * reason the variable stays wired through the deploy rather than being
   * deleted now that the default covers it.
   *
   * ⚠ IT STILL DOES TWO JOBS AT ONCE, and that pairing is load-bearing rather
   * than incidental: `aiAllowanceFor` reads the same flag, so charging on also
   * moves every plan's included allowance from 3/10/50 to 20/100/300. Billing
   * 1–8-credit runs against caps sized for ₹0.90 product descriptions would
   * give a Free store one question a month.
   *
   * ⚠ THE MARGIN AT A BAND CEILING IS ~1.09× UNCACHED. A run sitting just under
   * the light or standard ceiling costs ₹1.98 or ₹5.94 against ₹2.15 or ₹6.45
   * of credit. Caching is what fixes that, not tighter bands — tightening would
   * triple the charge on ordinary runs.
   */
  chargeCredits: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === undefined || value === "true" || value === "1";
}

/**
 * On unless explicitly switched off, normalising the value first.
 *
 * ★★ NOT `enabled()`, AND THE DIFFERENCE IS THE FAILURE DIRECTION. That helper
 * treats anything it does not recognise as OFF — right for `MINK_AI_ENABLED`,
 * where off means Mink stops answering and somebody notices within minutes.
 * Here off means every conversation is silently free, which is the exact fault
 * that went unnoticed for weeks. So `MINK_CHARGE_CREDITS=TRUE`, or a value with
 * a stray space, must not quietly stop the billing it was set to start:
 * only a deliberate, recognisable "false"/"0" turns this off.
 */
function optOut(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0";
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
      process.env.MINK_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image",
    // Gemini image generation is served at the global Vertex endpoint. Keep a
    // separate override so an operator can move it without moving chat.
    imageLocation: process.env.MINK_IMAGE_LOCATION?.trim() || "global",
    maxSteps: boundedInt(process.env.MINK_MAX_STEPS_PER_RUN, 12, 1, 20),
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
    // On unless explicitly switched off — see MinkConfig.chargeCredits.
    chargeCredits: optOut(process.env.MINK_CHARGE_CREDITS),
    maxModelRetries: boundedInt(process.env.MINK_MAX_MODEL_RETRIES, 1, 0, 2),
    runTimeoutMs:
      boundedInt(process.env.MINK_RUN_TIMEOUT_SECONDS, 180, 15, 300) * 1_000,
  };
}
