import { describe, it, expect } from "vitest";
import {
  POS_CUSTOMER_PREFIX,
  decideClaim,
  isPosCustomerId,
  newPosCustomerId,
  normalizePhone,
  splitName,
  validatePosCustomer,
  validatePosCheckoutDetails,
} from "./customer-claim";

describe("isPosCustomerId", () => {
  it("recognises a till-created id", () => {
    expect(isPosCustomerId("pos_abc")).toBe(true);
  });

  it("does not treat a Firebase uid as one", () => {
    expect(isPosCustomerId("k3Jd82HdkeUxYq")).toBe(false);
  });

  it("survives null and undefined", () => {
    expect(isPosCustomerId(null)).toBe(false);
    expect(isPosCustomerId(undefined)).toBe(false);
  });

  it("is not fooled by the prefix appearing later", () => {
    expect(isPosCustomerId("xpos_abc")).toBe(false);
  });
});

describe("newPosCustomerId", () => {
  it("prefixes the generated uuid", () => {
    const id = newPosCustomerId(() => "11111111-2222-3333-4444-555555555555");
    expect(id).toBe(
      `${POS_CUSTOMER_PREFIX}11111111-2222-3333-4444-555555555555`,
    );
    expect(isPosCustomerId(id)).toBe(true);
  });
});

describe("decideClaim", () => {
  it("creates when nothing matches the phone", () => {
    expect(decideClaim(null)).toEqual({ action: "create" });
  });

  it("adopts an unclaimed till-created row", () => {
    expect(decideClaim({ id: "pos_x", claimedAt: null })).toEqual({
      action: "adopt",
      posId: "pos_x",
    });
  });

  // ★ The reason claimed_at exists at all.
  it("NEVER adopts a row that has already been claimed", () => {
    expect(
      decideClaim({ id: "pos_x", claimedAt: "2026-08-01T00:00:00Z" }),
    ).toEqual({ action: "attach", existingId: "pos_x" });
  });

  // ★ A real signup row also has claimed_at NULL — nothing backfills it — so
  // NULL alone must never mean "adoptable", or one account takes over another.
  it("NEVER adopts a real signup row just because claimed_at is NULL", () => {
    expect(decideClaim({ id: "realFirebaseUid", claimedAt: null })).toEqual({
      action: "attach",
      existingId: "realFirebaseUid",
    });
  });
});

describe("normalizePhone", () => {
  it("returns the canonical E.164 shape the column stores", () => {
    expect(normalizePhone("9876543210")).toBe("+919876543210");
  });

  // ★ The till and the signup must land on the same string, or the claim never
  // fires and the customer silently gets two rows. That is exactly what broke:
  // signup wrote E.164 and this returned the bare ten digits.
  it.each([
    ["+91 98765 43210"],
    ["+919876543210"],
    ["919876543210"],
    ["09876543210"],
    ["98765-43210"],
    ["  9876543210  "],
  ])("normalises %s to the same canonical string", (input) => {
    expect(normalizePhone(input)).toBe("+919876543210");
  });

  it.each([
    ["", "empty"],
    ["12345", "too short"],
    ["5876543210", "does not start 6-9"],
    ["1234567890", "landline-shaped"],
    ["98765432100", "too long"],
  ])("rejects %s (%s) rather than storing something unmatchable", (input) => {
    expect(normalizePhone(input)).toBe("");
  });

  it("rejects non-strings", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(9876543210)).toBe("");
  });

  // ★★ A REPEATED-DIGIT PLACEHOLDER IS NOW ACCEPTED (owner's decision,
  // 2026-09-11). It was refused because `normalizeIndianMobile` refuses it for
  // the COURIER — Shiprocket cannot book 8888888888 — and that rule was
  // borrowed for customer identity, where it does not belong: a shop recording
  // a walk-in is not booking a parcel.
  //
  // ⚠ The hazard it guarded is real and has not vanished: `(store_id, phone)`
  // is UNIQUE, so two walk-ins both entered as 8888888888 land on ONE record.
  // What changed is that the till now SHOWS the first customer's name when the
  // number resolves, so a cashier sees they have the wrong person instead of
  // silently inheriting their history.
  it.each([["8888888888"], ["9999999999"], ["7777777777"]])(
    "accepts the repeated-digit placeholder %s",
    (input) => {
      expect(normalizePhone(input)).toBe(`+91${input}`);
    },
  );
});

