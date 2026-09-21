import "server-only";

import { can } from "@/app/dashboard/lib/permissions";
import { logError } from "@/lib/observability/logger";
import {
  MinkRequestError,
  MinkToolInputError,
  MinkToolTimeoutError,
} from "../errors";
import type {
  MinkActorContext,
  MinkToolCall,
  MinkToolDeclaration,
  MinkArtifact,
  MinkToolPermission,
  MinkToolResponse,
} from "../types";

export interface MinkTool {
  declaration: MinkToolDeclaration;
  /**
   * A declaration narrowed to what THIS actor can actually satisfy.
   *
   * ★ IT EXISTS FOR REQUIRED ARGUMENTS THE ACTOR CANNOT OBTAIN. A tool is
   *   offered on its own permission, but an argument may only be produceable
   *   by a DIFFERENT tool behind a DIFFERENT permission - and declaring that
   *   argument required then guarantees the call fails for a role that is
   *   otherwise entitled to the tool. `propose_blog_draft` is the case: every
   *   cover URL comes from `list_storefront_media` (media:view),
   *   `generate_storefront_image` (media:manage) or the catalogue reads
   *   (products:view), so for a blogs:manage-only admin a mandatory
   *   `cover_image_url` is an argument nothing on the platform can give them.
   *
   * ⚠ IT MUST NOT CHANGE THE NAME - the registry is keyed on
   *   `declaration.name`, so a renamed variant would be unroutable. And it is
   *   NOT an authorization boundary: `execute` still re-derives every rule
   *   from the actor, exactly as it does for tool visibility.
   */
  declarationFor?: (actor: MinkActorContext) => MinkToolDeclaration;
  permission: MinkToolPermission;
  timeoutMs: number;
  /**
   * A successful human-review artifact that is sufficient to finish the run
   * without asking the model for one more prose-only turn.
   *
   * This is an opt-in escape hatch for a final tool call the model has already
   * selected on the configured last reasoning turn. Keep it off reads, image
   * generation, workflows and live actions: those may still need another tool
   * or a model explanation, and running them at the cap could spend money or
   * mutate state before reporting a failed run.
   */
  stepLimitCompletionText?: string;
  /**
   * A PURE read: calling it twice with the same arguments inside one run
   * returns the same thing and changes nothing. The orchestrator serves the
   * second call from its per-run memo instead of spending tool budget on it.
   *
   * ⚠ OPT-IN, and it must stay opt-in. The default has to be "not safe", or a
   * tool added later silently becomes de-duplicable — and the ones that are
   * NOT safe here are the ones that queue a durable workflow, create a
   * proposal, or spend money on an image.
   */
  repeatSafe?: boolean;
  available?: (actor: MinkActorContext) => boolean;
  artifact?: (output: Record<string, unknown>) => MinkArtifact | undefined;
  execute: (
    actor: MinkActorContext,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export class MinkToolRegistry {
  private readonly tools: Map<string, MinkTool>;

  constructor(tools: MinkTool[]) {
    this.tools = new Map();
    for (const tool of tools) {
      const name = tool.declaration.name;
      if (this.tools.has(name)) throw new Error(`Duplicate Mink tool: ${name}`);
      this.tools.set(name, tool);
    }
  }

  /** Whether a repeated identical call may be served from a per-run memo. */
  isRepeatSafe(name: string): boolean {
    return this.tools.get(name)?.repeatSafe === true;
  }

  /** Deterministic success copy for an explicitly safe last-turn finalizer. */
  stepLimitCompletionText(name: string): string | undefined {
    return this.tools.get(name)?.stepLimitCompletionText;
  }

  declarationsFor(actor: MinkActorContext): MinkToolDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => this.allowed(actor, tool))
      .map((tool) => tool.declarationFor?.(actor) ?? tool.declaration);
  }

  async execute(
    actor: MinkActorContext,
    call: MinkToolCall,
  ): Promise<MinkToolResponse> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return failure(call, "unknown_tool", "That tool is not available.");
    }
    // The model only sees permitted declarations, but this check is the real
    // boundary. Never rely on tool visibility as authorization.
    if (!this.allowed(actor, tool)) {
      return failure(
        call,
        "permission_denied",
        "The current admin is not allowed to use this tool.",
      );
    }

    try {
      const output = await executeWithTimeout(
        () => tool.execute(actor, call.args),
        tool.timeoutMs,
      );
      const artifact = tool.artifact?.(output);
      return {
        id: call.id,
        name: call.name,
        response: { output },
        ...(artifact ? { artifact } : {}),
      };
    } catch (error) {
      if (error instanceof MinkToolInputError) {
        return failure(call, "invalid_tool_input", error.message);
      }
      if (error instanceof MinkToolTimeoutError) {
        return failure(
          call,
          "tool_timeout",
          "The Mink AI tool took too long. Try a narrower request.",
        );
      }
      // ★★ A `MinkRequestError` CARRIES AN AUTHOR-WRITTEN, MERCHANT-SAFE
      //    SENTENCE - it is the same text the HTTP routes return - and the
      //    catch-all below replaced every one of them with "could not finish
      //    right now". That is the difference between the model rephrasing
      //    "choose another image and try again" and it retrying the same
      //    failing input until the run's tool budget is gone. Only the
      //    MESSAGE is forwarded; the code stays in this file's own closed
      //    vocabulary, and anything unrecognised still falls through to the
      //    generic text so no database or stack detail can reach the model.
      if (error instanceof MinkRequestError) {
        logError("mink.tool: request failed", error, {
          requestId: actor.requestId,
          storeId: actor.storeId,
          adminId: actor.adminId,
          tool: call.name,
        });
        return failure(call, "tool_failed", error.message);
      }
      logError("mink.tool: failed", error, {
        requestId: actor.requestId,
        storeId: actor.storeId,
        adminId: actor.adminId,
        tool: call.name,
      });
      // Do not put database or stack details back into the model context.
      return failure(
        call,
        "tool_failed",
        "The Mink AI tool could not finish right now.",
      );
    }
  }

  private allowed(actor: MinkActorContext, tool: MinkTool): boolean {
    return (
      (tool.available?.(actor) ?? true) &&
      can(
        actor.permissions,
        tool.permission.section,
        tool.permission.action,
        actor.isSuperadmin,
      )
    );
  }
}

async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new MinkToolTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failure(
  call: MinkToolCall,
  code: string,
  message: string,
): MinkToolResponse {
  return {
    id: call.id,
    name: call.name,
    response: { error: { code, message } },
  };
}
