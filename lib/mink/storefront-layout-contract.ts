import "server-only";

import {
  validateConfig,
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import { collectSectionMediaUrls } from "./storefront-media-policy";
import type {
  MinkStorefrontLayoutSectionRef,
  MinkStorefrontLayoutSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Phase 9B - proposing a page's SECTION LIST, not its code.
//
// WHY A SECOND CONTRACT RATHER THAN WIDENING 7B. Phase 7B replaces the
// HTML/CSS/JS inside one existing `custom_code` section, so on a store with no
// such section Mink can change nothing at all, and on one that has it, only
// that block. Everything a merchant means by "make my shop look like this" - a
// hero, a gallery, testimonials, reordering the page - is a STRUCTURED
// section, and none of it was reachable.
//
// AND IT IS STRICTLY SAFER THAN THE CODE PATH, WHICH IS THE POINT. Every field
// here goes through the registry's own `validateConfig`, and the result is
// rendered by our own components, so the output cannot contain script, styles,
// event handlers or a URL we did not sanitise. 7B needs an opaque-origin
// iframe and a prohibited-API list precisely because its output is arbitrary
// code; this needs neither.
// ---------------------------------------------------------------------------

export type { MinkStorefrontLayoutSectionRef, MinkStorefrontLayoutSummary };

export const MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION = 1 as const;
/** Bounds the stored proposal. 40 sections of rich config is already generous. */
export const MINK_STOREFRONT_LAYOUT_MAX_CHARS = 128 * 1024;

export interface MinkStorefrontLayoutPatch {
  schemaVersion: typeof MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION;
  operation: "replace_page_sections";
  target: {
    /** `home` is the public alias for the stored empty homepage slug. */
    pageSlug: string;
    /** Microsecond-preserving optimistic lock, exactly as context returned it. */
    expectedPageVersion: string;
    /** Digest of the CURRENT full section list, not of one section. */
    expectedSectionsDigest: string;
  };
  /**
   * The COMPLETE replacement list.
   *
   * A WHOLE LIST, NOT A DIFF - the same choice 7B makes for a code field, for
   * a stronger reason: this is an ORDERED collection, and "move section 3
   * above section 1, then delete what was section 2" is ambiguous to express
   * and worse to review. A merchant approving a layout change should see the
   * page it produces, not a script for producing it.
   */
  sections: PageSectionItem[];
}

/**
 * Turn `{ id, keep: true }` references into the merchant's own current
 * sections, before anything is validated or stored.
 *
 * ★★ WITHOUT THIS THE TOOL CANNOT BE CALLED AT ALL, and the reason is worth
 * stating because it is invisible from the contract alone. The Builder read
 * (`readMinkStorefrontPageContext`) returns each section's TYPE, position and
 * a prose summary -- never its config, and for a custom-code section never its
 * source, by design. So a model asked to send "the whole list" has no way to
 * reproduce a section it means to leave alone: every proposal would be a
 * rewrite from memory, every custom-code page would be refused outright by
 * `assertLayoutPreservesCustomCode`, and the sections a merchant did not ask
 * to change would quietly lose their settings.
 *
 * ★ A SERVER-SIDE REFERENCE IS ALSO STRICTLY SAFER THAN A ROUND TRIP. "Keep"
 * resolves to the exact stored object, so preservation is guaranteed by
 * construction rather than by the model's fidelity -- and custom code is
 * carried across without the model ever being shown it.
 *
 * ⚠ It resolves against the list the caller read under the SAME optimistic
 * lock it is about to assert. A reference to an id that is not on the page is
 * an error, never a silent omission: dropping it would delete a section the
 * model explicitly asked to keep.
 */
export function resolveKeptLayoutSections(
  rawSections: unknown,
  current: PageSectionItem[],
): { ok: true; sections: unknown[] } | { ok: false; issues: string[] } {
  if (!Array.isArray(rawSections)) {
    return { ok: false, issues: ["sections must be an array."] };
  }
  const currentById = new Map(current.map((section) => [section.id, section]));
  const issues: string[] = [];
  const resolved = rawSections.map((entry, index) => {
    if (!isRecord(entry) || entry.keep !== true) return entry;
    const id = typeof entry.id === "string" ? entry.id : "";
    const existing = currentById.get(id);
    if (!existing) {
      issues.push(
        `Section ${index + 1}: no section with id ${JSON.stringify(id)} is on this page to keep.`,
      );
      return entry;
    }
    const extra = Object.keys(entry).filter(
      (key) => key !== "id" && key !== "keep",
    );
    if (extra.length > 0) {
      // Otherwise "keep" would quietly mean "keep, except the bits I also
      // sent" -- which is an edit wearing the word for not editing.
      issues.push(
        `Section ${index + 1}: a kept section takes only id and keep; send the full section to change ${extra.join(", ")}.`,
      );
      return entry;
    }
    return existing;
  });
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, sections: resolved };
}

const ROOT_KEYS = ["schemaVersion", "operation", "target", "sections"] as const;
const TARGET_KEYS = [
  "pageSlug",
  "expectedPageVersion",
  "expectedSectionsDigest",
] as const;
const SECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${label}.${key} is not allowed.`);
  }
}

/**
 * A section in the proposal that is byte-identical to one the page already
 * stores, keyed by id. These are the merchant's own untouched content.
 */
function carriedOverSectionIds(
  proposed: readonly PageSectionItem[],
  current: readonly PageSectionItem[] | undefined,
): ReadonlySet<string> {
  if (!current?.length) return new Set();
  const fingerprint = (section: PageSectionItem) =>
    digestMinkStorefrontValue({
      type: section.type,
      enabled: section.enabled,
      config: section.config,
      style: section.style ?? null,
    });
  const before = new Map(
    current.map((section) => [section.id, fingerprint(section)]),
  );
  return new Set(
    proposed
      .filter((section) => before.get(section.id) === fingerprint(section))
      .map((section) => section.id),
  );
}

/**
 * Validate a proposed section list: shape, caps, and every per-section config.
 *
 * PUBLISH MODE FOR WHAT THE PROPOSAL WRITES, DRAFT MODE FOR WHAT IT CARRIES.
 * The builder's autosave uses "draft" so a half-typed hero never fails a
 * keystroke - but a model is not typing, it is submitting a finished proposal
 * for a human to approve, and an incomplete section ("Pick at least one
 * product") would render as an empty band on a live storefront. Completeness is
 * part of a proposal being reviewable at all.
 *
 * ★★ BUT THAT BAR MUST NOT REACH THE SECTIONS THE MERCHANT ALREADY HAD, AND
 * APPLYING IT TO THEM WAS A DEAD END. `resolveKeptLayoutSections` swaps every
 * `{id, keep: true}` for the EXACT STORED OBJECT, so an untouched section
 * arrived here and was re-judged at a bar it never had to meet when the builder
 * saved it. One empty `custom_code` block on a page - which draft mode stores
 * happily and publish mode refuses with "Add some HTML, CSS or JavaScript
 * first." - therefore made EVERY layout proposal on that page impossible.
 * Observed in production: the merchant was told to go and delete the block in
 * Website Builder, on a plan whose `pages.customCode` entitlement is off, so
 * the section was not editable or removable there either. A refusal with no
 * reachable remedy, over a section nobody had asked to change.
 *
 * ⚠ THE LENIENT SET IS "UNCHANGED", NOT "KEPT BY REFERENCE". Both call sites
 * must agree, and by execution time the keep/author distinction is gone - the
 * stored proposal holds fully resolved sections. Comparing against the
 * merchant's own list is derivable at BOTH points from rows already read (the
 * live page at proposal time, the `before` snapshot at approval), so it needs
 * no extra stored field and cannot drift between them. Anything the proposal
 * INTRODUCES or EDITS still meets the publish bar - retyping a section is
 * authoring it, and changing one character forfeits the exemption.
 *
 * ⚠ Omitting `current` keeps the original behaviour (everything at publish),
 * so a caller with no page context fails closed rather than silently lenient.
 */
export function validateMinkStorefrontLayoutPatch(
  input: unknown,
  options: { current?: readonly PageSectionItem[] } = {},
):
  | { ok: true; value: MinkStorefrontLayoutPatch }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: ["Patch must be an object."] };
  }
  rejectUnknownKeys(input, ROOT_KEYS, "patch", issues);
  if (input.schemaVersion !== MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION) {
    issues.push("schemaVersion must be 1.");
  }
  if (input.operation !== "replace_page_sections") {
    issues.push("operation must be replace_page_sections.");
  }

  const target = isRecord(input.target) ? input.target : null;
  if (!target) {
    issues.push("target must be an object.");
    return { ok: false, issues };
  }
  rejectUnknownKeys(target, TARGET_KEYS, "target", issues);

  const pageSlug =
    typeof target.pageSlug === "string" && target.pageSlug.trim()
      ? target.pageSlug.trim()
      : null;
  if (!pageSlug) issues.push("target.pageSlug must be home or an exact slug.");

  const rawVersion =
    typeof target.expectedPageVersion === "string"
      ? target.expectedPageVersion.trim()
      : "";
  const expectedPageVersion =
    rawVersion.length >= 20 && rawVersion.length <= 40 ? rawVersion : null;
  if (!expectedPageVersion) {
    issues.push("target.expectedPageVersion must be the exact page version.");
  }

  const rawDigest =
    typeof target.expectedSectionsDigest === "string"
      ? target.expectedSectionsDigest.trim().toLowerCase()
      : "";
  const expectedSectionsDigest = SHA256_RE.test(rawDigest) ? rawDigest : null;
  if (!expectedSectionsDigest) {
    issues.push("target.expectedSectionsDigest must be the exact list digest.");
  }

  if (!Array.isArray(input.sections)) {
    issues.push("sections must be a list.");
    return { ok: false, issues };
  }
  if (input.sections.length === 0) {
    // A page with no sections renders blank. Deleting every section is a
    // decision a merchant can make deliberately in the builder; it is not
    // something to arrive at by approving an AI proposal in one click.
    issues.push("sections must contain at least one section.");
  }
  for (const [index, section] of input.sections.entries()) {
    const id = isRecord(section) ? section.id : undefined;
    if (typeof id !== "string" || !SECTION_ID_RE.test(id)) {
      issues.push(`Section ${index + 1}: id must be a simple identifier.`);
    }
  }

  // The registry is the authority on every config, so a proposal cannot carry
  // a field the builder itself would refuse to save. It also enforces the
  // 40-section cap and rejects unknown types and duplicate ids. Draft mode
  // first: shape, ids and types apply to every section whatever its origin.
  const validated = validateSections(input.sections, { mode: "draft" });
  if ("error" in validated) issues.push(validated.error);
  else {
    // Then completeness, for the sections this proposal is actually writing.
    const exempt = carriedOverSectionIds(validated.sections, options.current);
    for (const [index, section] of validated.sections.entries()) {
      if (exempt.has(section.id)) continue;
      const strict = validateConfig(section.type, section.config, "publish");
      if ("error" in strict) {
        issues.push(`Section ${index + 1} (${section.type}): ${strict.error}`);
      }
    }
  }

  if (issues.length > 0 || "error" in validated) {
    return {
      ok: false,
      issues: issues.length ? issues : ["Sections are invalid."],
    };
  }

  const patch: MinkStorefrontLayoutPatch = {
    schemaVersion: MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION,
    operation: "replace_page_sections",
    target: {
      pageSlug: pageSlug as string,
      expectedPageVersion: expectedPageVersion as string,
      expectedSectionsDigest: expectedSectionsDigest as string,
    },
    sections: validated.sections,
  };
  if (JSON.stringify(patch).length > MINK_STOREFRONT_LAYOUT_MAX_CHARS) {
    return {
      ok: false,
      issues: [
        `The proposed layout exceeds the ${MINK_STOREFRONT_LAYOUT_MAX_CHARS}-character limit.`,
      ],
    };
  }
  return { ok: true, value: patch };
}

/**
 * The rule that stops this becoming a back door around the code gate.
 *
 * A LAYOUT PROPOSAL MAY PRESERVE A custom_code SECTION BUT NEVER AUTHOR ONE.
 * `custom_code` carries merchant HTML/CSS/JS into a sandboxed iframe, and
 * writing it is governed by its OWN operator gate, credit weight, isolated
 * preview and approval (Phase 7B/7C). If this tool could emit or edit one,
 * `apply_storefront_layout` would be a way to ship arbitrary JavaScript to a
 * storefront while the code gate sat switched off - the widest privilege
 * escalation available in the builder, and on the review card it would look
 * like a routine layout change.
 *
 * So a proposed custom_code section must match an EXISTING one byte for byte,
 * by id. Reordering it is fine; changing a character of it is not, and
 * inventing one is not.
 *
 * ⚠ AND THE RULE IS SYMMETRIC: every custom_code section on the CURRENT page
 * must still be a custom_code section in the proposal, under the same id.
 * Dropping the id deletes the code; re-using it for another type overwrites
 * the code while the review card still calls the section "kept".
 */
export function assertLayoutPreservesCustomCode(
  proposed: PageSectionItem[],
  current: PageSectionItem[],
): string[] {
  const currentById = new Map(current.map((section) => [section.id, section]));
  const issues: string[] = [];
  for (const [index, section] of proposed.entries()) {
    if (section.type !== "custom_code") continue;
    const existing = currentById.get(section.id);
    if (!existing) {
      issues.push(
        `Section ${index + 1}: custom code cannot be added here. Ask for a code proposal instead.`,
      );
      continue;
    }
    if (existing.type !== "custom_code") {
      issues.push(
        `Section ${index + 1}: that id is not a custom-code section on this page.`,
      );
      continue;
    }
    if (
      digestMinkStorefrontValue(existing.config) !==
      digestMinkStorefrontValue(section.config)
    ) {
      issues.push(
        `Section ${index + 1}: existing custom code cannot be edited here. Ask for a code proposal instead.`,
      );
    }
  }
  // ★★ AND THE REVERSE PASS, WHICH THE LOOP ABOVE CANNOT DO. It walks the
  //    PROPOSED list, so an existing custom-code section is never visited when
  //    the proposal stops carrying it -- and under a whole-list replace there
  //    are TWO ways to stop carrying one:
  //
  //    1. OMITTING IT, which is deletion. The easiest accident this contract
  //       can produce and the most expensive: custom code is the merchant's own
  //       hand-written work, and the review card shows a section's LABEL rather
  //       than its content, so approving "Removed: Custom code" would hide what
  //       is being destroyed.
  //    2. ★★ REUSING ITS ID FOR A DIFFERENT TYPE, which is worse, because it is
  //       invisible in the loop above AND on the card. The loop above only
  //       visits sections that are ALREADY custom_code, so a proposed
  //       `{id: <the code section's id>, type: "hero"}` is skipped there; and
  //       the id still exists in the current list, so `summarizeLayoutChange`
  //       files it under KEPT and prints the NEW type's label. The merchant
  //       reads "Kept: Hero" and approves the destruction of their code. So the
  //       TYPE is matched here, never merely the id.
  //
  //    Deleting or replacing one in Website Builder is two clicks; there is no
  //    reason for this path to be able to.
  const proposedTypes = new Map(
    proposed.map((section) => [section.id, section.type]),
  );
  for (const [index, section] of current.entries()) {
    if (section.type !== "custom_code") continue;
    const replacement = proposedTypes.get(section.id);
    if (replacement === "custom_code") continue;
    issues.push(
      replacement === undefined
        ? `Section ${index + 1} of the current page: existing custom code cannot be removed here. Keep it in the list, or remove it in Website Builder.`
        : `Section ${index + 1} of the current page: existing custom code cannot be replaced with a ${replacement} section here. Send {id: ${JSON.stringify(section.id)}, keep: true} to keep it, or change it in Website Builder.`,
    );
  }
  return issues;
}

/** Stable digest of a page's whole section list, for the optimistic lock. */
export function digestMinkStorefrontSections(
  sections: PageSectionItem[],
): string {
  return digestMinkStorefrontValue(sections);
}

/** What changed, for the human review card. */
export function summarizeLayoutChange(
  proposed: PageSectionItem[],
  current: PageSectionItem[],
): MinkStorefrontLayoutSummary {
  const currentSet = new Set(current.map((section) => section.id));
  const proposedSet = new Set(proposed.map((section) => section.id));
  const kept = proposed.filter((section) => currentSet.has(section.id));
  const unchanged = carriedOverSectionIds(proposed, current);
  // Omitted rather than empty when the page has no pictures, so a proposal
  // that shows none is byte-identical to one made before previews existed.
  const previewImageUrls = layoutPreviewImages(proposed, unchanged);
  return {
    ...(previewImageUrls.length ? { previewImageUrls } : {}),
    kept: kept.map(ref),
    added: proposed.filter((section) => !currentSet.has(section.id)).map(ref),
    // Described from the CURRENT list, because a removed section no longer
    // exists in the proposal to be described from.
    removed: current.filter((section) => !proposedSet.has(section.id)).map(ref),
    // Compares the order of the SURVIVING sections only, so a pure add or a
    // pure delete is not reported as a reorder the merchant then hunts for
    // and cannot find.
    reordered:
      kept.map((section) => section.id).join(" ") !==
      current
        .filter((section) => proposedSet.has(section.id))
        .map((section) => section.id)
        .join(" "),
  };
}

function ref(section: PageSectionItem): MinkStorefrontLayoutSectionRef {
  return { id: section.id, type: section.type };
}

/** How many pictures a review card shows before it stops being a summary. */
const MAX_PREVIEW_IMAGES = 4;

/**
 * The pictures this proposal puts on the page.
 *
 * ★ SECTIONS THE PROPOSAL TOUCHED COME FIRST, because those are what the
 * merchant is being asked to judge; a page's untouched existing photographs are
 * shown only to fill the remaining slots, and only so a card is never empty on
 * a pure reorder. ⚠ Found by the `_url` SUFFIX via 9D's collector, never by
 * enumerating section types -- media already lives at three depths and an
 * enumerated list is the thing that goes stale.
 */
function layoutPreviewImages(
  proposed: readonly PageSectionItem[],
  unchanged: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const ordered = [
    ...proposed.filter((section) => !unchanged.has(section.id)),
    ...proposed.filter((section) => unchanged.has(section.id)),
  ];
  for (const section of ordered) {
    for (const url of collectSectionMediaUrls([section])) {
      // A video is media the page loads and is not a thumbnail; the card shows
      // stills only, so a preview never becomes an autoplaying surprise.
      if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) continue;
      seen.add(url);
      if (seen.size >= MAX_PREVIEW_IMAGES) return [...seen];
    }
  }
  return [...seen];
}