describe("validatePosCustomer", () => {
  it("accepts a name and a mobile", () => {
    const r = validatePosCustomer({
      name: " Asha Rao ",
      phone: "+91 98765 43210",
    });
    expect(r).toEqual({
      ok: true,
      name: "Asha Rao",
      phone: "+919876543210",
      email: null,
    });
  });

  it("requires a name", () => {
    const r = validatePosCustomer({ name: "  ", phone: "9876543210" });
    expect(r.ok).toBe(false);
  });

  // ★ Without a phone the row can never be adopted — it is an orphan with a
  // name on it, which is worse than not recording anything.
  it("requires a phone, because that is what a later signup matches on", () => {
    const r = validatePosCustomer({ name: "Asha", phone: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mobile/i);
  });

  it("rejects an unusable phone rather than storing it", () => {
    expect(validatePosCustomer({ name: "Asha", phone: "12345" }).ok).toBe(
      false,
    );
  });

  // The cashier's way of skipping a required field. Two of them would merge
  // two customers, because (store_id, phone) is unique.
  it("accepts a placeholder number, which the courier boundary still refuses", () => {
    // ★★ OWNER'S DECISION (2026-09-11). See normalizePhone above: the rule was
    // the courier's, and a shop recording a walk-in is not booking a parcel.
    const r = validatePosCustomer({ name: "Asha", phone: "8888888888" });
    expect(r).toMatchObject({ ok: true, phone: "+918888888888" });
  });

  it("lower-cases the email and treats a blank one as absent", () => {
    const r = validatePosCustomer({
      name: "Asha",
      phone: "9876543210",
      email: "  ASHA@Example.COM ",
    });
    expect(r.ok && r.email).toBe("asha@example.com");
    const blank = validatePosCustomer({
      name: "Asha",
      phone: "9876543210",
      email: "   ",
    });
    expect(blank.ok && blank.email).toBe(null);
  });

  it("rejects an email with no @", () => {
    expect(
      validatePosCustomer({ name: "A", phone: "9876543210", email: "nope" }).ok,
    ).toBe(false);
  });

  it("caps the name so a paste cannot overflow the column", () => {
    const r = validatePosCustomer({
      name: "x".repeat(300),
      phone: "9876543210",
    });
    expect(r.ok && r.name.length).toBe(80);
  });
});

describe("splitName", () => {
  it.each([
    ["Asha", { first: "Asha", last: null }],
    ["Asha Rao", { first: "Asha", last: "Rao" }],
    ["Asha  Devi Rao", { first: "Asha", last: "Devi Rao" }],
    ["", { first: "", last: null }],
  ])("splits %s", (input, expected) => {
    expect(splitName(input)).toEqual(expected);
  });
});

describe("validatePosCheckoutDetails", () => {
  it("trims, caps and lowercases what the cashier typed", () => {
    expect(
      validatePosCheckoutDetails({
        firstName: "  Rohan  ",
        lastName: "  Sharma ",
        email: "  Rohan@Example.COM  ",
      }),
    ).toEqual({
      ok: true,
      firstName: "Rohan",
      lastName: "Sharma",
      email: "rohan@example.com",
    });
  });

  it("refuses a customer with no first name", () => {
    // ★★ THE OWNER'S DECISION (2026-09-11), which deliberately overrides
    // roadmap invariant 6 for the register: the till used to record a
    // phone-only row rather than asking, and that is what filled customer
    // lists with anonymous "Customer" entries. A new number therefore cannot
    // be charged until it has a name.
    for (const input of [{}, { firstName: "   " }, { email: "a@b.com" }]) {
      expect(validatePosCheckoutDetails(input)).toEqual({
        ok: false,
        error: expect.stringMatching(/first name/i),
      });
    }
  });

  it("keeps the last name and email optional", () => {
    // ★ Plenty of customers give one name, and `users.last_name` is nullable
    // for exactly that — requiring it would refuse a sale over a field the
    // schema never wanted. An email at a counter is often simply not given.
    expect(validatePosCheckoutDetails({ firstName: "Rohan" })).toEqual({
      ok: true,
      firstName: "Rohan",
      lastName: null,
      email: null,
    });
  });

  it("refuses an email that cannot receive a receipt", () => {
    // A typo here is silent: nothing bounces back while the customer is still
    // in the shop.
    for (const email of ["rohan@", "@example.com", "rohan", "a@b"]) {
      expect(validatePosCheckoutDetails({ firstName: "Rohan", email })).toEqual(
        {
          ok: false,
          error: expect.stringMatching(/email/i),
        },
      );
    }
  });

  it("caps a pasted name rather than letting the column refuse the row", () => {
    const long = validatePosCheckoutDetails({ firstName: "x".repeat(200) });
    expect(long.ok && long.firstName).toHaveLength(60);
  });
});
