/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const auth = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUser: vi.fn(),
  deleteUser: vi.fn(),
}));
const proof = vi.hoisted(() => ({
  has: vi.fn(),
  save: vi.fn(),
  sign: vi.fn(() => "signed-proof"),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/auth/firebase-admin", () => ({
  getFirebaseAdminAuth: vi.fn(() => auth),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
// PARTIAL, deliberately: only the cookie helpers are stubbed. The order lookup
// stays REAL so these tests keep exercising the actual phone resolution against
// the seeded rows — stubbing it would leave the "which number gets texted"
// rules covered by nothing.
vi.mock("@/lib/pos/customer-verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pos/customer-verification")>()),
  hasCustomerVerification: (...args: unknown[]) => proof.has(...args),
  saveCustomerVerification: (...args: unknown[]) => proof.save(...args),
  signCustomerVerification: proof.sign,
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import {
  beginCustomerPhoneVerification,
  confirmCustomerPhoneVerification,
} from "./pos-customer-verification-actions";

const OP = {
  role: "manager" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "staff-1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";
  vi.mocked(resolvePosOperator).mockResolvedValue(OP);
  proof.has.mockResolvedValue(false);
  proof.save.mockResolvedValue(undefined);
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          shippingAddress: { phone: "+91 98765 43210" },
          customerPhone: null,
        },
      ],
    ],
  });
});

describe("beginCustomerPhoneVerification", () => {
  it("returns the server-owned order phone and never accepts one from the client", async () => {
    const result = await beginCustomerPhoneVerification("order-1", "pickup");
    expect(result).toEqual({
      phone: "+919876543210",
      maskedPhone: "••••••3210",
    });
    expect(dbHolder.current.calls.leftJoin).toHaveLength(1);
  });

  // ★★ THE REGISTER RECORDS A COUNTRY CODE NOW (lib/phone PHONE_COUNTRIES), and
  // the number is texted EXACTLY as stored. This used to resolve through
  // `normalizeIndianMobile`, which reads a stored "+6591234567" as the ten
  // digits "6591234567" — so the caller's "+91" prefix sent the code to
  // "+916591234567", a real but unrelated Indian subscriber, while the non-null
  // phone also suppressed the manager override and stranded the handover.
  describe("★★ a customer whose number is not Indian", () => {
    const foreign = (customerPhone: string) =>
      makeDbMock({
        selectQueue: [[{ shippingAddress: {}, customerPhone }]],
      });

    it.each([
      ["+6591234567", "Singapore"],
      ["+6421234567", "New Zealand"],
      ["+9607712345", "Maldives"],
    ])("texts %s (%s) as stored, never as an Indian number", async (stored) => {
      dbHolder.current = foreign(stored);
      const result = await beginCustomerPhoneVerification("order-1", "pickup");
      expect(result.phone).toBe(stored);
      expect(result.phone).not.toMatch(/^\+91/);
      expect(result.maskedPhone).toBe(`••••••${stored.slice(-4)}`);
    });
  });

  // ★ A number the till may deliberately record but nothing can text. The
  // counter must fall to the manager override rather than to an OTP that can
  // never arrive — `parseStoredPhone` recognises these on purpose, so the
  // rejection has to live at this boundary.
  it("★ treats a placeholder number as unverifiable, not as a target", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ shippingAddress: {}, customerPhone: "+918888888888" }]],
    });
    const result = await beginCustomerPhoneVerification("order-1", "pickup");
    expect(result.phone).toBeUndefined();
    expect(result).toMatchObject({ unverifiable: true, canOverride: true });
  });

  it("reuses a matching proof without another order read or SMS", async () => {
    proof.has.mockResolvedValue(true);
    const result = await beginCustomerPhoneVerification("order-1", "return");
    expect(result).toEqual({ alreadyVerified: true });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  // ★★ A legacy order with no textable mobile used to be a DEAD END: the OTP
  // could not run, markCollected refused without it, and there was no way to
  // release goods the customer had already paid for. It is now a distinct
  // state the counter can act on, not a bare error string.
  describe("★ an order the OTP cannot reach", () => {
    const noMobile = () =>
      makeDbMock({
        selectQueue: [[{ shippingAddress: {}, customerPhone: "123" }]],
      });

    it("reports it as unverifiable rather than as a failure", async () => {
      dbHolder.current = noMobile();
      const result = await beginCustomerPhoneVerification("order-1", "return");
      expect(result).toMatchObject({ unverifiable: true, canOverride: true });
      expect(result.error).toMatch(/no mobile number that can be texted/i);
    });

    it("★ offers no override to a cashier", async () => {
      dbHolder.current = noMobile();
      vi.mocked(resolvePosOperator).mockResolvedValue({
        ...OP,
        role: "cashier",
      });
      const result = await beginCustomerPhoneVerification("order-1", "pickup");
      expect(result).toMatchObject({ unverifiable: true, canOverride: false });
    });

    it("★ an order that isn't here is NOT unverifiable — it's the wrong order", async () => {
      // Conflating the two would offer an override for anything a mis-scan
      // turned up, which is the opposite of a narrow escape hatch.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const result = await beginCustomerPhoneVerification("order-1", "pickup");
      expect(result.unverifiable).toBeUndefined();
      expect(result.error).toMatch(/isn't waiting at this counter/i);
    });

    it("★ a read failure is not unverifiable either — it fails closed", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [new Error("connection reset")],
      });
      const result = await beginCustomerPhoneVerification("order-1", "pickup");
      expect(result.unverifiable).toBeUndefined();
      expect(result.error).toMatch(/couldn't read the order/i);
    });

    it("★ and no proof can be MINTED for one", async () => {
      dbHolder.current = noMobile();
      const result = await confirmCustomerPhoneVerification({
        orderId: "order-1",
        purpose: "return",
        idToken: "tok",
      });
      expect(result.error).toMatch(/no valid customer mobile/i);
      expect(proof.save).not.toHaveBeenCalled();
    });
  });
});

