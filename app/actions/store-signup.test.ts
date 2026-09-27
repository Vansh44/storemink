/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/db/errors", () => ({ isUniqueViolation: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/lib/store/host", () => ({ ROOT_DOMAIN: "storemink.com" }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/legal/store", () => ({
  recordSignupConsent: vi.fn(async () => {}),
}));
vi.mock("@/lib/themes/apply", () => ({
  applyTheme: vi.fn(async () => ({ success: true, errors: [] })),
}));
vi.mock("@/lib/themes/runtime-registry", async () => {
  const { THEME_META } = await import("@/lib/themes/meta");
  return { getThemeCatalog: vi.fn(async () => [...THEME_META]) };
});

import { updateTag } from "next/cache";
import { isUniqueViolation } from "@/lib/db/errors";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { recordSignupConsent } from "@/lib/legal/store";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID } from "@/lib/themes/meta";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import {
  checkStoreSlugAvailability,
  createStore,
  getSignupResumeInfo,
} from "./store-signup";

const USER = {
  id: "user-1",
  email: "owner@example.com",
  emailConfirmed: true,
  phoneConfirmed: true,
  phone: "+919876543210",
  metadata: {},
} as any;

const INPUT = {
  name: "Acme Foods",
  template: DEFAULT_THEME_ID,
  firstName: " Asha ",
  lastName: " Shah ",
  country: " in ",
  addressLine1: " 12 Radial Road ",
  addressLine2: " Floor 2 ",
  city: " New Delhi ",
  state: " Delhi ",
  postalCode: " 110001 ",
  lat: 28.6139,
  lng: 77.209,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbHolder.current = makeDbMock({
    selectQueue: [[], []],
    returning: [{ id: "store-1", slug: "acme-foods" }],
  });
  vi.mocked(getServerUser).mockResolvedValue(USER);
  vi.mocked(isUniqueViolation).mockReturnValue(false);
  vi.mocked(applyTheme).mockResolvedValue({ success: true, errors: [] } as any);
  vi.mocked(recordSignupConsent).mockResolvedValue(undefined);
});

describe("checkStoreSlugAvailability", () => {
  it.each([
    ["", "", "Enter a store name."],
    ["AB", "ab", "At least 3 characters."],
    ["x".repeat(41), "x".repeat(41), "Too long (40 characters max)."],
    ["Dashboard", "dashboard", "This name is reserved."],
    ["POS", "pos", "This name is reserved."],
    ["Demo", "demo", "This name is reserved."],
    ["demo-fashion", "demo-fashion", "This name is reserved."],
  ])("rejects invalid or reserved input %s", async (raw, slug, reason) => {
    expect(await checkStoreSlugAvailability(raw)).toEqual({
      slug,
      available: false,
      reason,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("normalizes a store name and checks every existing store, including inactive ones", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await checkStoreSlugAvailability("  Asha's Fresh Foods  ")).toEqual({
      slug: "ashas-fresh-foods",
      available: true,
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "ashas-fresh-foods",
    );
  });

  it("does not reveal whether an existing store is pending or suspended", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "store-existing" }]],
    });
    expect(await checkStoreSlugAvailability("Acme")).toEqual({
      slug: "acme",
      available: false,
      reason: "This name is not available.",
    });
  });

  it("fails closed when availability cannot be established", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("database offline");
    });
    expect(await checkStoreSlugAvailability("Acme")).toEqual({
      slug: "acme",
      available: false,
      reason: "Couldn't check right now.",
    });
  });
});

describe("getSignupResumeInfo", () => {
  it("returns a minimal anonymous state", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect(await getSignupResumeInfo()).toEqual({
      authenticated: false,
      hasStore: false,
      phoneConfirmed: false,
      emailConfirmed: false,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("resumes a verified account without a store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).toMatchObject({
      authenticated: true,
      hasStore: false,
      phoneConfirmed: true,
      emailConfirmed: true,
      email: "owner@example.com",
    });
  });

  it("returns the owned slug and splits an OAuth full name", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      metadata: { full_name: "Asha Devi Shah" },
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[{ store_id: "store-1" }], [{ slug: "acme" }]],
    });
    expect(await getSignupResumeInfo()).toMatchObject({
      hasStore: true,
      slug: "acme",
      firstName: "Asha",
      lastName: "Devi Shah",
    });
  });

  it("prefers provider given and family names", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      metadata: {
        full_name: "Ignored Name",
        given_name: "Priya",
        family_name: "Singh",
      },
    });
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).toMatchObject({
      firstName: "Priya",
      lastName: "Singh",
    });
  });

  it("keeps the authenticated resume usable during a database outage", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("offline");
    });
    expect(await getSignupResumeInfo()).toMatchObject({
      authenticated: true,
      hasStore: false,
      phoneConfirmed: true,
      emailConfirmed: true,
    });
  });
});

