import "server-only";

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  minkConversations,
  minkFeedback,
  minkMessages,
  minkRuns,
  minkToolCalls,
  minkUsageLedger,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { estimateMinkCost } from "./cost";
import { historyWithCompaction } from "./compaction";
import { MinkRequestError } from "./errors";
import { minkShadowMeter } from "./metering";
import { discardFailedMinkRunDrafts, getMinkRunDraftUsage } from "./drafts";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkFeedbackIssue,
  MinkFeedbackRating,
  MinkRunProgress,
  MinkRunResult,
  MinkToolCall,
} from "./types";
import type { MinkThinkingLevel } from "./thinking";

const DISPLAY_MESSAGES = 50;
export const MINK_CONVERSATION_LIMIT = 10;

export interface MinkStoredMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MinkStartedRun {
  conversationId: string;
  runId: string;
  history: MinkStoredMessage[];
}

export interface MinkConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface MinkConversationMessage extends MinkStoredMessage {
  id: string;
  runId: string;
  createdAt: string;
  artifacts: MinkArtifact[];
  feedback: {
    rating: MinkFeedbackRating;
    issueCategory: MinkFeedbackIssue | null;
  } | null;
}

export interface MinkConversationDetail {
  id: string;
  title: string;
  messages: MinkConversationMessage[];
}

export type MinkUsageStatus = "reported" | "partial" | "unavailable";

export async function listMinkConversations(
  actor: MinkActorContext,
): Promise<MinkConversationSummary[]> {
  const now = new Date().toISOString();
  return withService((db) =>
    db
      .select({
        id: minkConversations.id,
        title: minkConversations.title,
        lastMessageAt: minkConversations.lastMessageAt,
        createdAt: minkConversations.createdAt,
      })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
          gt(minkConversations.expiresAt, now),
        ),
      )
      .orderBy(
        desc(minkConversations.lastMessageAt),
        desc(minkConversations.createdAt),
        desc(minkConversations.id),
      )
      .limit(MINK_CONVERSATION_LIMIT),
  );
}

export async function getMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<MinkConversationDetail> {
  const now = new Date().toISOString();
  return withService(async (db) => {
    const conversations = await db
      .select({
        id: minkConversations.id,
        title: minkConversations.title,
      })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
          eq(minkConversations.status, "active"),
          gt(minkConversations.expiresAt, now),
        ),
      )
      .limit(1);
    const conversation = conversations[0];
    if (!conversation) {
      throw new MinkRequestError(
        "conversation_not_found",
        "That Mink AI conversation is no longer available.",
        404,
      );
    }

    const rows = await db
      .select({
        id: minkMessages.id,
        role: minkMessages.role,
        content: minkMessages.contentJson,
        runId: minkMessages.runId,
        createdAt: minkMessages.createdAt,
        feedbackRating: minkFeedback.rating,
        feedbackIssueCategory: minkFeedback.issueCategory,
      })
      .from(minkMessages)
      .innerJoin(
        minkRuns,
        and(
          eq(minkRuns.id, minkMessages.runId),
          eq(minkRuns.storeId, minkMessages.storeId),
          eq(minkRuns.status, "succeeded"),
        ),
      )
      .leftJoin(
        minkFeedback,
        and(
          eq(minkFeedback.runId, minkMessages.runId),
          eq(minkFeedback.storeId, actor.storeId),
          eq(minkFeedback.adminId, actor.adminId),
        ),
      )
      .where(
        and(
          eq(minkMessages.storeId, actor.storeId),
          eq(minkMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(DISPLAY_MESSAGES);

    return {
      ...conversation,
      messages: rows.reverse().flatMap(toConversationMessage),
    };
  });
}

export async function deleteMinkConversation(
  actor: MinkActorContext,
  conversationId: string,
): Promise<void> {
  await withService(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mink-conversation:${conversationId}`}, 0))`,
    );
    const running = await db
      .select({ id: minkRuns.id })
      .from(minkRuns)
      .where(
        and(
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.conversationId, conversationId),
          eq(minkRuns.status, "running"),
        ),
      )
      .limit(1);
    if (running[0]) {
      throw new MinkRequestError(
        "conversation_busy",
        "Wait for Mink AI to finish before deleting this conversation.",
        409,
      );
    }

    const deleted = await db
      .delete(minkConversations)
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      )
      .returning({ id: minkConversations.id });
    if (!deleted[0]) {
      throw new MinkRequestError(
        "conversation_not_found",
        "That Mink AI conversation is no longer available.",
        404,
      );
    }
  });
}

