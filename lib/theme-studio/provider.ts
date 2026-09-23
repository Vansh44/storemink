import type { ThemeStudioModelKey } from "./models";

// The seam between the generation pipeline and a model. The pipeline speaks
// only this interface, so the offline test provider and Gemini-on-Vertex run
// through exactly the same compile/validate/repair path.

export type ThemeStudioContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/webp"; base64: string };

export interface StructuredRequest {
  stage: "intent" | "draft";
  modelKey: ThemeStudioModelKey;
  providerModel: string;
  system: string;
  content: ThemeStudioContentBlock[];
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Maps to the provider's thinking level. */
  effort: "low" | "high";
}

export interface ProviderUsage {
  /** Every prompt token, INCLUDING the cached ones. */
  inputTokens: number;
  /** The subset of inputTokens served from the provider's cache. */
  cachedTokens: number;
  /** Visible response tokens. */
  outputTokens: number;
  /** Reasoning tokens; billed as output. */
  thinkingTokens: number;
}

export const ZERO_USAGE: ProviderUsage = {
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
};

/** Closed vocabulary: these become `theme_studio_runs.error_code` values. */
export type ProviderErrorCode =
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_auth"
  | "provider_timeout"
  | "cancelled";

export type StructuredResult =
  | { kind: "ok"; value: unknown; usage: ProviderUsage }
  | { kind: "refused"; category: string | null; usage: ProviderUsage }
  | { kind: "truncated"; usage: ProviderUsage }
  | { kind: "invalid_json"; usage: ProviderUsage }
  | { kind: "error"; code: ProviderErrorCode; usage: ProviderUsage };

export interface ThemeStudioModelClient {
  readonly provider: "fake" | "vertex-gemini";
  generate(
    request: StructuredRequest,
    signal: AbortSignal,
  ): Promise<StructuredResult>;
}

export function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}
