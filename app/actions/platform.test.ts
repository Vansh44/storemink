/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  // platform.ts now imports lib/plans/pricing, whose module scope wraps the
  // price read in unstable_cache. Pass the function straight through so the
  // resolver under test runs uncached.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
// platform.ts pulls STORE_TAG/FALLBACK_STORE_ID from resolve.ts, whose module
// scope calls unstable_cache — stub the constants instead of loading it.
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
// Unrelated heavyweight imports of platform.ts — stub so the module loads lean.
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveThemeDefinition: vi.fn(),
}));
vi.mock("@/lib/themes/apply", () => ({ applyTheme: vi.fn() }));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn(async () => ({
    attempted: 0,
    failed: 0,
    unmanaged: 0,
  })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsDeletePrefix: vi.fn(async () => ({ deleted: 0, failed: 0 })),
}));
vi.mock("@/lib/domains/cleanup", () => ({
  cleanupDetachedDomain: vi.fn(async () => ({ failures: [] })),
}));
vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/firebase-admin", () => ({
  isFirebaseAdminConfigured: vi.fn(() => true),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// getPlatformViewer reads platform_admins (select #1), then the action's own
// reads follow — all share this one mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  deleteStore,
  setStorePlan,
  grantAiCredits,
  savePlanCreditAllowances,
  saveMinkCreditPacks,
} from "./platform";
import { getServerUser } from "@/lib/auth/server-user";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { isFirebaseAdminConfigured } from "@/lib/auth/firebase-admin";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { gcsDeletePrefix } from "@/lib/storage/gcs";
import { cleanupDetachedDomain } from "@/lib/domains/cleanup";
import { revalidateTag } from "next/cache";

const OPERATOR_EMAIL = "op@storemink.com";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

// The platform-viewer gate row (superadmin unless overridden).
function viewer(role: string | null = "superadmin") {
  return role ? [{ email: OPERATOR_EMAIL, role }] : [];
}

// setStorePlan: select #1 = the viewer gate, select #2 = the target store.
function setup(selectQueue: any[][], returning: any[] = [{ id: "s1" }]) {
  dbHolder.current = makeDbMock({ selectQueue, returning });
}

describe("setStorePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, target store on free.
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects a caller who is not a platform admin at all", async () => {
    setup([viewer(null)]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
  });

  it("rejects unknown plan ids (incl. the retired 'growth' and 'starter')", async () => {
    setup([viewer()]);
    expect((await setStorePlan("s1", "growth")).error).toMatch(/invalid plan/i);
    setup([viewer()]);
    expect((await setStorePlan("s1", "starter")).error).toMatch(
      /invalid plan/i,
    );
    setup([viewer()]);
    expect((await setStorePlan("s1", "PRO")).error).toMatch(/invalid plan/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects when the store is already on the target plan with the same expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/already on pro/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("allows re-granting the same plan with a different expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
  });

  it("allows downgrades (operator may set any plan)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "basic",
      planSource: "comp",
      planExpiresAt: null,
    });

    setup([viewer(), [{ plan: "basic", plan_expires_at: null }]]);
    const res2 = await setStorePlan("s1", "free");
    expect(res2.success).toBe(true);
  });

  it("rejects an unparseable or past expiry", async () => {
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: "not-a-date" })).error,
    ).toMatch(/invalid expiry/i);
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: PAST })).error,
    ).toMatch(/future/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("sets a timed plan, marks it comp, audits with the expiry, and busts the cache", async () => {
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);

    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
    // Audit row records who did what and until when.
    expect(dbHolder.current.calls.values[0]).toEqual({
      storeId: "s1",
      fromPlan: "free",
      toPlan: "pro",
      source: "operator",
      actor: OPERATOR_EMAIL,
      note: "expires 2030-01-01",
    });
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("an indefinite paid grant audits as such", async () => {
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      toPlan: "basic",
      note: "indefinite",
    });
  });

  it("the free plan never carries an expiry (ignored if sent)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "free", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "free",
      planSource: "comp",
      planExpiresAt: null,
    });
  });

  it("still succeeds when the audit insert fails (best-effort trail)", async () => {
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
  });
});

