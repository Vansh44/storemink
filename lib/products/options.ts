// ---------------------------------------------------------------------------
// Product option axes ("Size", "Colour") and the variants they generate.
// PURE and client-safe: the product editor, the save action, the storefront
// picker and quick add all read the same rules, so none of them can accept a
// variant another would refuse.
//
// ★ OPTIONS ARE ADDITIVE. A product with no options keeps its free-text
//   variants exactly as before; nothing here changes how such a product is
//   stored or shown.
// ★ A VARIANT'S NAME IS COMPOSED FROM ITS VALUES ("M / Black") when the
//   product has options. Every existing reader — cart, order snapshots,
//   invoices, POS, CSV, Mink — reads `name`, so composing it keeps all of them
//   working with no change, and the composed form is the one Shopify uses.
// ★ VALUES ARE POSITIONAL: `option_values[i]` is the value of `options[i]`.
//   A generated matrix matches existing rows by their values, so regenerating
//   after adding a value keeps every existing row's id — and with it its
//   stock, its SKU and the orders that reference it.
// ---------------------------------------------------------------------------

/** Shopify's limits: three axes, and a matrix a shopper can still navigate. */
export const MAX_OPTIONS = 3;
export const MAX_OPTION_VALUES = 30;
export const MAX_VARIANTS = 100;
export const MAX_OPTION_NAME = 40;
export const MAX_OPTION_VALUE = 60;

export const VARIANT_NAME_SEPARATOR = " / ";