export async function startMinkRun(input: {
  actor: MinkActorContext;
  conversationId?: string;
  message: string;
  model: string;
  thinkingLevel?: MinkThinkingLevel;
}): Promise<MinkStartedRun> {
  const { actor, message, model } = input;
  const now = new Date().toISOString();

  return withService(async (db) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mink-conversation:${conversationId}`}, 0))`,
      );
      const existing = await db
        .select({ id: minkConversations.id })
        .from(minkConversations)
        .where(
          and(
            eq(minkConversations.id, conversationId),
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
            eq(minkConversations.status, "active"),
            gt(minkConversations.expiresAt, now),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        throw new MinkRequestError(
          "conversation_not_found",
          "That Mink AI conversation is no longer available. Start a new conversation.",
          404,
        );
      }
    } else {
      // Serialise first-message creation for this actor/store so two tabs
      // cannot both observe ten rows and leave eleven after committing.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mink-conversations:${actor.storeId}:${actor.adminId}`}, 0))`,
      );
      const created = await db
        .insert(minkConversations)
        .values({
          storeId: actor.storeId,
          adminId: actor.adminId,
          title: conversationTitle(message),
        })
        .returning({ id: minkConversations.id });
      conversationId = created[0]?.id;
      if (!conversationId)
        throw new Error("Mink conversation insert returned no id");

      const overflow = await db
        .select({ id: minkConversations.id })
        .from(minkConversations)
        .where(
          and(
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
          ),
        )
        .orderBy(
          desc(minkConversations.lastMessageAt),
          desc(minkConversations.createdAt),
          desc(minkConversations.id),
        )
        .offset(MINK_CONVERSATION_LIMIT);
      if (overflow.length) {
        await db.delete(minkConversations).where(
          and(
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
            inArray(
              minkConversations.id,
              overflow.map((row) => row.id),
            ),
          ),
        );
      }
    }

    const previous = await db
      .select({
        role: minkMessages.role,
        content: minkMessages.contentJson,
      })
      .from(minkMessages)
      .innerJoin(
        minkRuns,
        and(
          eq(minkRuns.id, minkMessages.runId),
          eq(minkRuns.storeId, minkMessages.storeId),
          eq(minkRuns.status, "succeeded"),
        ),
      )
      .where(
        and(
          eq(minkMessages.storeId, actor.storeId),
          eq(minkMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(DISPLAY_MESSAGES);

    const compacted = historyWithCompaction(
      previous.reverse().flatMap(toStoredMessage),
    );
    if (compacted.summary) {
      await db
        .update(minkConversations)
        .set({
          summaryJson: { text: compacted.summary },
          summarizedMessageCount: compacted.summarizedMessageCount,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkConversations.id, conversationId),
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
          ),
        );
    }

    const createdRuns = await db
      .insert(minkRuns)
      .values({
        storeId: actor.storeId,
        conversationId,
        requestedBy: actor.adminId,
        requestId: actor.requestId,
        model,
        thinkingLevel: input.thinkingLevel ?? "low",
        promptVersion: actor.draftingEnabled
          ? "draft-action-beta-v19"
          : "read-beta-v8",
        toolRegistryVersion: actor.draftingEnabled
          ? "draft-beta-v14"
          : "read-beta-v8",
        riskTier: actor.draftingEnabled ? "R1" : "R0",
        currentPath: actor.currentPath ?? null,
        selectedResourceType: actor.selectedResource?.type ?? null,
        selectedResourceId: actor.selectedResource?.id ?? null,
      })
      .returning({ id: minkRuns.id });
    const runId = createdRuns[0]?.id;
    if (!runId) throw new Error("Mink run insert returned no id");

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId,
      runId,
      role: "user",
      contentJson: { text: message },
      model: null,
    });
    await db
      .update(minkConversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );

    return {
      conversationId,
      runId,
      history: compacted.history,
    };
  });
}

