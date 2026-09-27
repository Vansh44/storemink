// ---------------------------------------------------------------------------
// Waiting out a Vertex rate limit, for Theme Studio's model client.
//
// ★ A 429 IS A REFUSAL TO START, SO RETRYING IT CANNOT CHARGE TWICE. Vertex
// answers RESOURCE_EXHAUSTED before it runs the model, bills no tokens and
// writes nothing. That is what makes a long wait safe here — unlike a timeout
// or a 5xx after the model may have run, where a second attempt can be a
// second bill (merchant Mink's image generation never retries for exactly
// that reason).
//
// ★ SLOWER THAN THE SDK, ON PURPOSE. @google/genai already retries a 429, but
// its defaults are one and two seconds apart. Live golden-set runs showed that
// is too short for shared capacity: 17 of 32 cases ended rate_limited on the
// first run (even a 5-token call was refused) and 8 of 17 on the rerun, so a
// shortage lasts well past a few seconds. The client therefore takes 429 away from the SDK
// and waits here instead: 15s, 30s, 60s, then 120s twice, each with jitter.
//
// ★ BOUNDED THREE WAYS: five retries, six minutes of total waiting, and the
// run's own abort signal. The worker aborts at the run wall time (20 min), so
// a wait can never outlive the run it belongs to; an aborted wait resolves at
// once instead of finishing its sleep.
// ---------------------------------------------------------------------------

export const RATE_LIMIT_BACKOFF = {
  /** Retries after the first refusal; attempts = retries + 1. */
  retries: 5,
  initialMs: 15_000,
  maxMs: 120_000,
  /** Total time spent waiting across one call's retries. With today's steps
   * the retry count binds first (at most 345s); this is the ceiling that
   * still holds if someone raises `retries` or the steps later. */
  totalMs: 6 * 60_000,
} as const;

/**
 * How long to wait before retry number `retry` (0-based). Exponential, capped,
 * and jittered between half and all of the step, so the golden set's parallel
 * cases and two operators' runs do not come back in step and collide again.
 */
export function rateLimitDelayMs(
  retry: number,
  random: () => number = Math.random,
): number {
  const step = Math.min(
    RATE_LIMIT_BACKOFF.initialMs * 2 ** Math.max(0, retry),
    RATE_LIMIT_BACKOFF.maxMs,
  );
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(step * (0.5 + 0.5 * r));
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
export function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
