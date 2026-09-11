import "server-only";

import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
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
 * Validate a proposed section list: shape, caps, and every per-section config.
 *
 * PUBLISH MODE, NOT DRAFT. The builder's autosave uses "draft" so a half-typed
 * hero never fails a keystroke - but a model is not typing, it is submitting a
 * finished proposal for a human to approve, and an incomplete section ("Pick
 * at least one product") would render as an empty band on a live storefront.
 * Completeness is part of a proposal being reviewable at all.
 */
export function validateMinkStorefrontLayoutPatch(
  input: unknown,
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
  // 40-section cap and rejects unknown types and duplicate ids.
  const validated = validateSections(input.sections, { mode: "publish" });
  if ("error" in validated) issues.push(validated.error);

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
  //    PROPOSED list, so a custom-code section the proposal simply OMITS is
  //    never visited -- and omission is deletion under a whole-list replace.
  //    That is the easiest accident this contract can produce and the most
  //    expensive: custom code is the merchant's own hand-written work, and the
  //    review card shows a section's LABEL rather than its content, so
  //    approving "Removed: Custom code" would hide what is being destroyed.
  //    Deleting one in Website Builder is two clicks; there is no reason for
  //    this path to be able to.
  const proposedIds = new Set(proposed.map((section) => section.id));
  for (const [index, section] of current.entries()) {
    if (section.type !== "custom_code" || proposedIds.has(section.id)) continue;
    issues.push(
      `Section ${index + 1} of the current page: existing custom code cannot be removed here. Keep it in the list, or remove it in Website Builder.`,
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
  return {
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
