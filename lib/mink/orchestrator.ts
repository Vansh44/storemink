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
  MinkToolCall,
  MinkToolResponse,
  MinkUsage,
} from "./types";
import type { MinkToolRegistry } from "./tools/registry";

const EMPTY_USAGE: MinkUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  basePromptTokens: 0,
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
  // ★★ THE LEDGER SEQUENCE IS NOT THE BUDGET, AND SHARING ONE COUNTER KILLED
  // RUNS. `toolCalls` is what a run may SPEND, and the memo below deliberately
  // stopped counting repeats against it — but every emitted `tool_call` event
  // inserts a `mink_tool_calls` row, repeat or not, under a UNIQUE (run,
  // sequence). So the first turn containing a memo hit advanced the numbering
  // by one more than the budget, the next turn re-used a sequence, and the
  // insert was rejected: observed in production as a run dying on
  // `mink_tool_calls_run_sequence_key` at sequence 5, an error naming nothing
  // to do with the tool that had actually failed. Two jobs, two counters.
  let recorded = 0;
  let retryCount = 0;
  const artifacts: MinkArtifact[] = [];
  // ★★ PER-RUN, NEVER ON THE REGISTRY. The registry is a module-level
  // singleton shared by every request in the container, so a memo living
  // there would serve one store's reads to another. This map dies with the run.
  const memo = new Map<string, MinkToolResponse>();
  let turn = await session.sendUserMessage(message);
  usage = addUsage(usage, turn.usage);
  retryCount += turn.retryCount;
  onProgress?.({ steps, toolCalls, retryCount, usage: { ...usage } });

  while (turn.functionCalls.length > 0) {
    // ★★ THE MODEL HAS ALREADY SPENT THIS TURN. The production offer-banner
    // trace reached turn 12 after successfully creating its image, then
    // returned another function call. Rejecting at the top of this loop threw
    // away even the call's NAME before it was recorded; a final layout proposal
    // selected in that position could therefore never finish.
    // One explicitly marked human-review proposal may finish deterministically
    // here; reads, image generation, workflows, live actions and multiple calls
    // remain refused. This spends no thirteenth prose-only model turn.
    const stepLimitCompletionText =
      steps >= config.maxSteps && turn.functionCalls.length === 1
        ? registry.stepLimitCompletionText(turn.functionCalls[0].name)
        : undefined;
    if (steps >= config.maxSteps && !stepLimitCompletionText) {
      throw new MinkAgentError(
        "step_limit_reached",
        "Mink AI reached its reasoning-step limit before finishing.",
      );
    }
    // ★★ A REPEAT OF A PURE READ COSTS NO BUDGET. Observed on a live run that
    // failed at the step limit: 15 calls, every one SUCCEEDED, and 8 of them
    // were repeats of 4 reads it had already made — so it never reached the
    // tools that would have finished the job. The runtime prompt already asks
    // the model not to repeat a successful read; this makes it true whether it
    // complies or not. Only `repeatSafe` tools qualify, so nothing that queues
    // work, creates a proposal or spends money is ever served from here.
    const fresh = turn.functionCalls.filter((call) => !memo.has(memoKey(call)));
    if (toolCalls + fresh.length > config.maxToolCalls) {
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
            sequence: recorded + offset + batchIndex + 1,
            call,
          }),
        ),
      );
      const batchResults = await Promise.all(
        batch.map(async (call) => {
          const key = memoKey(call);
          const hit = memo.get(key);
          if (hit) {
            // ★ The id must belong to THIS call, not the one that originally
            // filled the memo, or the provider cannot pair the response up.
            return { response: repeatedResponse(hit, call.id), repeat: true };
          }
          const response = await registry.execute(actor, call);
          // ★ Only a SUCCESS is remembered. A failure is often transient, and
          // replaying it would deny the model its one legitimate retry.
          if (
            registry.isRepeatSafe(call.name) &&
            !toolErrorCode(response.response)
          ) {
            memo.set(key, response);
          }
          return { response, repeat: false };
        }),
      );
      const batchResponses = batchResults.map((r) => r.response);
      await Promise.all(
        batchResponses.map((response, batchIndex) => {
          const errorCode = toolErrorCode(response.response);
          return onEvent?.({
            type: "tool_result",
            sequence: recorded + offset + batchIndex + 1,
            name: response.name,
            ok: !errorCode,
            ...(errorCode ? { errorCode } : {}),
            ...(response.artifact ? { artifact: response.artifact } : {}),
          });
        }),
      );
      responses.push(...batchResponses);
      for (const { response, repeat } of batchResults) {
        // ⚠ A memo hit adds NO artifact: the card is already on screen from the
        // first call, and pushing it again renders a duplicate.
        if (repeat) continue;
        // ★★ THE CAP COUNTS READS, NOT PRODUCED ARTIFACTS. It was a flat six
        // over everything, and a proposal is produced LAST -- after the reads
        // that informed it -- so a read-heavy run could fill the buffer and
        // silently drop the proposal itself, costing the merchant the Apply
        // button they were waiting for and leaving only the research behind.
        // The observed banner run made five read cards.
        if (!response.artifact) continue;
        const produced = PRODUCED_ARTIFACTS.has(response.artifact.type);
        const counted = artifacts.filter(
          (artifact) => !PRODUCED_ARTIFACTS.has(artifact.type),
        ).length;
        if (produced || counted < 6) artifacts.push(response.artifact);
      }
    }

    // Only the calls actually executed count against the budget; the ledger
    // numbers every call the model made, including the ones the memo served.
    toolCalls += fresh.length;
    recorded += turn.functionCalls.length;
    if (stepLimitCompletionText) {
      // The opt-in is authority to finish only after the tool genuinely
      // succeeded and produced the review artifact its card needs. A tool
      // error or contract drift remains a failed run; never turn either into a
      // false success sentence.
      const completed = responses.every(
        (response) => !toolErrorCode(response.response),
      );
      const produced = responses.some(
        (response) =>
          response.artifact && PRODUCED_ARTIFACTS.has(response.artifact.type),
      );
      if (!completed || !produced) {
        throw new MinkAgentError(
          "step_limit_reached",
          "Mink AI reached its reasoning-step limit before finishing.",
        );
      }
      onProgress?.({ steps, toolCalls, retryCount, usage: { ...usage } });
      return {
        text: stepLimitCompletionText,
        model: config.model,
        steps,
        toolCalls,
        retryCount,
        usage,
        artifacts: presentableArtifacts(artifacts),
      };
    }
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
    artifacts: presentableArtifacts(artifacts),
  };
}

