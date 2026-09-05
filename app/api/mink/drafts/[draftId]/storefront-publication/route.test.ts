import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  previewPublish: vi.fn(),
  previewRollback: vi.fn(),
  execute: vi.fn(),
  notify: vi.fn(),
  emitEvent: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/cache", () => ({
  revalidatePath: holder.revalidatePath,
  revalidateTag: holder.revalidateTag,
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (callback: () => unknown) => callback() };
});
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/storefront-publication-actions", () => ({
  previewMinkStorefrontPublication: holder.previewPublish,
  previewMinkStorefrontPublicationRollback: holder.previewRollback,
  executeMinkStorefrontPublication: holder.execute,
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: holder.notify,
}));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: holder.emitEvent,
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
const SAVE_APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const PUBLISH_APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const PARAMS = { params: Promise.resolve({ draftId: DRAFT_ID }) };
const BROWSER_VALIDATION = {
  schemaVersion: 1,
  patchDigest: "a".repeat(64),
  checkedAt: "2026-09-04T12:00:00.000Z",
  browser: { family: "chromium", major: 140, supported: true },
  viewports: {
    desktop: {
      viewport: "desktop",
      width: 1280,
      passed: true,
      issues: [],
      runtimeErrorCount: 0,
      cspViolationCount: 0,
      horizontalOverflow: false,
    },
    mobile: {
      viewport: "mobile",
      width: 390,
      passed: true,
      issues: [],
      runtimeErrorCount: 0,
      cspViolationCount: 0,
      horizontalOverflow: false,
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    draftingEnabled: true,
  });
  holder.previewPublish.mockResolvedValue({
    id: PUBLISH_APPROVAL_ID,
    draftId: DRAFT_ID,
  });
  holder.previewRollback.mockResolvedValue({
    id: PUBLISH_APPROVAL_ID,
    operation: "rollback",
  });
  holder.execute.mockResolvedValue({
    approval: {
      id: PUBLISH_APPROVAL_ID,
      operation: "apply",
      before: { page_title: "Home" },
      after: { page_status: "published" },
      resource: {
        dashboardPath: "/dashboard/builder?page=home&section=hero-code",
        publicPath: "/",
      },
    },
    auditId: "audit-1",
    repeated: false,
  });
  holder.notify.mockResolvedValue(undefined);
});

describe("Mink Phase 7D storefront publication API", () => {
  it("rejects cross-origin publication before authentication", async () => {
    const response = await POST(
      request(
        {
          action: "preview_publish",
          sourceApprovalId: SAVE_APPROVAL_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          browserValidation: BROWSER_VALIDATION,
        },
        "https://attacker.example",
      ),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("previews publication from an exact saved proposal and browser report", async () => {
    const response = await POST(
      request({
        action: "preview_publish",
        sourceApprovalId: SAVE_APPROVAL_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        browserValidation: BROWSER_VALIDATION,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.previewPublish).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      sourceApprovalId: SAVE_APPROVAL_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      browserValidation: BROWSER_VALIDATION,
    });
  });

  it("rejects browser-supplied page or code fields before authentication", async () => {
    const response = await POST(
      request({
        action: "preview_publish",
        sourceApprovalId: SAVE_APPROVAL_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        browserValidation: BROWSER_VALIDATION,
        pageId: "attacker-page",
        html: "<script>steal()</script>",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.previewPublish).not.toHaveBeenCalled();
  });

  it("previews rollback only from a completed publication id", async () => {
    const response = await POST(
      request({
        action: "preview_rollback",
        sourceApprovalId: PUBLISH_APPROVAL_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.previewRollback).toHaveBeenCalledWith({
      actor: expect.objectContaining({ adminId: "admin-1" }),
      draftId: DRAFT_ID,
      sourceApprovalId: PUBLISH_APPROVAL_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("executes by approval id, invalidates live paths and queues indexing", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: PUBLISH_APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.execute).toHaveBeenCalledWith({
      actor: expect.objectContaining({ adminId: "admin-1" }),
      draftId: DRAFT_ID,
      approvalId: PUBLISH_APPROVAL_ID,
    });
    expect(holder.revalidatePath).toHaveBeenCalledWith("/dashboard/builder");
    expect(holder.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/builder?page=home&section=hero-code",
    );
    expect(holder.revalidatePath).toHaveBeenCalledWith("/");
    expect(holder.revalidateTag).toHaveBeenCalled();
    expect(holder.notify).toHaveBeenCalledWith({
      storeId: "store-1",
      paths: ["/"],
    });
    expect(holder.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "page.published",
        storeId: "store-1",
        payload: expect.objectContaining({ source: "mink_ai" }),
      }),
    );
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/storefront-publication`,
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
