import { describe, expect, it, vi } from "vitest";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext } from "../types";
import { MinkToolRegistry, type MinkTool } from "./registry";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "member",
    permissions: {},
    isSuperadmin: false,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "request-1",
    ...overrides,
  };
}

function tool(overrides: Partial<MinkTool> = {}): MinkTool {
  return {
    declaration: {
      name: "read_products",
      description: "Read products.",
      parametersJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    permission: { section: "products", action: "view" },
    timeoutMs: 5_000,
    execute: vi.fn(async (ctx) => ({ storeIdUsed: ctx.storeId })),
    ...overrides,
  };
}

describe("MinkToolRegistry", () => {
  it("only declares tools allowed by trusted actor permissions", () => {
    const registry = new MinkToolRegistry([tool()]);

    expect(registry.declarationsFor(actor())).toEqual([]);
    expect(
      registry.declarationsFor(
        actor({ permissions: { products: ["manage"] } }),
      ),
    ).toHaveLength(1);
  });

  it("rechecks permissions when a hidden tool name is submitted directly", async () => {
    const execute = vi.fn(async () => ({ secret: "should not run" }));
    const registry = new MinkToolRegistry([tool({ execute })]);

    const response = await registry.execute(actor(), {
      id: "call-1",
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: "call-1",
      name: "read_products",
      response: {
        error: {
          code: "permission_denied",
          message: "The current admin is not allowed to use this tool.",
        },
      },
    });
  });

  it("passes the server actor unchanged and converts input errors safely", async () => {
    const execute = vi.fn(async (ctx: MinkActorContext) => {
      expect(ctx.storeId).toBe("store-1");
      throw new MinkToolInputError("query is invalid.");
    });
    const registry = new MinkToolRegistry([tool({ execute })]);
    const trustedActor = actor({ permissions: { products: ["view"] } });

    const response = await registry.execute(trustedActor, {
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).toHaveBeenCalledWith(trustedActor, {
      storeId: "other-store",
    });
    expect(response.response).toEqual({
      error: { code: "invalid_tool_input", message: "query is invalid." },
    });
  });

  it("rejects duplicate names so one tool cannot shadow another", () => {
    expect(() => new MinkToolRegistry([tool(), tool()])).toThrow(
      "Duplicate Mink tool: read_products",
    );
  });

  it("bounds a stalled read and returns a safe tool error", async () => {
    const registry = new MinkToolRegistry([
      tool({
        timeoutMs: 1,
        execute: vi.fn(() => new Promise<Record<string, unknown>>(() => {})),
      }),
    ]);

    await expect(
      registry.execute(actor({ permissions: { products: ["view"] } }), {
        name: "read_products",
        args: {},
      }),
    ).resolves.toMatchObject({
      response: {
        error: {
          code: "tool_timeout",
        },
      },
    });
  });
});

describe("per-actor declarations", () => {
  it("narrows the declaration to what this actor can satisfy", () => {
    const registry = new MinkToolRegistry([
      tool({
        declarationFor: (a) => ({
          name: "read_products",
          description: "Read products.",
          parametersJsonSchema: {
            type: "object",
            properties: {},
            required: a.isSuperadmin ? ["cover"] : [],
            additionalProperties: false,
          },
        }),
      }),
    ]);
    const limited = registry.declarationsFor(
      actor({ permissions: { products: ["view"] } }),
    );
    expect(
      (limited[0].parametersJsonSchema as { required: string[] }).required,
    ).toEqual([]);
    const full = registry.declarationsFor(actor({ isSuperadmin: true }));
    expect(
      (full[0].parametersJsonSchema as { required: string[] }).required,
    ).toEqual(["cover"]);
  });

  it("falls back to the static declaration when a tool defines none", () => {
    const registry = new MinkToolRegistry([tool()]);
    expect(
      registry
        .declarationsFor(actor({ permissions: { products: ["view"] } }))
        .map((d) => d.name),
    ).toEqual(["read_products"]);
  });

  // The registry is keyed on `declaration.name`, so a variant that renamed the
  // tool would be routable to the model and unroutable on the way back.
  it("is still executable under its registered name", async () => {
    const registry = new MinkToolRegistry([
      tool({
        declarationFor: () => ({
          name: "read_products",
          description: "Narrowed.",
          parametersJsonSchema: { type: "object", properties: {} },
        }),
      }),
    ]);
    const a = actor({ permissions: { products: ["view"] } });
    const [declared] = registry.declarationsFor(a);
    const result = await registry.execute(a, { name: declared.name, args: {} });
    expect(result.response.output).toEqual({ storeIdUsed: "store-1" });
  });
});