/**
 * Artifacts a run PRODUCED, as opposed to the reads that fed them.
 *
 * ★★ A READ CARD IS THE ANSWER TO A QUESTION AND THE WORKING-OUT OF A TASK,
 * and rendering both alike is what made "create a banner for this offer"
 * unreadable. Every read tool emits a card, and an action run necessarily makes
 * several -- the page's whole section list, the media library, each section it
 * inspected -- so the merchant was handed four or five cards of research
 * stacked in front of the one thing they asked for. Asked "what offers are
 * running", the same card IS the answer and still renders.
 *
 * ★ FILTERED AT THE END, NOT AT EMISSION. The tool is not what knows whether
 * its read was an answer or a step; only the finished run does. Live progress
 * events are untouched -- the client renders cards from the final message
 * alone, so this is what a merchant is left looking at and what history keeps.
 */
function presentableArtifacts(artifacts: MinkArtifact[]): MinkArtifact[] {
  const produced = artifacts.filter((artifact) =>
    PRODUCED_ARTIFACTS.has(artifact.type),
  );
  return produced.length > 0 ? produced : artifacts;
}

/**
 * ⚠ AN ALLOWLIST, so a read card added later is quiet by default and a new
 * PROPOSAL type has to be named here or it vanishes from its own run. The
 * failure directions are deliberately asymmetric: an unlisted read is noise, an
 * unlisted proposal is the merchant losing the button they were waiting for.
 * `clarification` counts as produced -- a question the run is asking IS its
 * result, and burying it under the reads that prompted it is the same defect.
 */
const PRODUCED_ARTIFACTS: ReadonlySet<MinkArtifact["type"]> = new Set([
  "proposal",
  "storefront_code_proposal",
  "storefront_layout_proposal",
  "storefront_design_proposal",
  "media_image_proposal",
  "workflow",
  "clarification",
]);

/**
 * Identity of a tool call for the per-run memo: the name plus its arguments,
 * with object keys sorted so `{a,b}` and `{b,a}` are one call.
 */
function memoKey(call: MinkToolCall): string {
  return `${call.name}\u0000${canonicalJson(call.args)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The remembered answer, handed back for a repeated call.
 *
 * ★ IT SAYS SO IN THE PAYLOAD. Returning the identical result silently invites
 * the model to ask a third time — it costs no budget now, but it still burns a
 * STEP, which is the limit the observed run actually hit. Naming the repeat is
 * the only signal available inside a tool response.
 */
function repeatedResponse(
  cached: MinkToolResponse,
  id: string | undefined,
): MinkToolResponse {
  const output = cached.response.output;
  const annotated =
    output && typeof output === "object" && !Array.isArray(output)
      ? {
          ...(output as Record<string, unknown>),
          alreadyRequestedInThisRun: true,
          note: "You already requested this exact read in this run; this is the same result. Do not request it again — continue with the task.",
        }
      : output;
  return {
    ...cached,
    ...(id === undefined ? {} : { id }),
    response: { ...cached.response, output: annotated },
    // The artifact is deliberately dropped: it was already emitted.
    artifact: undefined,
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
    // ★★ THE ONLY FIELD HERE THAT IS NOT A SUM. It is the size of the FIRST
    // turn's prompt, and every later turn re-sends that same prefix, so adding
    // them would produce roughly `steps²` of it and make the subtraction in
    // `weightedMinkUnits` over-shoot on every multi-step run. First non-zero
    // wins: `left` is the accumulator, so this keeps turn 1's figure for the
    // life of the run and lets a turn that reported no usage inherit it.
    basePromptTokens: left.basePromptTokens || right.basePromptTokens,
  };
}
