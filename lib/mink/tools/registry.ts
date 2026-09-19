import "server-only";

import { can } from "@/app/dashboard/lib/permissions";
import { logError } from "@/lib/observability/logger";
import { MinkToolInputError, MinkToolTimeoutError } from "../errors";
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
  permission: MinkToolPermission;
  timeoutMs: number;
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

  declarationsFor(actor: MinkActorContext): MinkToolDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => this.allowed(actor, tool))
      .map((tool) => tool.declaration);
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
