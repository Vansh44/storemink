/**
 * Convert the Indian mobile formats accepted by the storefront into the
 * ten-digit national number Shiprocket expects.  Returning null (instead of a
 * best-effort slice) keeps malformed and obvious placeholder numbers from
 * becoming carrier work that can never be booked.
 */
export function normalizeIndianMobile(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const digits = value.replace(/\D/g, "");
  const national =
    digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;

  if (!/^[6-9]\d{9}$/.test(national)) return null;
  // Shiprocket rejects obvious placeholders such as 8888888888. Catch them at
  // our boundary so the customer can correct the number during checkout.
  if (/^(\d)\1{9}$/.test(national)) return null;

  return national;
}

export function formatIndianMobile(value: unknown): string | null {
  const mobile = normalizeIndianMobile(value);
  return mobile ? `+91${mobile}` : null;
}

// ---------------------------------------------------------------------------
// The canonical stored shape for a customer's number: E.164.
//
// ★★ WHY E.164 AND NOT THE TEN DIGITS. `users.phone` was written two ways by
// the two things that create a customer — website signup stored Identity
// Platform's "+919877542162" while the register stored "9877542162" — and
// `(store_id, phone)` is UNIQUE on the STRING, so the same person held two
// rows and neither side could see the other's. One shape had to win. E.164 is
// it (owner's decision, 2026-09-11): a number with its country code is
// unambiguous, it is what the dashboard should show a merchant, and it is the
// only shape that can hold a number from outside India at all. The bare ten
// digits cannot express one, so choosing them would have capped the product
// at a single country.
//
// ⚠ `normalizeIndianMobile` above is UNCHANGED and stays the CARRIER boundary:
// Shiprocket wants the national number and rejects placeholder digits because
// it cannot book them. That is a different question from "what identifies this
// customer", and the two must not be collapsed — which is why the checkout
// path below does NOT reject placeholders. A shop that wants to record
// 8888888888 for a walk-in is not booking a courier.
// ---------------------------------------------------------------------------

export type PhoneCountry = {
  /** Dial code including the leading plus, e.g. "+91". */
  dial: string;
  iso: string;
  name: string;
  /** Accepted local-number lengths. Several countries have more than one. */
  digits: number[];
};

/**
 * The countries the register offers.
 *
 * ★ CURATED, NOT THE FULL E.164 TABLE. A picker of 240 entries is slower to
 * use at a counter than typing, and every entry needs a correct length rule to
 * be worth having. India is first and default; the rest are the ones an Indian
 * retailer actually meets. Adding one is a line here — no schema change,
 * because the column stores the composed E.164 string.
 */
export const PHONE_COUNTRIES: PhoneCountry[] = [
  { dial: "+91", iso: "IN", name: "India", digits: [10] },
  { dial: "+971", iso: "AE", name: "United Arab Emirates", digits: [9] },
  { dial: "+966", iso: "SA", name: "Saudi Arabia", digits: [9] },
  { dial: "+974", iso: "QA", name: "Qatar", digits: [8] },
  { dial: "+965", iso: "KW", name: "Kuwait", digits: [8] },
  { dial: "+968", iso: "OM", name: "Oman", digits: [8] },
  { dial: "+973", iso: "BH", name: "Bahrain", digits: [8] },
  { dial: "+1", iso: "US", name: "United States / Canada", digits: [10] },
  { dial: "+44", iso: "GB", name: "United Kingdom", digits: [10] },
  { dial: "+61", iso: "AU", name: "Australia", digits: [9] },
  { dial: "+64", iso: "NZ", name: "New Zealand", digits: [8, 9] },
  { dial: "+65", iso: "SG", name: "Singapore", digits: [8] },
  { dial: "+60", iso: "MY", name: "Malaysia", digits: [9, 10] },
  { dial: "+977", iso: "NP", name: "Nepal", digits: [10] },
  { dial: "+880", iso: "BD", name: "Bangladesh", digits: [10] },
  { dial: "+94", iso: "LK", name: "Sri Lanka", digits: [9] },
  { dial: "+975", iso: "BT", name: "Bhutan", digits: [8] },
  { dial: "+960", iso: "MV", name: "Maldives", digits: [7] },
  { dial: "+27", iso: "ZA", name: "South Africa", digits: [9] },
  { dial: "+49", iso: "DE", name: "Germany", digits: [10, 11] },
];

export const DEFAULT_PHONE_DIAL = "+91";

export function phoneCountry(dial: string): PhoneCountry | null {
  return PHONE_COUNTRIES.find((country) => country.dial === dial) ?? null;
}

/** Accepted local lengths for a dial code, as "10" or "8 or 9". */
export function phoneLengthHint(dial: string): string {
  const country = phoneCountry(dial);
  if (!country) return "";
  return country.digits.join(" or ");
}