describe("grantAiCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, store exists.
    setup([viewer(), [{ id: "s1" }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects non-integer, zero and oversized amounts", async () => {
    setup([viewer()]);
    expect((await grantAiCredits("s1", 0)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 2.5)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 10001)).error).toMatch(/whole number/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects an unknown store", async () => {
    setup([viewer(), []]); // store lookup empty
    const res = await grantAiCredits("nope", 50);
    expect(res.error).toMatch(/not found/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("grants through the atomic RPC with the operator email as the audited ref", async () => {
    const res = await grantAiCredits("s1", 50, "onboarding goodwill");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    const params = sqlParamValues(dbHolder.current.calls.execute[0]);
    expect(params).toEqual([
      "s1",
      50,
      "grant",
      OPERATOR_EMAIL,
      "onboarding goodwill",
    ]);
  });

  it("surfaces an RPC failure as a friendly error", async () => {
    dbHolder.current.db.execute = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/could not grant/i);
  });
});

describe("deleteStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
  });

  it("deletes every attached owner, customer and POS staff login", async () => {
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "owner-uid", email: "owner@example.com" }],
      [{ id: "customer-uid", email: "customer@example.com" }],
      [
        { user_id: "pos-staff-uid", email: "staff@example.com" },
        { user_id: "pos-staff-uid", email: "staff@example.com" },
        { user_id: null, email: "pending@example.com" },
      ],
      // One empty result for each store-scoped media table scanned before the
      // database cascade. Their contents are irrelevant to this regression.
      ...Array.from({ length: 15 }, () => []),
      // No remaining admin/customer/POS relationships or platform operator.
      [],
      [],
      [],
      [],
    ]);

    const res = await deleteStore("s1");

    expect(res).toEqual({ success: true });
    expect(deleteStorageUrls).toHaveBeenCalledWith([]);
    expect(gcsDeletePrefix).toHaveBeenCalledWith("stores/s1/");
    expect(deleteAuthUser).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deleteAuthUser).mock.calls.map(([uid]) => uid)).toEqual([
      "owner-uid",
      "customer-uid",
      "pos-staff-uid",
    ]);
  });

  it("keeps a login that still belongs to another store or the operator console", async () => {
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "shared-admin", email: "owner@example.com" }],
      [{ id: "platform-op", email: OPERATOR_EMAIL }],
      [{ user_id: "orphan-pos", email: "staff@example.com" }],
      ...Array.from({ length: 15 }, () => []),
      [{ id: "shared-admin" }],
      [],
      [],
      [{ email: OPERATOR_EMAIL }],
    ]);

    const res = await deleteStore("s1");

    expect(res).toEqual({ success: true });
    expect(vi.mocked(deleteAuthUser).mock.calls.map(([uid]) => uid)).toEqual([
      "orphan-pos",
    ]);
  });

  it("purges custom-domain and storage resources and surfaces partial failures", async () => {
    vi.mocked(deleteStorageUrls).mockResolvedValueOnce({
      attempted: 1,
      failed: 1,
      unmanaged: 0,
      foreign: 0,
    });
    vi.mocked(gcsDeletePrefix).mockResolvedValueOnce({
      deleted: 0,
      failed: 0,
      error: "bucket unavailable",
    });
    vi.mocked(cleanupDetachedDomain).mockResolvedValueOnce({
      failures: ["TLS certificate resources"],
    });
    setup([
      viewer(),
      [
        {
          id: "s1",
          settings: {
            logo: "https://storage.googleapis.com/media/legacy/logo.webp",
            resend_domain_id: "legacy-resend-1",
          },
          custom_domain: "shop.example.com",
        },
      ],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    const res = await deleteStore("s1");

    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/cleanup still needs attention/i);
    expect(res.warning).toMatch(/referenced media/i);
    expect(res.warning).toMatch(/store media prefix/i);
    expect(res.warning).toMatch(/TLS certificate resources/i);
    expect(cleanupDetachedDomain).toHaveBeenCalledWith(
      "shop.example.com",
      "deleteStore",
      "legacy-resend-1",
    );
  });

  it("removes an orphaned legacy Resend domain even when no custom domain remains", async () => {
    setup([
      viewer(),
      [
        {
          id: "s1",
          settings: { resend_domain_id: "legacy-resend-1" },
          custom_domain: null,
        },
      ],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(cleanupDetachedDomain).toHaveBeenCalledWith(
      null,
      "deleteStore",
      "legacy-resend-1",
    );
  });

  it("warns instead of claiming auth cleanup succeeded when Identity Platform is unavailable", async () => {
    vi.mocked(isFirebaseAdminConfigured).mockReturnValueOnce(false);
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "owner-uid", email: "owner@example.com" }],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    const res = await deleteStore("s1");
    expect(res.warning).toMatch(/Identity Platform is not configured/i);
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});

describe("savePlanCreditAllowances", () => {
  const ok = [
    { plan: "free", includedCredits: 5 },
    { plan: "basic", includedCredits: 15 },
    { plan: "pro", includedCredits: 60 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    setup([viewer()]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await savePlanCreditAllowances(ok);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("requires exactly one row per plan", async () => {
    setup([viewer()]);
    expect((await savePlanCreditAllowances(ok.slice(0, 2))).error).toMatch(
      /one allowance for each plan/i,
    );
    setup([viewer()]);
    // Three rows, but one plan twice — a shape that would leave a tier on its
    // old allowance while looking like a complete save.
    expect(
      (await savePlanCreditAllowances([ok[0], ok[1], { ...ok[1] }])).error,
    ).toMatch(/one allowance for each plan/i);
    setup([viewer()]);
    expect(
      (
        await savePlanCreditAllowances([
          ok[0],
          ok[1],
          { ...ok[2], plan: "growth" },
        ])
      ).error,
    ).toMatch(/one allowance for each plan/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects zero, fractional, negative and oversized allowances", async () => {
    for (const bad of [0, -1, 2.5, 100_001]) {
      setup([viewer()]);
      const res = await savePlanCreditAllowances([
        { ...ok[0], includedCredits: bad },
        ok[1],
        ok[2],
      ]);
      expect(res.error).toMatch(/whole number between 1 and 100000/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    }
  });

  // ⚠ The legacy pair is still NOT NULL and the revision this rolls out over
  // still reads it, so all three columns carry the same number until the
  // contract migration drops them. Writing only the new one fails the insert.
  it("writes the new column and both legacy columns to the same number", async () => {
    setup([viewer()]);
    const res = await savePlanCreditAllowances(ok);
    expect(res).toEqual({ success: true });
    expect(dbHolder.current.calls.values).toEqual([
      expect.objectContaining({
        plan: "free",
        includedCredits: 5,
        generationsPerMonth: 5,
        creditsPerMonth: 5,
        updatedBy: OPERATOR_EMAIL,
      }),
      expect.objectContaining({ plan: "basic", includedCredits: 15 }),
      expect.objectContaining({ plan: "pro", includedCredits: 60 }),
    ]);
  });
});

describe("saveMinkCreditPacks", () => {
  const packs = [
    { id: "small", name: "Small", credits: 25, priceInr: 59, popular: false },
    { id: "big", name: "Big", credits: 300, priceInr: 499, popular: true },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    setup([viewer()]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await saveMinkCreditPacks(packs);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses an empty catalogue", async () => {
    setup([viewer()]);
    const res = await saveMinkCreditPacks([]);
    expect(res.error).toMatch(/at least one credit pack/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses two highlighted packs and a duplicate id", async () => {
    setup([viewer()]);
    expect(
      (
        await saveMinkCreditPacks([
          { ...packs[0], popular: true },
          { ...packs[1], popular: true },
        ])
      ).error,
    ).toMatch(/only one pack can be highlighted/i);
    setup([viewer()]);
    expect(
      (await saveMinkCreditPacks([packs[0], { ...packs[0] }])).error,
    ).toMatch(/duplicate pack id/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a blank name or a non-positive size or price", async () => {
    for (const bad of [
      { ...packs[0], name: "  " },
      { ...packs[0], credits: 0 },
      { ...packs[0], priceInr: 0 },
    ]) {
      setup([viewer()]);
      expect((await saveMinkCreditPacks([bad])).error).toMatch(/^Pack 1: /);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    }
  });

  // ★★ The highlight is cleared before anything is written. The partial unique
  // index allows one `popular` row, so moving the badge from A to B in a single
  // pass collides the moment B is written while A still holds it.
  it("clears the highlight before writing, and stores the row order", async () => {
    setup([viewer()]);
    const res = await saveMinkCreditPacks(packs);
    expect(res).toEqual({ success: true });
    expect(dbHolder.current.calls.set[0]).toEqual({ popular: false });
    expect(dbHolder.current.calls.values).toEqual([
      expect.objectContaining({ id: "small", sortOrder: 0, popular: false }),
      expect.objectContaining({ id: "big", sortOrder: 1, popular: true }),
    ]);
  });

  it("deletes packs the operator removed from the list", async () => {
    setup([viewer()]);
    await saveMinkCreditPacks([packs[0]]);
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});
