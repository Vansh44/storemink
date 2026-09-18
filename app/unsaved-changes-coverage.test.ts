import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — a form that holds edits until an explicit Save warns before
// a reload throws them away.
//
// A merchant lost a GA4 Measurement ID by typing it, flicking a switch and
// refreshing. Nothing on that page autosaved, so the reload simply discarded
// it — and at the time only three surfaces in the whole codebase had a
// `beforeunload` guard. The rest could silently lose typed work, including the
// policies editor, the one place a merchant writes whole paragraphs.
//
// The rule: if a component computes a dirty flag to gate a Save, it calls
// useUnsavedChangesWarning. A new form that forgets fails here rather than in
// somebody's lost afternoon.
//
// ⚠ NOT a claim that every form is protected — a component that tracks its
// edits some other way is invisible to this scan. It stops the KNOWN shape
// regressing, which is what the reported bug was.
// ---------------------------------------------------------------------------

// ⚠ The trailing "(" matters: the bare name also appears in the import line,
// so matching on it alone let a file pass with the CALL deleted and only the
// import left behind — which is exactly how this regresses in a refactor.
const HOOK = "useUnsavedChangesWarning(";

/** The dirty-flag idioms actually used in this tree. */
const DIRTY = /\b(const|let)\s+\w*[Dd]irty\w*\s*=|\bconst hasChanges\s*=/;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (
      (full.endsWith(".tsx") || full.endsWith(".ts")) &&
      !full.includes(".test.")
    )
      out.push(full);
  }
  return out;
}

/**
 * Surfaces whose "dirty" is not a form the user could lose typing in. Each one
 * is listed with why, so the exemption is a decision rather than an oversight.
 */
const NOT_A_FORM: Record<string, string> = {
  // Empty, and it should stay that way unless a surface genuinely cannot lose
  // typed work. ⚠ Both entries drafted here were WRONG on inspection: one named
  // a file the scan never matched, and the other claimed the builder's autosave
  // covered inspector-panel's page-settings form, which it does not — that form
  // has its own Save and holds the SEO copy locally. An exemption is a claim;
  // check it against the file before writing one.
};

describe("★★ an explicit-Save form warns before a reload discards it", () => {
  const files = [...tsxFiles("app"), ...tsxFiles("components")];

  it("finds real files, so a broken scan cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("guards every component that gates a Save on a dirty flag", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!DIRTY.test(source)) continue;
      // Only forms — a dirty flag that never gates a control is bookkeeping.
      if (!/disabled=\{[^}]*[Dd]irty|disabled=\{[^}]*hasChanges/.test(source))
        continue;
      if (source.includes(HOOK)) continue;
      if (NOT_A_FORM[file]) continue;
      offenders.push(file);
    }
    expect(
      offenders,
      `Call ${HOOK}dirty) — see hooks/use-unsaved-changes-warning.ts. ` +
        `Without it a reload silently discards whatever the merchant typed. ` +
        `If the surface genuinely cannot lose work, add it to NOT_A_FORM with a reason.`,
    ).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still exists", () => {
    // An exemption for a deleted file is a hole nobody can see.
    for (const file of Object.keys(NOT_A_FORM)) {
      expect(files, `${file} is exempted but no longer exists`).toContain(file);
    }
  });
});
