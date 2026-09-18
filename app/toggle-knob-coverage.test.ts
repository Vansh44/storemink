import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — an absolutely positioned element that also translates must
// say where it starts.
//
// ★★ THE UA STYLESHEET SETS `text-align: center` ON <button>, AND TAILWIND'S
// PREFLIGHT DOES NOT RESET IT. A box with `position: absolute` and `left: auto`
// falls back to its STATIC position — where it would have sat in flow — and for
// an empty, out-of-flow inline inside a centred button that is the MIDDLE of
// the track, not its left edge.
//
// Measured in a browser on the real 44px track: the knob's static position was
// 22px, so `translate-x-6` put it at 46px and it hung 18px OUTSIDE the pill
// whenever the switch was on, while `translate-x-1` left it sitting right of
// centre when off. Two switches shipped that way
// (settings/analytics and the operator analytics panel); the ones built as
// `inline-flex items-center` were fine, because a flex container places its
// items itself and ignores `text-align`.
//
// TypeScript cannot see this and neither can a render test in jsdom, which
// computes no layout. What it costs to get right is one `left-*` class.
// ---------------------------------------------------------------------------

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (full.endsWith(".tsx") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

/** Every className={`…`} / className="…" expression, newlines included — the
 *  knob's classes are split across lines by the conditional, so a line-based
 *  scan would miss exactly the shape this guards. */
function classNameBlocks(source: string): string[] {
  const blocks: string[] = [];
  const template = /className=\{`([\s\S]*?)`\}/g;
  const plain = /className="([^"]*)"/g;
  for (const re of [template, plain]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) blocks.push(m[1]);
  }
  return blocks;
}

describe("★★ an absolute element that translates declares its own origin", () => {
  const files = [...tsxFiles("app"), ...tsxFiles("components")];

  it("finds real files to scan, so a broken scan cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("never relies on the static position of an absolute, translated box", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const block of classNameBlocks(readFileSync(file, "utf8"))) {
        if (!/\babsolute\b/.test(block)) continue;
        if (!/translate-x-/.test(block)) continue;
        // `left-*`, `right-*` or `inset-*` all pin the box explicitly.
        if (/\b(left-|right-|inset-|-left-|-right-)/.test(block)) continue;
        offenders.push(`${file}: ${block.replace(/\s+/g, " ").trim()}`);
      }
    }
    expect(
      offenders,
      "Add an explicit `left-*` (or `right-*`/`inset-*`). With `left: auto` the " +
        "box starts from its static position, which inside a <button> is the " +
        "CENTRE because the UA sets text-align:center — so a translated toggle " +
        "knob overflows its track when on.",
    ).toEqual([]);
  });
});