export async function completeMinkRun(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  result: MinkRunResult;
  latencyMs: number;
  pricingLocation: string;
}): Promise<void> {
  const { actor, started, result } = input;
  const completedAt = new Date().toISOString();
  await withService(async (db) => {
    const updated = await db
      .update(minkRuns)
      .set({
        status: "succeeded",
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.outputTokens,
        thoughtTokens: result.usage.thoughtTokens,
        totalTokens: result.usage.totalTokens,
        stepCount: result.steps,
        toolCallCount: result.toolCalls,
        retryCount: result.retryCount,
        latencyMs: input.latencyMs,
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, started.runId),
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.requestedBy, actor.adminId),
          eq(minkRuns.status, "running"),
        ),
      )
      .returning({ id: minkRuns.id });
    if (!updated[0]) throw new Error("Mink run was not in a completable state");

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId: started.conversationId,
      runId: started.runId,
      role: "assistant",
      contentJson: { text: result.text, artifacts: result.artifacts },
      model: result.model,
    });
    await insertUsage(db, {
      actor,
      started,
      model: result.model,
      pricingLocation: input.pricingLocation,
      usage: result.usage,
      usageStatus: "reported",
      status: "succeeded",
      toolCalls: result.toolCalls,
    });
    await db
      .update(minkConversations)
      .set({ lastMessageAt: completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(minkConversations.id, started.conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );
  });
}

export async function failMinkRun(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  status: "failed" | "cancelled";
  errorCode: string;
  latencyMs: number;
  model: string;
  pricingLocation: string;
  progress: MinkRunProgress;
  usageStatus: MinkUsageStatus;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  await withService(async (db) => {
    await db
      .update(minkToolCalls)
      .set({
        status: "failed",
        resultSummary: { ok: false },
        errorCode: input.status === "cancelled" ? "cancelled" : "run_failed",
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, input.actor.storeId),
          eq(minkToolCalls.runId, input.started.runId),
          eq(minkToolCalls.status, "running"),
        ),
      );
    await db
      .update(minkRuns)
      .set({
        status: input.status,
        errorCode: safeErrorCode(input.errorCode),
        inputTokens: input.progress.usage.promptTokens,
        outputTokens: input.progress.usage.outputTokens,
        thoughtTokens: input.progress.usage.thoughtTokens,
        totalTokens: input.progress.usage.totalTokens,
        stepCount: input.progress.steps,
        toolCallCount: input.progress.toolCalls,
        retryCount: input.progress.retryCount,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, input.started.runId),
          eq(minkRuns.storeId, input.actor.storeId),
          eq(minkRuns.requestedBy, input.actor.adminId),
          eq(minkRuns.status, "running"),
        ),
      );
    await discardFailedMinkRunDrafts(
      db,
      input.actor.storeId,
      input.started.runId,
    );
    await insertUsage(db, {
      actor: input.actor,
      started: input.started,
      model: input.model,
      pricingLocation: input.pricingLocation,
      usage: input.progress.usage,
      usageStatus: input.usageStatus,
      status: input.status,
      toolCalls: input.progress.toolCalls,
    });
  });
}

export async function startMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  call: MinkToolCall;
}): Promise<void> {
  await withService((db) =>
    db.insert(minkToolCalls).values({
      storeId: input.actor.storeId,
      runId: input.started.runId,
      sequence: input.sequence,
      providerCallId: input.call.id ?? null,
      toolName: input.call.name,
      toolVersion: input.call.name.startsWith("propose_") ? 4 : 2,
      riskTier: input.call.name.startsWith("propose_") ? "R1" : "R0",
      // Arguments intentionally stay redacted in the alpha ledger. The model
      // receives them, but telemetry never needs a product search phrase.
      argumentsSummary: {},
    }),
  );
}

