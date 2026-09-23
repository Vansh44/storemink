import "server-only";

import {
  THEME_STUDIO_LIMITS,
  validateThemeIntent,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import {
  assemblePackage,
  normalizeIntent,
  prepareDraft,
  slotSpec,
  type CompileFacts,
} from "./compiler";
import { estimateCostMicroUsd, THEME_STUDIO_PRICING_VERSION } from "./cost";
import {
  placeholderSize,
  renderPlaceholder,
  type PlaceholderImage,
} from "./placeholders";
import {
  referenceLabel,
  repairUserText,
  stageASystemPrompt,
  stageAUserText,
  stageBSystemPrompt,
  stageBUserText,
  type BriefMessage,
  type ProjectFacts,
} from "./prompts";
import {
  addUsage,
  ZERO_USAGE,
  type ProviderUsage,
  type StructuredRequest,
  type ThemeStudioContentBlock,
  type ThemeStudioModelClient,
} from "./provider";
import { STAGE_A_ENVELOPE_SCHEMA, STAGE_B_DRAFT_SCHEMA } from "./schemas";

// ---------------------------------------------------------------------------
// The two-stage generation pipeline.
//
//   Stage A  brief + references → ThemeIntent   (or a question, or a decline)
//   Stage B  ThemeIntent        → theme draft → compiled ThemePackageV2
//
// ★ Each stage gets at most THEME_STUDIO_LIMITS.repairAttempts repairs: the
// validator's issue list goes back to the model as data with its previous
// output, and a response that is still invalid after the last repair FAILS the
// run. Nothing invalid ever becomes a version.
//
// ★ Repairs are fresh single-turn requests, never a replayed conversation, so a
// repair costs one ordinary request and carries no hidden prior-turn state.
//
// ★ The pipeline returns an outcome; it does not touch the database. The worker
// records it, which keeps this module testable against a fake client.
// ---------------------------------------------------------------------------

export interface GenerationInput {
  facts: ProjectFacts;
  compile: Omit<CompileFacts, "promptVersion">;
  providerModel: string;
  promptVersion: string;
  messages: BriefMessage[];
  references: { base64: string; sha256: string }[];
}

export interface StageUsage {
  stage: "intent" | "draft";
  attempt: number;
  usage: ProviderUsage;
}

export interface GenerationTelemetry {
  calls: StageUsage[];
  totals: ProviderUsage;
  repairs: { intent: number; draft: number };
  estimatedCostMicroUsd: number;
  pricingVersion: string;
}

export type GenerationOutcome =
  | {
      kind: "version";
      intent: ThemeIntent;
      package: ThemePackageV2;
      placeholders: Map<string, PlaceholderImage>;
      telemetry: GenerationTelemetry;
    }
  | { kind: "clarify"; questions: string[]; telemetry: GenerationTelemetry }
  | { kind: "declined"; reason: string; telemetry: GenerationTelemetry }
  | {
      kind: "failed";
      errorCode: string;
      detail: Record<string, unknown>;
      telemetry: GenerationTelemetry;
    };

const STAGE_A_MAX_TOKENS = 16_000;
const STAGE_B_MAX_TOKENS = 64_000;
const MAX_QUESTIONS = 5;

class Telemetry {
  calls: StageUsage[] = [];
  repairs = { intent: 0, draft: 0 };
  constructor(private readonly modelKey: CompileFacts["modelKey"]) {}
  record(stage: "intent" | "draft", attempt: number, usage: ProviderUsage) {
    this.calls.push({ stage, attempt, usage });
  }
  snapshot(): GenerationTelemetry {
    const totals = this.calls.reduce(
      (sum, c) => addUsage(sum, c.usage),
      ZERO_USAGE,
    );
    return {
      calls: this.calls,
      totals,
      repairs: { ...this.repairs },
      // Per call, then summed: Gemini 3.1 Pro's tier depends on each
      // request's own prompt size, so pricing the totals would mis-tier it.
      estimatedCostMicroUsd: this.calls.reduce(
        (sum, c) => sum + estimateCostMicroUsd(this.modelKey, c.usage),
        0,
      ),
      pricingVersion: THEME_STUDIO_PRICING_VERSION,
    };
  }
}

function isRec(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type StageFailure = {
  failed: { errorCode: string; detail: Record<string, unknown> };
};

async function call(
  client: ThemeStudioModelClient,
  request: StructuredRequest,
  telemetry: Telemetry,
  attempt: number,
  signal: AbortSignal,
): Promise<{ value: unknown } | { invalid: string } | StageFailure> {
  const result = await client.generate(request, signal);
  telemetry.record(request.stage, attempt, result.usage);
  switch (result.kind) {
    case "ok":
      return { value: result.value };
    case "invalid_json":
      return { invalid: "The response was not valid JSON." };
    case "refused":
      return {
        failed: {
          errorCode: "model_refused",
          detail: result.category ? { category: result.category } : {},
        },
      };
    case "truncated":
      return {
        failed: {
          errorCode: "output_truncated",
          detail: { stage: request.stage },
        },
      };
    case "error":
      return {
        failed: { errorCode: result.code, detail: { stage: request.stage } },
      };
  }
}

export async function runThemeGeneration(
  client: ThemeStudioModelClient,
  input: GenerationInput,
  signal: AbortSignal,
): Promise<GenerationOutcome> {
  const telemetry = new Telemetry(input.compile.modelKey);
  const fail = (
    errorCode: string,
    detail: Record<string, unknown> = {},
  ): GenerationOutcome => ({
    kind: "failed",
    errorCode,
    detail,
    telemetry: telemetry.snapshot(),
  });

  // ------------------------------------------------------------- Stage A
  const baseA = stageAUserText(
    input.facts,
    input.messages,
    input.references.length,
  );
  const images: ThemeStudioContentBlock[] = input.references.flatMap(
    (ref, index) => [
      {
        type: "text" as const,
        text: referenceLabel(index, input.references.length),
      },
      {
        type: "image" as const,
        mediaType: "image/webp" as const,
        base64: ref.base64,
      },
    ],
  );
  let intent: ThemeIntent | null = null;
  let previousA: unknown = null;
  let issuesA: string[] = [];
  for (
    let attempt = 0;
    attempt <= THEME_STUDIO_LIMITS.repairAttempts;
    attempt++
  ) {
    if (attempt > 0) telemetry.repairs.intent += 1;
    const userText =
      attempt === 0
        ? baseA
        : repairUserText("intent", baseA, previousA, issuesA);
    const response = await call(
      client,
      {
        stage: "intent",
        modelKey: input.compile.modelKey,
        providerModel: input.providerModel,
        system: stageASystemPrompt(),
        content: [{ type: "text", text: userText }, ...images],
        schema: STAGE_A_ENVELOPE_SCHEMA,
        maxTokens: STAGE_A_MAX_TOKENS,
        effort: "high",
      },
      telemetry,
      attempt,
      signal,
    );
    if ("failed" in response)
      return fail(response.failed.errorCode, response.failed.detail);
    if ("invalid" in response) {
      previousA = null;
      issuesA = [response.invalid];
      continue;
    }
    previousA = response.value;
    const envelope = response.value;
    if (!isRec(envelope)) {
      issuesA = ["The response must be a JSON object."];
      continue;
    }
    if (envelope.decision === "clarify") {
      const questions = (
        Array.isArray(envelope.questions) ? envelope.questions : []
      )
        .filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        )
        .map((q) => q.trim().slice(0, 300))
        .slice(0, MAX_QUESTIONS);
      if (questions.length === 0) {
        issuesA = ['A "clarify" decision must include at least one question.'];
        continue;
      }
      return { kind: "clarify", questions, telemetry: telemetry.snapshot() };
    }
    if (envelope.decision === "decline") {
      const reason =
        typeof envelope.declineReason === "string" &&
        envelope.declineReason.trim()
          ? envelope.declineReason.trim().slice(0, 500)
          : "The model declined without giving a reason.";
      return { kind: "declined", reason, telemetry: telemetry.snapshot() };
    }
    const parsed = validateThemeIntent(normalizeIntent(envelope.intent));
    if (parsed.ok) {
      intent = parsed.value;
      break;
    }
    issuesA = parsed.issues;
  }
  if (!intent) return fail("invalid_output", { stage: "intent" });

  // ------------------------------------------------------------- Stage B
  const compileFacts: CompileFacts = {
    ...input.compile,
    promptVersion: input.promptVersion,
  };
  const baseB = stageBUserText(input.facts, intent);
  const placeholders = new Map<string, PlaceholderImage>();
  let previousB: unknown = null;
  let issuesB: string[] = [];
  for (
    let attempt = 0;
    attempt <= THEME_STUDIO_LIMITS.repairAttempts;
    attempt++
  ) {
    if (attempt > 0) telemetry.repairs.draft += 1;
    signal.throwIfAborted();
    const userText =
      attempt === 0
        ? baseB
        : repairUserText("draft", baseB, previousB, issuesB);
    const response = await call(
      client,
      {
        stage: "draft",
        modelKey: input.compile.modelKey,
        providerModel: input.providerModel,
        system: stageBSystemPrompt(),
        content: [{ type: "text", text: userText }],
        schema: STAGE_B_DRAFT_SCHEMA,
        maxTokens: STAGE_B_MAX_TOKENS,
        effort: "high",
      },
      telemetry,
      attempt,
      signal,
    );
    if ("failed" in response)
      return fail(response.failed.errorCode, response.failed.detail);
    if ("invalid" in response) {
      previousB = null;
      issuesB = [response.invalid];
      continue;
    }
    previousB = response.value;
    const prepared = prepareDraft(response.value, intent);
    if (!prepared.parts) {
      issuesB = prepared.issues;
      continue;
    }
    const color = String(
      (isRec(response.value) &&
        isRec(response.value.design) &&
        isRec(response.value.design.palette) &&
        response.value.design.palette.sand) ||
        "",
    );
    const slotAssets = new Map<string, PlaceholderImage>();
    for (const slot of prepared.slots) {
      const key = `${slot}|${color}`;
      let image = placeholders.get(key);
      if (!image) {
        image = await renderPlaceholder(
          placeholderSize(slotSpec(slot, intent).aspectRatio),
          color,
        );
        placeholders.set(key, image);
      }
      slotAssets.set(slot, image);
    }
    const compiled = assemblePackage(
      prepared.parts,
      compileFacts,
      intent,
      slotAssets,
      prepared.issues,
    );
    if (compiled.package) {
      return {
        kind: "version",
        intent,
        package: compiled.package,
        placeholders: slotAssets,
        telemetry: telemetry.snapshot(),
      };
    }
    issuesB = compiled.issues;
  }
  return fail("invalid_output", { stage: "draft" });
}
