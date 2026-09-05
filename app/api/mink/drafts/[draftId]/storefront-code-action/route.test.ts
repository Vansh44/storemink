import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  revalidatePath: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/cache", () => ({ revalidatePath: holder.revalidatePath }));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/storefront-code-actions", () => ({
  previewMinkStorefrontCodeAction: holder.preview,
  executeMinkStorefrontCodeAction: holder.execute,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const PARAMS = { params: Promise.resolve({ draftId: DRAFT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    draftingEnabled: true,
  });
  holder.preview.mockResolvedValue({ id: APPROVAL_ID, draftId: DRAFT_ID });
  holder.execute.mockResolvedValue({
    approval: {
      id: APPROVAL_ID,
      resource: {
        dashboardPath: "/dashboard/builder?page=home&section=hero-code",
      },
    },
    auditId: "audit-1",
    repeated: false,
  });
});

describe("Mink Phase 7C storefront code action API", () => {
  it("rejects cross-origin mutations before authentication", async () => {
    const response = await POST(
      request(
        {
          action: "preview",
          expectedDraftVersion: 0,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        "https://attacker.example",
      ),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("creates approval from the immutable version-zero proposal", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 0,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("rejects browser-supplied code and target fields", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        html: "<script>steal()</script>",
        pageId: "attacker-page",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("rejects mutable storefront draft versions before authentication", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.preview).not.toHaveBeenCalled();
  });

  it("executes only by approval id and revalidates private Builder paths", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.execute).toHaveBeenCalledWith({
      actor: expect.objectContaining({ adminId: "admin-1" }),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });
    expect(holder.revalidatePath).toHaveBeenCalledWith("/dashboard/builder");
    expect(holder.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/builder?page=home&section=hero-code",
    );
    expect(holder.revalidatePath).not.toHaveBeenCalledWith("/");
  });

  it("returns safe action conflicts", async () => {
    holder.execute.mockRejectedValueOnce(
      new MinkRequestError(
        "mink_storefront_target_conflict",
        "The Website Builder page changed. Nothing was saved.",
        409,
      ),
    );
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "mink_storefront_target_conflict",
    });
    expect(holder.revalidatePath).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/storefront-code-action`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        host: "acme.storemink.com",
      },
      body: JSON.stringify(body),
    },
  );
}
