import "server-only";

import type { MinkConfig } from "./config";
import { MinkAgentError } from "./errors";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkModelSession,
  MinkRunEvent,
  MinkRunProgress,
  MinkRunResult,
  MinkUsage,
} from "./types";
import type { MinkToolRegistry } from "./tools/registry";

const EMPTY_USAGE: MinkUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
};

export async function runMinkAgent(input: {
  actor: MinkActorContext;
  message: string;
  config: MinkConfig;
  registry: MinkToolRegistry;
  session: MinkModelSession;
  onEvent?: (event: MinkRunEvent) => void | Promise<void>;
  onProgress?: (progress: MinkRunProgress) => void;
}): Promise<MinkRunResult> {
  const { actor, message, config, registry, session, onEvent, onProgress } =
    input;
  let usage = { ...EMPTY_USAGE };
  let steps = 1;
  let toolCalls = 0;
  let retryCount = 0;
  const artifacts: MinkArtifact[] = [];
  let turn = await session.sendUserMessage(message);
  usage = addUsage(usage, turn.usage);
  retryCount += turn.retryCount;
  onProgress?.({ steps, toolCalls, retryCount, usage: { ...usage } });

  while (turn.functionCalls.length > 0) {
    if (steps >= config.maxSteps) {
      throw new MinkAgentError(
        "step_limit_reached",
        "Mink AI reached its reasoning-step limit before finishing.",
      );
    }
    if (toolCalls + turn.functionCalls.length > config.maxToolCalls) {
      throw new MinkAgentError(
        "tool_limit_reached",
        "Mink AI requested too many store reads in one run.",
      );
    }

    const responses = [];
    for (
      let offset = 0;
      offset < turn.functionCalls.length;
      offset += config.maxParallelReadTools
    ) {
      const batch = turn.functionCalls.slice(
        offset,
        offset + config.maxParallelReadTools,
      );
      await Promise.all(
        batch.map((call, batchIndex) =>
          onEvent?.({
            type: "tool_call",
            sequence: toolCalls + offset + batchIndex + 1,
            call,
          }),
        ),
      );
      const batchResponses = await Promise.all(
        batch.map((call) => registry.execute(actor, call)),
      );
      await Promise.all(
        batchResponses.map((response, batchIndex) => {
          const errorCode = toolErrorCode(response.response);
          return onEvent?.({
            type: "tool_result",
            sequence: toolCalls + offset + batchIndex + 1,
            name: response.name,
            ok: !errorCode,
            ...(errorCode ? { errorCode } : {}),
            ...(response.artifact ? { artifact: response.artifact } : {}),
          });
        }),
      );
      responses.push(...batchResponses);
      for (const response of batchResponses) {
        if (response.artifact && artifacts.length < 6) {
          artifacts.push(response.artifact);
        }
      }
    }

    toolCalls += turn.functionCalls.length;
    steps += 1;
    onProgress?.({ steps, toolCalls, retryCount, usage: { ...usage } });
    turn = await session.sendToolResponses(responses);
    usage = addUsage(usage, turn.usage);
    retryCount += turn.retryCount;
    onProgress?.({ steps, toolCalls, retryCount, usage: { ...usage } });
  }

  if (!turn.text) {
    throw new MinkAgentError(
      "empty_model_response",
      "Mink AI returned an empty response.",
    );
  }

  return {
    text: turn.text,
    model: config.model,
    steps,
    toolCalls,
    retryCount,
    usage,
    artifacts,
  };
}

function toolErrorCode(response: Record<string, unknown>): string | undefined {
  const error = response.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : "tool_failed";
}

function addUsage(left: MinkUsage, right: MinkUsage): MinkUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtTokens: left.thoughtTokens + right.thoughtTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    // Summed like every other counter: each step re-sends the same prefix, so
    // the run-level figure is how many prefix tokens the cache served across
    // ALL steps — which is the number the cost estimate needs.
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}