describe("confirmCustomerPhoneVerification", () => {
  it("verifies a recent phone-auth token against the exact order number", async () => {
    auth.verifyIdToken.mockResolvedValue({
      phone_number: "+91 98765 43210",
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "return",
      idToken: "firebase-token",
    });
    expect(result).toEqual({ verified: true });
    expect(auth.verifyIdToken).toHaveBeenCalledWith("firebase-token", true);
    expect(proof.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        purpose: "return",
        phone: "+919876543210",
        op: OP,
      }),
    );
    expect(proof.save).toHaveBeenCalledWith("signed-proof");
  });

  it("rejects a valid OTP token for a different mobile", async () => {
    auth.verifyIdToken.mockResolvedValue({
      phone_number: "+919999999999",
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-token",
    });
    expect(result.error).toMatch(/didn't verify this order/i);
    expect(proof.save).not.toHaveBeenCalled();
  });

  it("removes a new phone-only Firebase identity after saving the counter proof", async () => {
    const now = Date.now();
    auth.verifyIdToken.mockResolvedValue({
      uid: "temporary-phone-user",
      phone_number: "+919876543210",
      auth_time: Math.floor(now / 1000),
      firebase: { sign_in_provider: "phone" },
    });
    auth.getUser.mockResolvedValue({
      email: undefined,
      phoneNumber: "+919876543210",
      metadata: { creationTime: new Date(now).toISOString() },
      providerData: [{ providerId: "phone" }],
    });
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            shippingAddress: { phone: "+91 98765 43210" },
            customerPhone: null,
          },
        ],
        [],
      ],
    });

    const result = await confirmCustomerPhoneVerification({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-token",
      cleanupCreatedAuthUser: true,
    });

    expect(result).toEqual({ verified: true });
    expect(proof.save).toHaveBeenCalledBefore(auth.deleteUser);
    expect(auth.deleteUser).toHaveBeenCalledWith("temporary-phone-user");
  });
});
