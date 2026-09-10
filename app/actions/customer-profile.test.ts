/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  updateAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/pos/claim-customer", () => ({ claimPosCustomer: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { updateCustomerProfile } from "./customer-profile";
import { updateAuthUser } from "@/lib/auth/firebase-users";
import { getServerUser } from "@/lib/auth/server-user";
import { claimPosCustomer } from "@/lib/pos/claim-customer";
import { emitEvent } from "@/lib/notifications/record";

function makeFormData(fields: Record<string, string | null | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) fd.set(k, v);
  }
  return fd;
}

const serverUser = (overrides: Record<string, any> = {}) => ({
  id: "user-1",
  email: "old@example.com",
  phone: "+11234567890",
  phoneConfirmed: true,
  metadata: {},
  ...overrides,
});

// customer-profile.ts — the /profile page action that lets a signed-in
// shopper update their name and email. Identity comes from getServerUser; the
// email change goes through Identity Platform (updateAuthUser). Phone is NOT
// NULL UNIQUE in the DB so this action only ever writes it from a verified value.
describe("updateCustomerProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(updateAuthUser).mockResolvedValue();
    vi.mocked(getServerUser).mockResolvedValue(serverUser() as any);
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — restore explicitly.
    vi.mocked(claimPosCustomer).mockResolvedValue({ claimed: false });
  });

  // First name is the only required field.
  it("rejects when first name is missing", async () => {
    const result = await updateCustomerProfile(
      makeFormData({ firstName: "  " }),
    );
    expect(result.error).toMatch(/first name/i);
  });

  // Email shape sanity check — minimal "must contain @".
  it("rejects a malformed email", async () => {
    const result = await updateCustomerProfile(
      makeFormData({ firstName: "Ada", email: "no-at-sign" }),
    );
    expect(result.error).toMatch(/valid email/i);
  });

  // Anonymous visitors cannot update a profile.
  it("rejects unauthenticated callers", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const result = await updateCustomerProfile(
      makeFormData({ firstName: "Ada" }),
    );
    expect(result.error).toMatch(/not authenticated/i);
  });

  // Changing the email updates the Identity Platform account.
  it("calls updateAuthUser when email changes", async () => {
    await updateCustomerProfile(
      makeFormData({ firstName: "Ada", email: "new@example.com" }),
    );
    expect(updateAuthUser).toHaveBeenCalledWith("user-1", {
      email: "new@example.com",
    });
  });

  // Same email → no auth update, just the profile upsert.
  it("does not call updateAuthUser when email is unchanged", async () => {
    await updateCustomerProfile(
      makeFormData({ firstName: "Ada", email: "old@example.com" }),
    );
    expect(updateAuthUser).not.toHaveBeenCalled();
  });

  // Phone is written from the verified auth identity only — never from the
  // form, never empty. Critical because users.phone is NOT NULL UNIQUE and an
  // empty string would collide across every phone-less customer.
  it("only writes phone when auth has a verified value", async () => {
    await updateCustomerProfile(makeFormData({ firstName: "Ada" }));
    expect(dbHolder.current.calls.values[0].phone).toBe("+11234567890");
  });

  it("stores the number in the canonical E.164 shape", async () => {
    // ★★ THE REPORTED DEFECT. Identity Platform returns E.164 and this wrote
    // it through untouched, while the register writes and searches for the
    // national form. `(store_id, phone)` is UNIQUE on the STRING, so the same
    // person held two rows: the till could not find a shopper who had an
    // account, and the claim above adopted a till row only for this upsert to
    // rewrite its phone back to E.164 — so the next in-store visit missed
    // again and minted another duplicate.
    vi.mocked(getServerUser).mockResolvedValue(
      serverUser({ phone: "+919877542162" }) as any,
    );
    await updateCustomerProfile(makeFormData({ firstName: "Rohan" }));
    expect(dbHolder.current.calls.values[0].phone).toBe("+919877542162");
  });

  it("leaves a number it does not recognise exactly as it came", async () => {
    // ⚠ `normalizeIndianMobile` recognises Indian mobiles only, so
    // canonicalising unconditionally would DROP the phone of a shopper who
    // verified a foreign number. Theirs cannot be typed at an Indian till
    // anyway — the field caps at ten digits — so there is nothing to match
    // and nothing lost by leaving it.
    // A dial code the register does not offer, so it cannot be parsed — and
    // dropping the phone would be worse than storing what was verified.
    vi.mocked(getServerUser).mockResolvedValue(
      serverUser({ phone: "+3581234567" }) as any,
    );
    await updateCustomerProfile(makeFormData({ firstName: "Ada" }));
    expect(dbHolder.current.calls.values[0].phone).toBe("+3581234567");
  });

  it("omits phone entirely when auth has no phone", async () => {
    vi.mocked(getServerUser).mockResolvedValue(
      serverUser({ phone: null }) as any,
    );
    await updateCustomerProfile(makeFormData({ firstName: "Ada" }));
    expect(dbHolder.current.calls.values[0].phone).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adopting a till-created customer (roadmap Step 4 / pos_13).
// ---------------------------------------------------------------------------
describe("updateCustomerProfile — claiming a till-created customer", () => {
  beforeEach(() => {
    vi.mocked(claimPosCustomer).mockResolvedValue({ claimed: false });
  });

  // ★★ ORDER IS THE WHOLE THING. (store_id, phone) is UNIQUE, so if the till
  // already recorded this person the insert is a duplicate-key error — signup
  // would fail for exactly the customers who have shopped here before.
  it("claims BEFORE it upserts", async () => {
    const order: string[] = [];
    vi.mocked(claimPosCustomer).mockImplementation(async () => {
      order.push("claim");
      return { claimed: false };
    });
    dbHolder.current = makeDbMock({ returning: [{ inserted: true }] });
    const insert = dbHolder.current.db.insert;
    dbHolder.current.db.insert = (...args: any[]) => {
      order.push("upsert");
      return insert(...args);
    };

    await updateCustomerProfile(makeFormData({ firstName: "Asha" }));
    expect(order).toEqual(["claim", "upsert"]);
  });

  // ★ THE PHONE IS THE SECURITY BOUNDARY. A phone from the form would let
  // anyone type a stranger's number and inherit their in-store order history.
  it("passes the VERIFIED auth phone, never anything from the form", async () => {
    vi.mocked(getServerUser).mockResolvedValue(
      serverUser({ phone: "+919876543210" }) as any,
    );
    dbHolder.current = makeDbMock({ returning: [{ inserted: true }] });
    const fd = makeFormData({ firstName: "Asha" });
    fd.set("phone", "+919999999999"); // ignored by construction

    await updateCustomerProfile(fd);
    expect(claimPosCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "user-1",
        verifiedPhone: "+919876543210",
      }),
    );
  });

  it("scopes the claim to the host store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ inserted: true }] });
    await updateCustomerProfile(makeFormData({ firstName: "Asha" }));
    expect(claimPosCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: expect.any(String) }),
    );
  });

  // ★ BEST-EFFORT, AND THE CALLER PROVES IT. A lost link to in-store history
  // is a disappointment; a shopper who cannot create an account at all is not.
  // claimPosCustomer catches its own errors by contract — this asserts that
  // signup survives even if that contract is ever broken.
  it("still saves the profile when the claim throws", async () => {
    vi.mocked(claimPosCustomer).mockRejectedValue(new Error("boom"));
    dbHolder.current = makeDbMock({ returning: [{ inserted: true }] });
    const r = await updateCustomerProfile(makeFormData({ firstName: "Asha" }));
    expect(r).toEqual({ success: true });
    expect(dbHolder.current.calls.values[0].firstName).toBe("Asha");
  });

  // ★ A claimed row is an UPDATE, so the signup event does not fire — correct:
  // the store already knows this person. What is new is the ACCOUNT.
  it("does not announce a signup for a row that was adopted", async () => {
    vi.mocked(claimPosCustomer).mockResolvedValue({ claimed: true });
    dbHolder.current = makeDbMock({ returning: [{ inserted: false }] });
    vi.mocked(emitEvent).mockClear(); // this file's beforeEach does not
    await updateCustomerProfile(makeFormData({ firstName: "Asha" }));
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
