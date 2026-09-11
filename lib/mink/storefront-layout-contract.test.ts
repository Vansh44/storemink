import { describe, expect, it } from "vitest";
import {
  MINK_STOREFRONT_LAYOUT_MAX_CHARS,
  assertLayoutPreservesCustomCode,
  digestMinkStorefrontSections,
  resolveKeptLayoutSections,
  summarizeLayoutChange,
  validateMinkStorefrontLayoutPatch,
} from "./storefront-layout-contract";
import { EMPTY_CONFIG } from "@/lib/sections/registry";
import type { PageSectionItem } from "@/lib/sections/registry";

const target = {
  pageSlug: "home",
  expectedPageVersion: "2026-09-11 10:00:00.123456+00",
  expectedSectionsDigest: "a".repeat(64),
};

const richText = (id: string, html = "<p>Hello</p>"): PageSectionItem => ({
  id,
  type: "rich_text",
  enabled: true,
  config: { ...EMPTY_CONFIG.rich_text, html } as PageSectionItem["config"],
});

const customCode = (id: string, html: string): PageSectionItem => ({
  id,
  type: "custom_code",
  enabled: true,
  config: { ...EMPTY_CONFIG.custom_code, html } as PageSectionItem["config"],
});

const patch = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  operation: "replace_page_sections",
  target,
  sections: [richText("hero-1")],
  ...over,
});

