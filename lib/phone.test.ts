import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHONE_DIAL,
  PHONE_COUNTRIES,
  formatIndianMobile,
  formatStoredPhone,
  normalizeIndianMobile,
  parseStoredPhone,
  phoneLengthHint,
  resolveEnteredPhone,
  storedPhoneVariants,
  toStoredPhone,
} from "./phone";

describe("normalizeIndianMobile", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["09876543210", "9876543210"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each([
    "",
    "1234567890",
    "8888888888",
    "+918888888888",
    "98765",
    "+1 415 555 2671",
  ])("rejects invalid or placeholder number %s", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it("formats the stored customer number consistently", () => {
    expect(formatIndianMobile("09876 543210")).toBe("+919876543210");
  });
});

describe("the canonical stored shape (E.164)", () => {
  it("composes a dial code and a local number", () => {
    expect(toStoredPhone("+91", "98775 42162")).toBe("+919877542162");
    expect(toStoredPhone("+65", "81234567")).toBe("+6581234567");
  });

  it("accepts placeholder digits the carrier boundary refuses", () => {
    // ★★ THE OWNER'S DECISION (2026-09-11). `normalizeIndianMobile` rejects
    // 8888888888 because Shiprocket cannot BOOK it — a different question
    // from "who was at the counter". The register is not booking a courier,
    // so recording it is allowed here and refused there.
    expect(toStoredPhone("+91", "8888888888")).toBe("+918888888888");
    expect(normalizeIndianMobile("8888888888")).toBeNull();
  });

  it("refuses a length the country does not have", () => {
    // Length is the one rule that cannot be dropped: users.phone is a UNIQUE
    // identity column, so a three-digit value is a collision in waiting.
    expect(toStoredPhone("+91", "12345")).toBeNull();
    expect(toStoredPhone("+91", "98775421621")).toBeNull();
    expect(toStoredPhone("+65", "9877542162")).toBeNull();
  });

  it("refuses a dial code the register does not offer", () => {
    expect(toStoredPhone("+999", "9877542162")).toBeNull();
    expect(toStoredPhone("", "9877542162")).toBeNull();
  });

  it("defaults to India, and every country has a length rule", () => {
    expect(DEFAULT_PHONE_DIAL).toBe("+91");
    expect(PHONE_COUNTRIES[0].dial).toBe("+91");
    for (const country of PHONE_COUNTRIES) {
      expect(country.dial.startsWith("+")).toBe(true);
      expect(country.digits.length).toBeGreaterThan(0);
      expect(country.digits.every((n) => n >= 7 && n <= 11)).toBe(true);
    }
    // Dial codes must be unique, or the picker resolves to whichever came first.
    const dials = PHONE_COUNTRIES.map((c) => c.dial);
    expect(new Set(dials).size).toBe(dials.length);
  });

  it("hints the accepted length per country", () => {
    expect(phoneLengthHint("+91")).toBe("10");
    expect(phoneLengthHint("+64")).toBe("8 or 9");
  });
});

describe("parseStoredPhone", () => {
  it("reads a stored E.164 value back apart", () => {
    expect(parseStoredPhone("+919877542162")).toEqual({
      dial: "+91",
      local: "9877542162",
      e164: "+919877542162",
    });
  });

  it("matches the LONGEST dial code, so +91 is not read as +1", () => {
    // ⚠ "+1" is a prefix of every "+91…" string. Shortest-first matching would
    // read an Indian number as a United States one and split it wrongly.
    expect(parseStoredPhone("+919877542162")?.dial).toBe("+91");
    expect(parseStoredPhone("+12025550143")?.dial).toBe("+1");
  });

  it("treats a bare number as the legacy Indian row it is", () => {
    for (const legacy of ["9877542162", "919877542162", "09877542162"]) {
      expect(parseStoredPhone(legacy)?.e164).toBe("+919877542162");
    }
  });

  it("parses a legacy placeholder rather than stranding it", () => {
    // ⚠ If this refused, a row already holding 8888888888 could never be
    // parsed, matched or migrated — the value would be stuck in the database.
    expect(parseStoredPhone("8888888888")?.e164).toBe("+918888888888");
  });

  it("returns null for what is not a phone number", () => {
    for (const junk of ["", "   ", "abc", "12345", null, undefined, 42]) {
      expect(parseStoredPhone(junk)).toBeNull();
    }
  });
});

describe("storedPhoneVariants", () => {
  it("matches both shapes an Indian number may be stored as, canonical first", () => {
    expect(storedPhoneVariants("9877542162")).toEqual([
      "+919877542162",
      "9877542162",
    ]);
    expect(storedPhoneVariants("+91 98775 42162")).toEqual([
      "+919877542162",
      "9877542162",
    ]);
  });

  it("has only one shape outside India, because only one was ever written", () => {
    expect(storedPhoneVariants("+6581234567")).toEqual(["+6581234567"]);
  });

  it("never widens beyond the shapes actually written", () => {
    // A matching rule is a claim that two strings are the same person.
    expect(storedPhoneVariants("9877542162")).toHaveLength(2);
  });

  it("is empty for what cannot be a number", () => {
    for (const junk of ["", "12345", null, undefined, 42]) {
      expect(storedPhoneVariants(junk)).toEqual([]);
    }
  });
});

describe("formatStoredPhone", () => {
  it("groups a number for reading aloud at a counter", () => {
    expect(formatStoredPhone("+919877542162")).toBe("+91 98775 42162");
    expect(formatStoredPhone("9877542162")).toBe("+91 98775 42162");
    expect(formatStoredPhone("+6581234567")).toBe("+65 81234567");
  });

  it("passes an unparseable value through rather than blanking the screen", () => {
    expect(formatStoredPhone("ask at the desk")).toBe("ask at the desk");
  });
});

describe("resolveEnteredPhone", () => {
  it("composes a local number under the chosen country", () => {
    expect(resolveEnteredPhone("+91", "9877542162")).toBe("+919877542162");
    expect(resolveEnteredPhone("+65", "81234567")).toBe("+6581234567");
  });

  it("respects the chosen country over the India assumption", () => {
    // ⚠ THE REASON IT COMPOSES BEFORE IT PARSES. A bare number looks Indian to
    // `parseStoredPhone`, so parsing first would silently file a Singapore
    // customer under +91 whenever their local number happened to be 10 digits.
    expect(resolveEnteredPhone("+60", "9876543210")).toBe("+609876543210");
  });

  it("trusts an explicitly international value that was pasted", () => {
    expect(resolveEnteredPhone("+91", "+91 98775 42162")).toBe("+919877542162");
    expect(resolveEnteredPhone("+91", "+65 8123 4567")).toBe("+6581234567");
  });

  it("returns null rather than guessing at nonsense", () => {
    expect(resolveEnteredPhone("+91", "12345")).toBeNull();
    expect(resolveEnteredPhone("+91", "+999 123")).toBeNull();
    expect(resolveEnteredPhone("+91", null)).toBeNull();
  });
});