describe("createStore gates", () => {
  it("rejects an unavailable theme before creating a user-bound resource", async () => {
    expect(await createStore({ ...INPUT, template: "not-a-theme" })).toEqual({
      error: "That store theme is not available.",
    });
    expect(getServerUser).not.toHaveBeenCalled();
  });

  it("requires an authenticated, email-confirmed and phone-confirmed owner", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await createStore(INPUT)).error).toMatch(/sign in/i);

    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      emailConfirmed: false,
    });
    expect((await createStore(INPUT)).error).toMatch(/verify your email/i);

    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      phoneConfirmed: false,
    });
    expect((await createStore(INPUT)).error).toMatch(/verify your phone/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("re-checks slug ownership and one-store-per-owner on the server", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "taken" }]],
    });
    expect((await createStore(INPUT)).error).toMatch(/not available/i);

    dbHolder.current = makeDbMock({
      selectQueue: [[], [{ store_id: "existing-store" }]],
    });
    expect((await createStore(INPUT)).error).toMatch(/already has a store/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("requires every core invoice-address field server-side", async () => {
    expect((await createStore({ ...INPUT, country: "" })).error).toMatch(
      /choose the country/i,
    );

    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    expect((await createStore({ ...INPUT, addressLine1: "" })).error).toMatch(
      /street and building/i,
    );

    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    expect((await createStore({ ...INPUT, city: "" })).error).toMatch(
      /enter the city/i,
    );

    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    expect((await createStore({ ...INPUT, state: "" })).error).toMatch(
      /state or province/i,
    );

    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    expect((await createStore({ ...INPUT, postalCode: "" })).error).toMatch(
      /postal or PIN/i,
    );
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

describe("createStore provisioning", () => {
  it("writes a non-indexable free store with normalized business location", async () => {
    const result = await createStore(INPUT);

    expect(result).toEqual({ slug: "acme-foods", storeId: "store-1" });
    expect(dbHolder.current.calls.insert[0]).toBe(stores);
    expect(dbHolder.current.calls.values[0]).toEqual({
      slug: "acme-foods",
      name: "Acme Foods",
      status: "active",
      plan: "free",
      settings: {
        template: DEFAULT_THEME_ID,
        brand: { name: "Acme Foods" },
        launched: false,
        business: {
          country: "IN",
          addressLine1: "12 Radial Road",
          addressLine2: "Floor 2",
          city: "New Delhi",
          state: "Delhi",
          postalCode: "110001",
          address: "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
          lat: 28.6139,
          lng: 77.209,
        },
      },
    });
  });

  it("drops invalid coordinates without blocking signup", async () => {
    await createStore({ ...INPUT, lat: 91, lng: 181 });
    expect(dbHolder.current.calls.values[0].settings.business).toEqual({
      country: "IN",
      addressLine1: "12 Radial Road",
      addressLine2: "Floor 2",
      city: "New Delhi",
      state: "Delhi",
      postalCode: "110001",
      address: "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
    });
  });

  it("seeds the invoice profile from the same validated business address", async () => {
    await createStore(INPUT);
    expect(dbHolder.current.calls.insert[2]).toBe(storeBillingSettings);
    expect(dbHolder.current.calls.values[2]).toEqual({
      storeId: "store-1",
      businessName: "Acme Foods",
      businessAddress:
        "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
      contactEmail: "owner@example.com",
      contactPhone: "+919876543210",
      updatedBy: "user-1",
    });
  });

  it("creates the owner with no forced password reset and bounded names", async () => {
    await createStore({
      ...INPUT,
      firstName: "A".repeat(100),
      lastName: "B".repeat(100),
    });
    expect(dbHolder.current.calls.insert[1]).toBe(admins);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      id: "user-1",
      email: "owner@example.com",
      role: "superadmin",
      storeId: "store-1",
      firstName: "A".repeat(80),
      lastName: "B".repeat(80),
      forcePasswordReset: false,
    });
  });

  it("★★ records the OTP-verified phone on the owner row, not only the invoice profile", async () => {
    // `admins.phone` is where `resolveBillingEmail` — and therefore
    // `startEnrolment` — looks for a billing contact. Writing it to
    // store_billing_settings alone left every wizard-created store unable to
    // subscribe: "We couldn't prepare autopay", before any Razorpay call.
    await createStore(INPUT);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      phone: "+919876543210",
    });
  });

  it("falls back to the email local-part when the owner name is blank", async () => {
    await createStore({ ...INPUT, firstName: "", lastName: "" });
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      firstName: "owner",
      lastName: null,
    });
  });

  it("maps a concurrent slug race to a useful retry message", async () => {
    vi.mocked(isUniqueViolation).mockReturnValue(true);
    const originalInsert = dbHolder.current.db.insert;
    dbHolder.current.db.insert = vi.fn((table: any) => {
      if (table === stores) throw new Error("duplicate");
      return originalInsert(table);
    });
    expect(await createStore(INPUT)).toEqual({
      error: "That name was just taken — try another.",
    });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it("rolls back the store if owner creation fails", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [admins],
    });

    expect(await createStore(INPUT)).toEqual({
      error: "Could not set up your store account. Please try again.",
    });
    expect(dbHolder.current.calls.delete[0]).toBe(stores);
    expect(sqlParamValues(dbHolder.current.calls.where.at(-1))).toContain(
      "store-1",
    );
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it("rolls back the store if its required invoice profile cannot be saved", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [storeBillingSettings],
    });

    expect(await createStore(INPUT)).toEqual({
      error: "Could not save your business address. Please try again.",
    });
    expect(dbHolder.current.calls.delete[0]).toBe(stores);
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it("keeps a working store when best-effort theme seeding is partial", async () => {
    vi.mocked(applyTheme).mockResolvedValue({
      success: false,
      errors: ["one sample product failed"],
    } as any);
    expect(await createStore(INPUT)).toEqual({
      slug: "acme-foods",
      storeId: "store-1",
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("records consent and emits separate merchant and operator events", async () => {
    await createStore(INPUT);

    expect(applyTheme).toHaveBeenCalledWith("store-1", DEFAULT_THEME_ID, {
      publish: true,
      actorUserId: "user-1",
    });
    expect(recordSignupConsent).toHaveBeenCalledWith({
      userId: "user-1",
      email: "owner@example.com",
      actorType: "merchant",
      storeId: "store-1",
      context: "signup",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "store.created",
        storeId: "store-1",
        payload: {
          storeUrl: "https://acme-foods.storemink.com",
          plan: "free",
        },
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "platform.store_created",
        storeId: null,
        payload: { slug: "acme-foods", template: DEFAULT_THEME_ID },
      }),
    );
  });
});