describe("validateMinkStorefrontLayoutPatch", () => {
  it("accepts a well-formed list and returns the normalised sections", () => {
    const result = validateMinkStorefrontLayoutPatch(patch());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sections).toHaveLength(1);
    expect(result.value.target.expectedSectionsDigest).toBe("a".repeat(64));
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A key we silently drop is a field the model believes it set.
    const result = validateMinkStorefrontLayoutPatch(
      patch({ publish: true }) as unknown,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("patch.publish is not allowed");
  });

  it("requires the exact optimistic-lock pair", () => {
    for (const bad of [
      { ...target, expectedPageVersion: "" },
      { ...target, expectedSectionsDigest: "not-a-digest" },
      { ...target, expectedSectionsDigest: "A".repeat(63) },
    ]) {
      expect(validateMinkStorefrontLayoutPatch(patch({ target: bad })).ok).toBe(
        false,
      );
    }
  });

  it("normalises a digest's case rather than refusing it", () => {
    const result = validateMinkStorefrontLayoutPatch(
      patch({ target: { ...target, expectedSectionsDigest: "A".repeat(64) } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.expectedSectionsDigest).toBe("a".repeat(64));
  });

  it("refuses an empty list — a blank page is not a one-click approval", () => {
    const result = validateMinkStorefrontLayoutPatch(patch({ sections: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("at least one section");
  });

  it("defers to the registry for every per-section config", () => {
    // The point of running validateSections here: a proposal cannot carry a
    // field the builder itself would refuse to save.
    const result = validateMinkStorefrontLayoutPatch(
      patch({
        sections: [
          { id: "x", type: "not_a_section", enabled: true, config: {} },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("unknown section type");
  });

  it("rejects a duplicate section id", () => {
    const result = validateMinkStorefrontLayoutPatch(
      patch({ sections: [richText("a"), richText("a")] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an id that is not a simple identifier", () => {
    const result = validateMinkStorefrontLayoutPatch(
      patch({ sections: [richText("../etc/passwd")] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("simple identifier");
  });

  it("enforces the registry's 40-section cap", () => {
    const many = Array.from({ length: 41 }, (_, i) => richText(`s${i}`));
    const result = validateMinkStorefrontLayoutPatch(patch({ sections: many }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toMatch(/at most 40 sections/);
  });

  it("bounds the stored payload", () => {
    const huge = Array.from({ length: 30 }, (_, i) =>
      richText(`s${i}`, "<p>" + "x".repeat(6_000) + "</p>"),
    );
    const result = validateMinkStorefrontLayoutPatch(patch({ sections: huge }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain(
      String(MINK_STOREFRONT_LAYOUT_MAX_CHARS),
    );
  });
});

// The boundary that keeps this tool from becoming a way to ship arbitrary
// JavaScript while the separate code gate is switched off.
describe("assertLayoutPreservesCustomCode", () => {
  const current = [richText("a"), customCode("code-1", "<b>original</b>")];

  it("allows a custom-code section through UNCHANGED, including reordered", () => {
    expect(
      assertLayoutPreservesCustomCode(
        [customCode("code-1", "<b>original</b>"), richText("a")],
        current,
      ),
    ).toEqual([]);
  });

  it("REFUSES silently dropping an existing custom-code section", () => {
    // The proposed-side loop cannot see this: omission is deletion under a
    // whole-list replace, and an omitted section is never visited.
    expect(assertLayoutPreservesCustomCode([richText("a")], current)).toEqual([
      expect.stringMatching(/cannot be removed here/),
    ]);
  });

  it("REFUSES a newly invented custom-code section", () => {
    const issues = assertLayoutPreservesCustomCode(
      [...current, customCode("code-2", "<script>x</script>")],
      current,
    );
    expect(issues.join(" ")).toContain("cannot be added here");
  });

  it("REFUSES an edit to existing custom code, however small", () => {
    const issues = assertLayoutPreservesCustomCode(
      [richText("a"), customCode("code-1", "<b>original </b>")],
      current,
    );
    expect(issues.join(" ")).toContain("cannot be edited here");
  });

  it("REFUSES reusing a structured section's id to smuggle code in", () => {
    // "a" exists, so an id check alone would pass; the TYPE has to match too.
    const issues = assertLayoutPreservesCustomCode(
      [customCode("a", "<b>x</b>")],
      current,
    );
    expect(issues.join(" ")).toContain("not a custom-code section");
  });

  it("says nothing about pages that have no custom code at all", () => {
    expect(
      assertLayoutPreservesCustomCode([richText("a")], [richText("a")]),
    ).toEqual([]);
  });
});

describe("summarizeLayoutChange", () => {
  const current = [richText("a"), richText("b"), richText("c")];

  it("reports what a merchant is about to lose and gain", () => {
    expect(
      summarizeLayoutChange([richText("a"), richText("d")], current),
    ).toEqual({
      kept: [{ id: "a", type: "rich_text" }],
      added: [{ id: "d", type: "rich_text" }],
      removed: [
        { id: "b", type: "rich_text" },
        { id: "c", type: "rich_text" },
      ],
      reordered: false,
    });
  });

  it("detects a pure reorder", () => {
    expect(
      summarizeLayoutChange(
        [richText("c"), richText("b"), richText("a")],
        current,
      ).reordered,
    ).toBe(true);
  });

  it("does NOT call a pure delete a reorder", () => {
    // Otherwise the card tells the merchant to look for a rearrangement that
    // never happened.
    expect(summarizeLayoutChange([richText("a")], current).reordered).toBe(
      false,
    );
  });

  it("does NOT call a pure append a reorder", () => {
    expect(
      summarizeLayoutChange([...current, richText("d")], current).reordered,
    ).toBe(false);
  });
});

describe("digestMinkStorefrontSections", () => {
  it("changes when order changes, so the lock catches a reorder", () => {
    const a = [richText("a"), richText("b")];
    const b = [richText("b"), richText("a")];
    expect(digestMinkStorefrontSections(a)).not.toBe(
      digestMinkStorefrontSections(b),
    );
  });

  it("is stable for the same list", () => {
    const a = [richText("a"), richText("b")];
    expect(digestMinkStorefrontSections(a)).toBe(
      digestMinkStorefrontSections([richText("a"), richText("b")]),
    );
  });
});

describe("resolveKeptLayoutSections", () => {
  const current = [richText("a"), customCode("code-1", "<b>original</b>")];

  it("carries a kept section across as the EXACT stored object", () => {
    // Byte-exact by construction rather than by the model's fidelity — which
    // is the whole reason the reference form exists, since the Builder read
    // never shows a section's config or its custom-code source.
    const result = resolveKeptLayoutSections(
      [{ id: "code-1", keep: true }, richText("new")],
      current,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toBe(current[1]);
    expect(
      assertLayoutPreservesCustomCode(
        result.sections as PageSectionItem[],
        current,
      ),
    ).toEqual([]);
  });

  it("REFUSES a reference to a section that is not on the page", () => {
    // Dropping it would delete a section the caller explicitly asked to keep.
    const result = resolveKeptLayoutSections(
      [{ id: "ghost", keep: true }],
      current,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatch(/no section with id/i);
  });

  it("REFUSES a kept section that also carries edits", () => {
    // Otherwise "keep" means "keep, except the bits I also sent" — an edit
    // wearing the word for not editing, and the way custom code would leak
    // past its own guard.
    const result = resolveKeptLayoutSections(
      [{ id: "code-1", keep: true, config: { html: "<b>mine</b>" } }],
      current,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatch(/takes only id and keep/i);
  });

  it("leaves a full section untouched, so an unreferenced list still validates", () => {
    const full = richText("b");
    const result = resolveKeptLayoutSections([full], current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections).toEqual([full]);
  });

  it("refuses a non-array before anything else looks at it", () => {
    expect(resolveKeptLayoutSections("nope", current).ok).toBe(false);
  });
});