export interface ProductOption {
  name: string;
  values: string[];
  /** Hex colour per value, for a colour axis. Absent = shown as chips. */
  swatches?: Record<string, string>;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clean(v: unknown, max: number): string {
  return typeof v === "string"
    ? v.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

const key = (s: string) => s.toLocaleLowerCase("en-IN");

/** Normalise stored or submitted options, or report why they cannot be used.
 *  Blank values and blank options are dropped rather than refused — a
 *  half-typed editor row is not an error — but a DUPLICATE is refused,
 *  because two "M" values would make two variants indistinguishable. */
export function normalizeOptions(
  raw: unknown,
): { options: ProductOption[] } | { error: string } {
  if (raw == null) return { options: [] };
  if (!Array.isArray(raw)) return { error: "Options must be a list." };
  const options: ProductOption[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = clean(rec.name, MAX_OPTION_NAME);
    const rawValues = Array.isArray(rec.values) ? rec.values : [];
    const values: string[] = [];
    const seen = new Set<string>();
    for (const v of rawValues) {
      const value = clean(v, MAX_OPTION_VALUE);
      if (!value) continue;
      if (value.includes(VARIANT_NAME_SEPARATOR.trim()))
        return {
          error: `"${value}" can't contain "/" — it separates option values in a variant's name.`,
        };
      if (seen.has(key(value)))
        return { error: `"${name || "An option"}" lists "${value}" twice.` };
      seen.add(key(value));
      values.push(value);
    }
    if (!name && values.length === 0) continue;
    if (!name) return { error: "Every option needs a name, like Size." };
    if (values.length === 0)
      return { error: `Add at least one value to "${name}".` };
    if (values.length > MAX_OPTION_VALUES)
      return {
        error: `"${name}" can have at most ${MAX_OPTION_VALUES} values.`,
      };
    if (names.has(key(name)))
      return { error: `There are two options called "${name}".` };
    names.add(key(name));

    let swatches: Record<string, string> | undefined;
    if (rec.swatches && typeof rec.swatches === "object") {
      for (const [value, hex] of Object.entries(
        rec.swatches as Record<string, unknown>,
      )) {
        const match = values.find((v) => key(v) === key(value));
        if (match && typeof hex === "string" && HEX_RE.test(hex.trim())) {
          (swatches ??= {})[match] = hex.trim().toLowerCase();
        }
      }
    }
    options.push(swatches ? { name, values, swatches } : { name, values });
  }
  if (options.length > MAX_OPTIONS)
    return { error: `A product can have at most ${MAX_OPTIONS} options.` };
  const combos = options.reduce((n, o) => n * o.values.length, 1);
  if (options.length > 0 && combos > MAX_VARIANTS)
    return {
      error: `These options make ${combos} combinations; the most a product can have is ${MAX_VARIANTS}.`,
    };
  return { options };
}

/** The display name a variant takes from its values. */
export function composeVariantName(values: readonly string[]): string {
  return values.join(VARIANT_NAME_SEPARATOR);
}

export const comboKey = (values: readonly string[]) =>
  values.map(key).join("\u0000");

/** Snap a variant's submitted values onto the canonical option values
 *  (case-insensitive), or null when one is missing or unknown. */
export function canonicalValues(
  options: readonly ProductOption[],
  raw: unknown,
): string[] | null {
  if (!Array.isArray(raw) || raw.length !== options.length) return null;
  const out: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const v = clean(raw[i], MAX_OPTION_VALUE);
    const match = options[i].values.find((x) => key(x) === key(v));
    if (!match) return null;
    out.push(match);
  }
  return out;
}

/** Check every variant has a complete, known and unique combination. */
export function validateVariantCombos(
  options: readonly ProductOption[],
  variants: readonly { option_values?: unknown }[],
): { values: string[][] } | { error: string } {
  if (options.length === 0) return { values: variants.map(() => []) };
  const seen = new Set<string>();
  const values: string[][] = [];
  for (const [i, v] of variants.entries()) {
    const canon = canonicalValues(options, v.option_values);
    if (!canon)
      return {
        error: `Variant ${i + 1} needs a value for every option (${options.map((o) => o.name).join(", ")}).`,
      };
    const k = comboKey(canon);
    if (seen.has(k))
      return {
        error: `Two variants are both "${composeVariantName(canon)}".`,
      };
    seen.add(k);
    values.push(canon);
  }
  return { values };
}

/** Every combination of the options, in option order (first axis slowest). */
/** A variant NAME read back into its combination ("m / black" → ["M",
 *  "Black"]), for a writer that only has the name — a CSV row. Null when the
 *  name is not exactly one value per option. */
export function optionValuesForName(
  options: readonly ProductOption[],
  name: string,
): string[] | null {
  if (options.length === 0) return null;
  return canonicalValues(options, String(name ?? "").split("/"));
}

/**
 * The one step every writer takes — the product editor's save, a theme seed,
 * a Theme Studio package: normalise the options, check every variant holds a
 * unique complete combination, and compose each variant's name from it.
 * With no options, every variant's values are cleared and its name kept.
 *
 * ★ One implementation, because the variant NAME is what the cart, the order
 *   snapshot, invoices and the till all read. A second copy that composed it
 *   differently ("M/Black") would make the same product read two ways.
 */
export function resolveOptionRows<
  V extends { name: string; option_values?: unknown },
>(
  rawOptions: unknown,
  variants: readonly V[],
):
  | { options: ProductOption[]; variants: (V & { option_values: string[] })[] }
  | { error: string } {
  const normalized = normalizeOptions(rawOptions ?? []);
  if ("error" in normalized) return normalized;
  const { options } = normalized;
  if (options.length === 0) {
    return {
      options,
      variants: variants.map((v) => ({ ...v, option_values: [] })),
    };
  }
  if (variants.length === 0)
    return { error: "Generate the variants for these options first." };
  const combos = validateVariantCombos(options, variants);
  if ("error" in combos) return combos;
  return {
    options,
    variants: variants.map((v, i) => ({
      ...v,
      option_values: combos.values[i],
      name: composeVariantName(combos.values[i]),
    })),
  };
}

export function allCombinations(options: readonly ProductOption[]): string[][] {
  return options.reduce<string[][]>(
    (acc, o) => acc.flatMap((prefix) => o.values.map((v) => [...prefix, v])),
    [[]],
  );
}

/**
 * The variant rows a set of options produces, keeping every existing row
 * whose combination still exists. An existing row matches in two ways:
 * its full combination, or — when an option has just been ADDED — its old
 * values as a prefix, in which case it takes the new option's FIRST value
 * (Shopify's behaviour: the row you had becomes "M / Black", not deleted).
 * Legacy free-text rows are matched to a single option by name, so turning a
 * product's "S", "M", "L" variants into a Size option keeps all three rows.
 */
export function generateVariantRows<
  T extends { name: string; option_values?: string[] },
>(
  options: readonly ProductOption[],
  existing: readonly T[],
  blank: (values: string[]) => T,
): T[] {
  const combos = allCombinations(options);
  const byCombo = new Map<string, T>();
  const claim = (k: string, row: T) => {
    if (!byCombo.has(k)) byCombo.set(k, row);
  };
  for (const row of existing) {
    const vals = row.option_values ?? [];
    if (vals.length > 0) {
      // Pad a shorter combination (an option was added) with first values.
      const padded = options.map((o, i) =>
        i < vals.length ? vals[i] : o.values[0],
      );
      const canon = canonicalValues(options, padded);
      if (canon) claim(comboKey(canon), row);
    } else if (options.length > 0) {
      // Legacy row: its name may be a value of the first option.
      const padded = options.map((o, i) => (i === 0 ? row.name : o.values[0]));
      const canon = canonicalValues(options, padded);
      if (canon) claim(comboKey(canon), row);
    }
  }
  return combos.map((values) => {
    const row = byCombo.get(comboKey(values));
    const name = composeVariantName(values);
    return row
      ? { ...row, name, option_values: values }
      : { ...blank(values), name, option_values: values };
  });
}

// --------------------------------------------------------------- storefront

/** The minimum a picker needs to know about a variant. */
export interface PickableVariant {
  id: string;
  option_values: string[];
  available: boolean;
}

/** True when the product can use per-axis pickers: options exist and every
 *  variant carries a valid combination. Anything else falls back to the flat
 *  list, so inconsistent data can never hide a variant from a shopper. */
export function usesOptionPickers(
  options: readonly ProductOption[],
  variants: readonly { option_values?: unknown }[],
): boolean {
  if (options.length === 0 || variants.length === 0) return false;
  return "values" in validateVariantCombos(options, variants);
}

/** The variant matching every selected value, if one exists. */
export function findVariant<V extends PickableVariant>(
  variants: readonly V[],
  selected: readonly string[],
): V | undefined {
  const k = comboKey(selected);
  return variants.find((v) => comboKey(v.option_values) === k);
}

/**
 * For each value of option `axis`: can the shopper buy it, given what they
 * have picked on the OTHER axes? `exists` is false when no variant has the
 * combination at all (hidden-worthy), `available` when one exists and is in
 * stock. This is what greys out "XL" once "Black" is chosen.
 */
export function valueStates<V extends PickableVariant>(
  options: readonly ProductOption[],
  variants: readonly V[],
  selected: readonly string[],
  axis: number,
): { value: string; exists: boolean; available: boolean }[] {
  return options[axis].values.map((value) => {
    const candidate = selected.map((s, i) => (i === axis ? value : s));
    const match = findVariant(variants, candidate);
    return {
      value,
      exists: !!match,
      available: !!match?.available,
    };
  });
}

/**
 * The variant to switch to when the shopper picks `value` on `axis`. The
 * exact combination wins whenever it EXISTS — sold out included, so the page
 * says "Sold out" about precisely what they asked for instead of silently
 * swapping their colour. Only a combination that does not exist moves to the
 * nearest variant with that value (available first, then the one keeping the
 * most of the other picks) — never a dead end with nothing selected.
 */
export function selectValue<V extends PickableVariant>(
  variants: readonly V[],
  selected: readonly string[],
  axis: number,
  value: string,
): V | undefined {
  const wanted = selected.map((s, i) => (i === axis ? value : s));
  const exact = findVariant(variants, wanted);
  if (exact) return exact;
  const withValue = variants.filter(
    (v) => key(v.option_values[axis] ?? "") === key(value),
  );
  const score = (v: V) =>
    v.option_values.reduce(
      (n, x, i) => n + (i !== axis && key(x) === key(wanted[i] ?? "") ? 1 : 0),
      0,
    );
  const ranked = [...withValue].sort(
    (a, b) => Number(b.available) - Number(a.available) || score(b) - score(a),
  );
  return ranked[0];
}

/** The variant a page opens on: the requested one if it exists, otherwise
 *  the first AVAILABLE one in the merchant's order, otherwise the first. */
export function initialVariant<V extends { id: string; available: boolean }>(
  variants: readonly V[],
  requestedId?: string | null,
): V | undefined {
  if (requestedId) {
    const requested = variants.find((v) => v.id === requestedId);
    if (requested) return requested;
  }
  return variants.find((v) => v.available) ?? variants[0];
}

/** The option that is shown as colour swatches, if any. */
export function swatchAxis(options: readonly ProductOption[]): number {
  return options.findIndex(
    (o) => !!o.swatches && Object.keys(o.swatches).length > 0,
  );
}

const COLOUR_WORDS: Record<string, string> = {
  black: "#111111",
  white: "#f7f7f5",
  ivory: "#f3eee0",
  cream: "#f1e8d4",
  beige: "#d9c7a7",
  sand: "#d6c3a1",
  tan: "#c19a6b",
  camel: "#b8864b",
  brown: "#6b4226",
  chocolate: "#4a2c1d",
  grey: "#8e8e8e",
  gray: "#8e8e8e",
  charcoal: "#36454f",
  silver: "#c0c0c0",
  gold: "#c9a227",
  red: "#c0392b",
  maroon: "#6d1a22",
  burgundy: "#6d1a2c",
  pink: "#e8a0b4",
  blush: "#e8c4c0",
  orange: "#e67e22",
  rust: "#a4481f",
  yellow: "#f1c40f",
  mustard: "#c9a227",
  green: "#2e8b57",
  olive: "#6b7040",
  sage: "#9caf88",
  teal: "#1f7a7a",
  blue: "#2c5aa0",
  navy: "#1b2a4a",
  cobalt: "#1f3fa6",
  sky: "#87ceeb",
  purple: "#6c3483",
  lilac: "#b69fcb",
  bone: "#e3dac9",
};

/** A starting swatch for a colour value, from the words in its name
 *  ("Navy blue" → navy). Grey when nothing matches — the merchant can always
 *  pick the real colour. */
export function guessSwatch(value: string): string {
  const words = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  for (const w of words) if (COLOUR_WORDS[w]) return COLOUR_WORDS[w];
  return "#9ca3af";
}
