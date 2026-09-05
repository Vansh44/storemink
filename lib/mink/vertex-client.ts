import "server-only";

import {
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { MinkConfig } from "./config";
import { MinkAgentError } from "./errors";
import type {
  MinkActorContext,
  MinkModelSession,
  MinkModelTurn,
  MinkToolDeclaration,
  MinkUsage,
} from "./types";
import type { MinkStoredMessage } from "./persistence";
import { MinkRetryError, withMinkRetry } from "./retry";
import { renderMinkSystemInstruction } from "./system-prompt";
import type { MinkThinkingLevel } from "./thinking";

export function createVertexMinkSession(
  config: MinkConfig,
  actor: MinkActorContext,
  declarations: MinkToolDeclaration[],
  options: {
    history: MinkStoredMessage[];
    abortSignal?: AbortSignal;
    thinkingLevel?: MinkThinkingLevel;
  },
): MinkModelSession {
  if (!config.projectId) {
    throw new MinkAgentError(
      "vertex_not_configured",
      "Mink AI requires GCP_PROJECT_ID for Vertex AI.",
    );
  }

  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId,
    location: config.location,
    apiVersion: "v1",
    // Retry in StoreMink so the exact count is available in run telemetry.
    // The SDK is restricted to one attempt to avoid multiplying both policies.
    httpOptions: { retryOptions: { attempts: 1 } },
  });
  const functionDeclarations: FunctionDeclaration[] = declarations.map(
    (declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parametersJsonSchema: declaration.parametersJsonSchema,
    }),
  );
  const chat = ai.chats.create({
    model: config.model,
    history: toVertexHistory(options.history),
    config: {
      systemInstruction: renderMinkSystemInstruction(actor, declarations),
      maxOutputTokens: config.maxOutputTokens,
      thinkingConfig: {
        thinkingLevel:
          options.thinkingLevel === "high"
            ? ThinkingLevel.HIGH
            : ThinkingLevel.LOW,
      },
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(functionDeclarations.length
        ? { tools: [{ functionDeclarations }] }
        : {}),
    },
  });

  return {
    async sendUserMessage(message) {
      return send(message);
    },
    async sendToolResponses(responses) {
      const parts: Part[] = responses.map((result) => ({
        functionResponse: {
          ...(result.id ? { id: result.id } : {}),
          name: result.name,
          response: result.response,
        },
      }));
      return send(parts);
    },
  };

  async function send(message: string | Part[]): Promise<MinkModelTurn> {
    try {
      const result = await withMinkRetry({
        operation: () => chat.sendMessage({ message }),
        maxRetries: config.maxModelRetries,
        signal: options.abortSignal,
      });
      return { ...toTurn(result.value), retryCount: result.retryCount };
    } catch (error) {
      if (!(error instanceof MinkRetryError)) throw error;
      const status = providerStatus(error.originalError);
      const code =
        status === 401 || status === 403
          ? "provider_auth_failed"
          : status !== null && status >= 400 && status < 500 && status !== 429
            ? "provider_request_rejected"
            : "provider_unavailable";
      throw new MinkAgentError(
        code,
        code === "provider_unavailable"
          ? "Mink AI's model is temporarily unavailable. Try again shortly."
          : "Mink AI couldn't use its configured model.",
        error.retryCount,
      );
    }
  }
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function toVertexHistory(history: MinkStoredMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text }],
  }));
}

function toTurn(response: GenerateContentResponse): MinkModelTurn {
  const functionCalls = (response.functionCalls ?? []).flatMap((call) =>
    call.name
      ? [
          {
            id: call.id,
            name: call.name,
            args: call.args ?? {},
          },
        ]
      : [],
  );
  return {
    // Reading response.text on a function-call turn makes the SDK warn about
    // non-text parts. Pull only visible, non-thought text from the candidate.
    text:
      response.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("")
        .trim() ?? "",
    functionCalls,
    usage: toUsage(response),
    retryCount: 0,
  };
}

function toUsage(response: GenerateContentResponse): MinkUsage {
  const usage = response.usageMetadata;
  return {
    promptTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thoughtTokens: usage?.thoughtsTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
  };
}
