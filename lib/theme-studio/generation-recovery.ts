import { createHash } from "node:crypto";
import { canonicalJson } from "./contracts";
import type { StructuredResult, ThemeStudioModelClient } from "./provider";

// Separate from crash/lease attempts: a capacity refusal did not start the
// refused model call. Keep waiting bounded, even when capacity never returns.
export const MAX_RATE_LIMIT_DEFERRALS = 4;

export function generationRecoveryDelayMs(
  deferrals: number,
  random: () => number = Math.random,
): number | null {
  if (deferrals >= MAX_RATE_LIMIT_DEFERRALS) return null;
  const step = Math.min(5 * 60_000 * 2 ** deferrals, 20 * 60_000);
  return Math.round(step * (0.75 + 0.25 * Math.min(1, Math.max(0, random()))));
}

export type SavedModelResponse = Exclude<StructuredResult, { kind: "error" }>;

export interface GenerationResponseStore {
  read(digest: string): Promise<SavedModelResponse | null>;
  write(digest: string, response: SavedModelResponse): Promise<void>;
}

/** Exact request matching, scoped to one run by the store. Replaying saved
 * answers lets the ordinary validator/repair pipeline reconstruct its state
 * without repeating completed paid calls. Refusals from capacity are never
 * saved, so the refused request reaches the provider again after cooldown. */
export function resumableGenerationClient(
  client: ThemeStudioModelClient,
  store: GenerationResponseStore,
): ThemeStudioModelClient {
  let callIndex = 0;
  return {
    provider: client.provider,
    async generate(request, signal) {
      signal.throwIfAborted();
      if (request.stage !== "intent" && request.stage !== "draft") {
        throw new Error("Generation checkpoints support intent/draft only.");
      }
      const digest = createHash("sha256")
        .update(
          canonicalJson({
            provider: client.provider,
            callIndex: callIndex++,
            request,
          }),
        )
        .digest("hex");
      const saved = await store.read(digest);
      signal.throwIfAborted();
      if (saved) return saved;
      const response = await client.generate(request, signal);
      if (response.kind !== "error") await store.write(digest, response);
      return response;
    },
  };
}