/**
 * Compose the canonical stored value from a dial code and a local number.
 *
 * ★ LENGTH IS THE ONLY RULE. It cannot be dropped — `users.phone` is a UNIQUE
 * identity column, and three digits in it is a collision waiting to happen —
 * but nothing else is imposed. In particular there is NO placeholder
 * rejection: the register is recording who was at the counter, not booking a
 * courier, and a shop that wants 8888888888 on a walk-in should get it.
 * A repeat of the same number now surfaces the FIRST customer's name on
 * screen, so a cashier can see they have the wrong person rather than
 * silently inheriting their history.
 *
 * @returns E.164 with no separators, or null when the shape is not usable.
 */
export function toStoredPhone(dial: string, local: unknown): string | null {
  const country = phoneCountry(dial);
  if (!country) return null;
  if (typeof local !== "string" && typeof local !== "number") return null;
  const digits = String(local).replace(/\D/g, "");
  if (!country.digits.includes(digits.length)) return null;
  return `${country.dial}${digits}`;
}

/**
 * Turn what a caller actually typed or pasted into the canonical stored value.
 *
 * ★ COMPOSE FIRST, PARSE ONLY AN EXPLICIT INTERNATIONAL VALUE. `toStoredPhone`
 * expects a LOCAL number, and `parseStoredPhone` assumes a bare one is Indian
 * — so parsing first would read a bare ten-digit number as "+91" even when the
 * cashier had chosen another country. Composing first respects their choice,
 * and a value that begins with "+" is unambiguous enough to trust over it
 * (somebody pasted a full number).
 */
export function resolveEnteredPhone(
  dial: string,
  entered: unknown,
): string | null {
  if (typeof entered === "string" && entered.trim().startsWith("+")) {
    return parseStoredPhone(entered)?.e164 ?? null;
  }
  return toStoredPhone(dial, entered);
}

/**
 * Read a stored value back into a country and a local number.
 *
 * ★ A BARE NUMBER IS ASSUMED INDIAN, because that is exactly what the legacy
 * rows are: everything the register wrote before E.164 became canonical. No
 * other country can be inferred from a value with no code, so guessing
 * further would be inventing data.
 *
 * ⚠ Dial codes are matched LONGEST FIRST. "+91" is a prefix of nothing here,
 * but "+1" is a prefix of "+1..." for every NANP number, so shortest-first
 * matching would read "+919877542162" as a United States number.
 */
export function parseStoredPhone(
  value: unknown,
): { dial: string; local: string; e164: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    const byLongestDial = [...PHONE_COUNTRIES].sort(
      (a, b) => b.dial.length - a.dial.length,
    );
    for (const country of byLongestDial) {
      const code = country.dial.slice(1);
      if (!digits.startsWith(code)) continue;
      const local = digits.slice(code.length);
      if (!country.digits.includes(local.length)) continue;
      return { dial: country.dial, local, e164: `${country.dial}${local}` };
    }
    return null;
  }

  // No country code: a legacy Indian row, in any of the shapes that were
  // written — "9877542162", "919877542162", "09877542162".
  const national = normalizeIndianMobileLoose(trimmed);
  if (!national) return null;
  return { dial: "+91", local: national, e164: `+91${national}` };
}

/**
 * India's ten digits, WITHOUT the carrier-driven placeholder rejection.
 *
 * ⚠ Deliberately separate from `normalizeIndianMobile`. That one refuses
 * 8888888888 because Shiprocket cannot book it; refusing to RECOGNISE such a
 * number here would mean a row already holding one could never be parsed,
 * matched or migrated — the value would be stranded in the database.
 */
function normalizeIndianMobileLoose(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national =
    digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

/**
 * Every shape the SAME number may already be stored as in `users.phone`.
 *
 * Rows written before E.164 became canonical hold the bare national number,
 * and they cannot simply be rewritten: a store may already hold BOTH shapes
 * for one person, so an unconditional migration would violate the unique key.
 * Matching every shape costs one `in` clause and finds them all.
 *
 * ⚠ ONLY THE SHAPES THE CODE ACTUALLY PRODUCED — E.164, and the bare national
 * number for India. A matching rule is a claim that two strings are the same
 * person, so widening it on speculation is how one customer's history reaches
 * another's account.
 *
 * @returns the canonical form first, then any legacy equivalent.
 */
export function storedPhoneVariants(value: unknown): string[] {
  const parsed = parseStoredPhone(value);
  if (!parsed) return [];
  return parsed.dial === "+91" ? [parsed.e164, parsed.local] : [parsed.e164];
}

/** "+91 98775 42162" — for reading aloud at a counter, never for storage. */
export function formatStoredPhone(value: unknown): string {
  const parsed = parseStoredPhone(value);
  if (!parsed) return typeof value === "string" ? value : "";
  const local =
    parsed.local.length === 10
      ? `${parsed.local.slice(0, 5)} ${parsed.local.slice(5)}`
      : parsed.local;
  return `${parsed.dial} ${local}`;
}
