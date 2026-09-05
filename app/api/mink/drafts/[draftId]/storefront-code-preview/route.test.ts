import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  preview: vi.fn(),
  latestAction: vi.fn(),
  latestPublication: vi.fn(),
  rateAllowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: holder.enabled,
    betaRequireInvite: true,
  })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/storefront-code-proposals", () => ({
  getMinkStorefrontCodePreview: holder.preview,
}));
vi.mock("@/lib/mink/storefront-code-actions", () => ({
  getLatestMinkStorefrontCodeAction: holder.latestAction,
}));
vi.mock("@/lib/mink/storefront-publication-actions", () => ({
  getLatestMinkStorefrontPublication: holder.latestPublication,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET } from "./route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    draftingEnabled: true,
    permissions: { builder: ["view", "manage"] },
  });
  holder.preview.mockResolvedValue({ id: DRAFT_ID, targetState: "current" });
  holder.latestAction.mockResolvedValue(null);
  holder.latestPublication.mockResolvedValue(null);
});

describe("GET /api/mink/drafts/[draftId]/storefront-code-preview", () => {
  it("returns only an owner-scoped, non-cacheable private preview", async () => {
    const response = await GET(request(), params(DRAFT_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(holder.preview).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      DRAFT_ID,
    );
    expect(await response.json()).toEqual({
      preview: { id: DRAFT_ID, targetState: "current" },
      lastAction: null,
      lastPublication: null,
    });
  });

  it("rejects malformed ids before authentication", async () => {
    const response = await GET(request(), params("not-a-draft"));
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("is unavailable behind the global kill switch", async () => {
    holder.enabled = false;
    const response = await GET(request(), params(DRAFT_ID));
    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits per trusted actor before loading code", async () => {
    holder.rateAllowed = false;
    const response = await GET(request(), params(DRAFT_ID));
    expect(response.status).toBe(429);
    expect(holder.preview).not.toHaveBeenCalled();
  });

  it("preserves safe permission errors without leaking internals", async () => {
    holder.preview.mockRejectedValueOnce(
      new MinkRequestError(
        "mink_storefront_preview_access_denied",
        "You don't have permission to open this private storefront preview.",
        403,
      ),
    );
    const response = await GET(request(), params(DRAFT_ID));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "You don't have permission to open this private storefront preview.",
      code: "mink_storefront_preview_access_denied",
    });
  });
});

function request() {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/storefront-code-preview`,
  );
}

function params(draftId: string) {
  return { params: Promise.resolve({ draftId }) };
}