export async function completeMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  ok: boolean;
  errorCode?: string;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  await withService((db) =>
    db
      .update(minkToolCalls)
      .set({
        status: input.ok ? "succeeded" : "failed",
        resultSummary: { ok: input.ok },
        errorCode: input.errorCode ? safeErrorCode(input.errorCode) : null,
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, input.actor.storeId),
          eq(minkToolCalls.runId, input.started.runId),
          eq(minkToolCalls.sequence, input.sequence),
          eq(minkToolCalls.status, "running"),
        ),
      ),
  );
}

export function conversationTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= 80) return compact;
  return `${characters.slice(0, 77).join("").trimEnd()}…`;
}

function toStoredMessage(row: {
  role: string;
  content: unknown;
}): MinkStoredMessage[] {
  if (row.role !== "user" && row.role !== "assistant") return [];
  if (!row.content || typeof row.content !== "object") return [];
  const text = (row.content as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) return [];
  return [{ role: row.role, text }];
}

function toConversationMessage(row: {
  id: string;
  role: string;
  content: unknown;
  runId: string;
  createdAt: string;
  feedbackRating: string | null;
  feedbackIssueCategory: string | null;
}): MinkConversationMessage[] {
  const stored = toStoredMessage(row)[0];
  if (!stored) return [];
  const content = row.content as Record<string, unknown>;
  const artifacts = Array.isArray(content.artifacts)
    ? (content.artifacts as MinkArtifact[]).slice(0, 6)
    : [];
  const rating =
    row.feedbackRating === "helpful" || row.feedbackRating === "unhelpful"
      ? row.feedbackRating
      : null;
  const issueCategory = isFeedbackIssue(row.feedbackIssueCategory)
    ? row.feedbackIssueCategory
    : null;
  return [
    {
      ...stored,
      id: row.id,
      runId: row.runId,
      createdAt: row.createdAt,
      artifacts,
      feedback: rating ? { rating, issueCategory } : null,
    },
  ];
}

function isFeedbackIssue(value: unknown): value is MinkFeedbackIssue {
  return (
    value === "incorrect" ||
    value === "missing_context" ||
    value === "privacy" ||
    value === "slow" ||
    value === "other"
  );
}

function safeErrorCode(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return normalized || "mink_failed";
}

async function insertUsage(
  db: Db,
  input: {
    actor: MinkActorContext;
    started: MinkStartedRun;
    model: string;
    pricingLocation: string;
    usage: MinkRunProgress["usage"];
    usageStatus: MinkUsageStatus;
    status: "succeeded" | "failed" | "cancelled";
    toolCalls: number;
  },
): Promise<void> {
  const estimate =
    input.usageStatus === "unavailable"
      ? { estimatedCostMicrousd: null, pricingVersion: null }
      : estimateMinkCost({
          model: input.model,
          location: input.pricingLocation,
          usage: input.usage,
        });
  const shadow = minkShadowMeter({
    status: input.status,
    toolCalls: input.toolCalls,
    usageKnown: input.usageStatus !== "unavailable",
  });
  const draftUsage = await getMinkRunDraftUsage(
    db,
    input.actor.storeId,
    input.started.runId,
  );
  await db
    .insert(minkUsageLedger)
    .values({
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      runId: input.started.runId,
      model: input.model,
      inputTokens: input.usage.promptTokens,
      outputTokens: input.usage.outputTokens,
      thoughtTokens: input.usage.thoughtTokens,
      totalTokens: input.usage.totalTokens,
      usageStatus: input.usageStatus,
      estimatedCostMicrousd: estimate.estimatedCostMicrousd,
      pricingVersion: estimate.pricingVersion,
      // Read-only work remains shadow-metered. Phase 3 proposal tools reserve
      // their documented weight atomically and are summed into this run row.
      chargedCredits: draftUsage.chargedCredits,
      shadowCredits: shadow.shadowCredits,
      costCohort:
        draftUsage.proposalCount > 0 ? "draft_proposal" : shadow.costCohort,
    })
    .onConflictDoNothing({ target: minkUsageLedger.runId });
}
