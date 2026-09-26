import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "./index";
import {
  cleanMotion,
  motionIssues,
  motionRootClasses,
  REVEAL_ALL_EVENT,
  revealsOnScroll,
} from "./motion";
import { validateThemeDesign } from "./validation";

const norm = (css: string) => css.replace(/\s+/g, " ");
const read = (path: string) => norm(readFileSync(path, "utf8"));

describe("motion is opt-in", () => {
  it("reveals nothing when a theme sets nothing or none", () => {
    for (const motion of [undefined, {}, { reveal: "none" as const }]) {
      expect(revealsOnScroll(motion)).toBe(false);
      expect(motionRootClasses(motion)).toEqual([]);
    }
  });

  it("no bundled theme moves", () => {
    for (const theme of THEME_DEFINITIONS) {
      expect(revealsOnScroll(theme.preset.design.motion), theme.id).toBe(false);
    }
  });

  it("fade and rise switch the reveal on, rise adds the lift", () => {
    expect(motionRootClasses({ reveal: "fade" })).toEqual(["sm-reveal"]);
    expect(motionRootClasses({ reveal: "rise" })).toEqual([
      "sm-reveal",
      "sm-reveal-rise",
    ]);
    expect(revealsOnScroll({ reveal: "rise" })).toBe(true);
  });

  it("drops unknown settings rather than acting on them", () => {
    expect(cleanMotion({ reveal: "spin", speed: "fast" })).toEqual({});
    expect(motionRootClasses({ reveal: "spin" } as never)).toEqual([]);
  });
});

describe("motionIssues", () => {
  it("names unknown keys and values, and ignores an absent block", () => {
    expect(motionIssues(undefined)).toEqual([]);
    expect(motionIssues("fade")).toEqual(["motion must be an object."]);
    const issues = motionIssues({ reveal: "spin", speed: "fast" }).join(" ");
    expect(issues).toContain('motion.reveal "spin"');
    expect(issues).toContain("motion.speed is not");
    expect(motionIssues({ reveal: "rise" })).toEqual([]);
  });

  it("theme validation reports it under the motion code", () => {
    const theme = THEME_DEFINITIONS[0];
    const codes = (motion: object) =>
      validateThemeDesign({
        ...theme,
        preset: {
          ...theme.preset,
          design: { ...theme.preset.design, motion },
        },
      }).filter((f) => f.code === "motion");
    expect(codes({ reveal: "spin" })).toHaveLength(1);
    expect(codes({ reveal: "fade" })).toHaveLength(0);
  });
});

describe("the stylesheet and the page wiring", () => {
  const theme = read("app/(storefront)/storefront-theme.css");
  const rule = (selector: string) => {
    const at = theme.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return theme.slice(at + selector.length + 2, theme.indexOf("}", at));
  };
  const PENDING =
    '.sm-reveal.storefront-root .home-section[data-reveal="pending"]';

  it("only a pending section is hidden, and only by the theme class", () => {
    expect(rule(PENDING).trim()).toBe("opacity: 0;");
    expect(
      rule(
        '.sm-reveal-rise.storefront-root .home-section[data-reveal="pending"]',
      ).trim(),
    ).toBe("transform: translateY(24px);");
    // Nothing in the stylesheet hides a section without the theme class.
    const all = theme.split(".home-section[data-reveal").length - 1;
    const guarded =
      theme.split(".sm-reveal.storefront-root .home-section[data-reveal")
        .length -
      1 +
      theme.split(".sm-reveal-rise.storefront-root .home-section[data-reveal")
        .length -
      1;
    expect(all).toBeGreaterThan(0);
    expect(guarded).toBe(all);
  });

  it("a shown section transitions opacity and transform, nothing that moves layout", () => {
    const shown = rule(
      '.sm-reveal.storefront-root .home-section[data-reveal="shown"]',
    );
    expect(shown).toContain("opacity: 1;");
    expect(shown).toContain("transform: none;");
    const transition = /transition: ([^;]+);/.exec(shown)![1];
    // Split on the commas between transitions, not those inside cubic-bezier().
    for (const property of transition.split(/,(?![^(]*\))/)) {
      expect(property.trim().split(" ")[0]).toMatch(/^(opacity|transform)$/);
    }
  });

  it("focus, reduced motion and printing all show a pending section", () => {
    expect(rule(`${PENDING}:focus-within`)).toContain("opacity: 1;");
    for (const media of [
      "@media (prefers-reduced-motion: reduce) {",
      "@media print {",
    ]) {
      const at = theme.indexOf(
        `${media} .sm-reveal.storefront-root .home-section[data-reveal] {`,
      );
      expect(at, media).toBeGreaterThan(-1);
      expect(theme.slice(at, theme.indexOf("}", at))).toContain("opacity: 1;");
    }
  });

  it("the layout mounts the observer only for a moving theme, never in the builder", () => {
    const layout = read("app/(storefront)/layout.tsx");
    expect(layout).toContain(
      "...(previewing ? [] : motionRootClasses(design?.motion))",
    );
    expect(layout).toContain(
      "{!previewing && revealsOnScroll(design?.motion) ? ( <ScrollReveal /> ) : null}",
    );
  });

  it("the acceptance probe shows every section before it measures", () => {
    const probe = read(
      "app/(storefront)/components/studio-acceptance-probe.tsx",
    );
    const reveal = probe.indexOf(
      "window.dispatchEvent(new Event(REVEAL_ALL_EVENT));",
    );
    expect(reveal).toBeGreaterThan(-1);
    expect(reveal).toBeLessThan(probe.indexOf('await import("axe-core")'));
    expect(REVEAL_ALL_EVENT).toBe("sm:reveal-all");
  });
});
