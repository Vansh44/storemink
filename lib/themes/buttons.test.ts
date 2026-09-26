import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/chrome/design";
import { THEME_DEFINITIONS } from "./index";
import { designToCssVars, type ThemeDefinition } from "./types";
import {
  BUTTON_CASES,
  BUTTON_HOVERS,
  BUTTON_SECONDARY_STYLES,
  buttonCssVars,
  buttonIssues,
  buttonRootClasses,
  buttonsDrawColourAsText,
  cleanButtons,
  PRIMARY_BUTTON_SELECTORS,
  SECONDARY_BUTTON_SELECTORS,
  type ThemeButtons,
} from "./buttons";
import { validateThemeDesign } from "./validation";

const norm = (css: string) => css.replace(/\s+/g, " ");

describe("button styles are opt-in", () => {
  it("emit nothing when a theme sets nothing", () => {
    expect(buttonCssVars(undefined)).toEqual({});
    expect(buttonCssVars({})).toEqual({});
    expect(buttonRootClasses(undefined)).toEqual([]);
    expect(buttonRootClasses({})).toEqual([]);
  });

  it("no bundled theme changes: none writes a button variable", () => {
    for (const theme of THEME_DEFINITIONS) {
      const vars = designToCssVars(theme.preset.design, "#000000");
      expect(Object.keys(vars).filter((k) => k.startsWith("--sm-btn"))).toEqual(
        [],
      );
    }
  });

  it("a solid primary and normal case are what buttons already are", () => {
    expect(buttonRootClasses({ primary: "solid", case: "none" })).toEqual([]);
    expect(buttonsDrawColourAsText({ primary: "solid" })).toBe(false);
  });
});

describe("buttonCssVars and root classes", () => {
  it("writes only the chosen settings", () => {
    expect(
      buttonCssVars({ shape: "pill", weight: "bold", tracking: "wide" }),
    ).toEqual({
      "--sm-btn-radius": "999px",
      "--sm-btn-weight": "700",
      "--sm-btn-tracking": "0.08em",
    });
    expect(buttonCssVars({ shape: "square" })).toEqual({
      "--sm-btn-radius": "0px",
    });
  });

  it("switches each property on with its own class", () => {
    expect(
      buttonRootClasses({
        shape: "rounded",
        primary: "outline",
        secondary: "text",
        case: "uppercase",
        weight: "medium",
        tracking: "wide",
        hover: "invert",
      }),
    ).toEqual([
      "sm-btn-shape",
      "sm-btn-p-outline",
      "sm-btn-s-text",
      "sm-btn-upper",
      "sm-btn-weight",
      "sm-btn-track",
      "sm-btn-hover-invert",
    ]);
  });

  it("drops unknown settings rather than writing them into a style", () => {
    expect(
      cleanButtons({
        shape: "blob",
        hover: "glow",
        extra: 1,
        case: "uppercase",
      }),
    ).toEqual({ case: "uppercase" });
    expect(buttonCssVars({ shape: "0; color: red" } as never)).toEqual({});
  });

  it("designToCssVars carries a theme's buttons", () => {
    const theme = THEME_DEFINITIONS[0];
    const vars = designToCssVars(
      { ...theme.preset.design, buttons: { shape: "rounded" } },
      "#000000",
    );
    expect(vars["--sm-btn-radius"]).toBe("8px");
  });

  it("knows which settings draw the button colour as text", () => {
    expect(buttonsDrawColourAsText({ primary: "outline" })).toBe(true);
    expect(buttonsDrawColourAsText({ secondary: "outline" })).toBe(true);
    expect(buttonsDrawColourAsText({ secondary: "text" })).toBe(true);
    expect(buttonsDrawColourAsText({ hover: "invert" })).toBe(true);
    expect(buttonsDrawColourAsText({ secondary: "solid" })).toBe(false);
    expect(buttonsDrawColourAsText({ hover: "lift", shape: "pill" })).toBe(
      false,
    );
  });
});

describe("buttonIssues", () => {
  const jost = { body: "var(--font-jost)" };
  const inter = { body: "var(--font-inter)" };

  it("names a body face that would fake its bold", () => {
    // No weight: buttons keep 600–700, which Jost does not have.
    expect(buttonIssues({ shape: "square" }, jost)[0]).toMatch(
      /faked bold.*no bold weight/,
    );
    expect(buttonIssues({ weight: "bold" }, jost)[0]).toMatch(
      /faked bold.*near 700/,
    );
    expect(buttonIssues({ weight: "medium" }, jost)).toEqual([]);
    expect(buttonIssues({ weight: "bold" }, inter)).toEqual([]);
    expect(buttonIssues({ shape: "pill" }, inter)).toEqual([]);
  });

  it("names unknown keys and values, and ignores an absent block", () => {
    expect(buttonIssues(undefined, inter)).toEqual([]);
    expect(buttonIssues("pill", inter)).toEqual(["buttons must be an object."]);
    const issues = buttonIssues({ shape: "blob", colour: "red" }, inter).join(
      " ",
    );
    expect(issues).toContain('buttons.shape "blob"');
    expect(issues).toContain("buttons.colour is not");
  });
});

describe("theme validation", () => {
  const withButtons = (
    theme: ThemeDefinition,
    buttons: ThemeButtons,
    palette: Record<string, string> = {},
  ): ThemeDefinition => ({
    ...theme,
    preset: {
      ...theme.preset,
      design: {
        ...theme.preset.design,
        palette: { ...theme.preset.design.palette, ...palette },
        buttons,
      },
    },
  });

  it("reports faux bold under the buttons code, only when buttons are set", () => {
    const vitrine = THEME_DEFINITIONS.find((t) => t.id === "vitrine")!;
    expect(vitrine.preset.design.fonts.body).toBe("var(--font-jost)");
    const code = (buttons: ThemeButtons) =>
      validateThemeDesign(withButtons(vitrine, buttons)).filter(
        (f) => f.code === "buttons",
      );
    expect(code({ shape: "square" })).toHaveLength(1);
    expect(code({ shape: "square", weight: "regular" })).toHaveLength(0);
    expect(
      validateThemeDesign(vitrine).filter((f) => f.code === "buttons"),
    ).toEqual([]);
  });

  it("refuses a ring in an accent that does not read on the page", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "studio")!;
    // A pale accent: fine as a button fill with dark text, unreadable as text.
    const pale = { accent: "#f2c94c", onAccent: "#17130f" };
    expect(
      contrastRatio(pale.accent, theme.preset.design.palette.cream),
    ).toBeLessThan(4.5);
    const contrast = (buttons: ThemeButtons) =>
      validateThemeDesign(withButtons(theme, buttons, pale)).filter((f) =>
        f.message.startsWith("Ringed and text buttons"),
      );
    expect(contrast({ primary: "outline" }).length).toBeGreaterThan(0);
    expect(contrast({ secondary: "text" }).length).toBeGreaterThan(0);
    expect(contrast({ hover: "invert" }).length).toBeGreaterThan(0);
    expect(contrast({ primary: "solid", shape: "pill" })).toEqual([]);
  });

  it("checks a ring inside every colour scheme a page wears", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "studio")!;
    const banded: ThemeDefinition = {
      ...theme,
      preset: {
        ...theme.preset,
        design: {
          ...theme.preset.design,
          palette: { ...theme.preset.design.palette, accent: "#f2c94c" },
          schemes: {
            ...theme.preset.design.schemes,
            // A band's own button colour: fine as a fill, unreadable as text.
            soft: {
              background: "#ffffff",
              text: "#17130f",
              accent: "#f2c94c",
              onAccent: "#17130f",
            },
          },
          buttons: { primary: "outline" },
        },
      },
    };
    const ringed = validateThemeDesign(banded).filter((f) =>
      f.message.startsWith("Ringed buttons in the Soft scheme"),
    );
    expect(ringed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The stylesheets and markup reach every button.
// ---------------------------------------------------------------------------

const theme = norm(
  readFileSync("app/(storefront)/storefront-theme.css", "utf8"),
);
const SHEETS = [
  "app/(storefront)/components/homepage/homepage.css",
  "app/(storefront)/(pages)/shop/shop.css",
  "app/(storefront)/(pages)/cart/cart.css",
  "app/(storefront)/storefront-theme.css",
].map((path) => norm(readFileSync(path, "utf8")));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// The review form reuses the PDP button classes for Submit and Cancel. It is a
// form, so it keeps its own look and deliberately wears no role.
const FORM_FILES = ["reviews-section.tsx"];

describe("every storefront action wears its role", () => {
  const files = sourceFiles("app/(storefront)").filter(
    (f) => !FORM_FILES.some((form) => f.endsWith(form)),
  );
  const literals = files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/"([^"\n]*)"/g)].map((m) => m[1]),
  );

  for (const [role, selectors] of [
    ["sm-btn-primary", PRIMARY_BUTTON_SELECTORS],
    ["sm-btn-secondary", SECONDARY_BUTTON_SELECTORS],
  ] as const) {
    for (const selector of selectors) {
      it(`${selector} carries ${role}`, () => {
        const name = selector.slice(1);
        const uses = literals.filter((text) =>
          text.split(/\s+/).includes(name),
        );
        expect(uses.length, selector).toBeGreaterThan(0);
        for (const text of uses) expect(text, selector).toContain(role);
      });
    }
  }
});

describe("the stylesheets reach every button", () => {
  const ruleBodies = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(
      `([^{}]*${escaped}(?![\\w-])[^{}:]*)\\{([^{}]*)\\}`,
      "g",
    );
    return SHEETS.flatMap((css) =>
      [...css.matchAll(rule)]
        .filter((m) => !/:(hover|disabled|focus)/.test(m[1]))
        .map((m) => m[2]),
    );
  };

  for (const selector of [
    ...PRIMARY_BUTTON_SELECTORS,
    ...SECONDARY_BUTTON_SELECTORS,
  ]) {
    it(`${selector} declares the colours the ring and hover rules read`, () => {
      const bodies = ruleBodies(selector).join(" ");
      expect(bodies, selector).toContain("--sm-btn-bg:");
      expect(bodies, selector).toContain("--sm-btn-fg:");
      // Its own paint reads them, so the pair cannot drift from what shows.
      expect(bodies, selector).toMatch(
        /(background|color): var\(--sm-btn-(bg|fg)\)/,
      );
    });
  }

  it("a button that is a ring at rest says so", () => {
    for (const selector of [".pdp-btn-cart", ".shop-more-btn"]) {
      const bodies = ruleBodies(selector).join(" ");
      for (const name of [
        "--sm-btn-rest-bg: transparent",
        "--sm-btn-inv-bg: var(--sm-btn-bg)",
        "--sm-btn-hover-filter: none",
      ]) {
        expect(bodies, `${selector} ${name}`).toContain(name);
      }
    }
  });

  it("every root class the helper can emit has a rule", () => {
    const all = new Set<string>();
    for (const secondary of BUTTON_SECONDARY_STYLES) {
      for (const hover of BUTTON_HOVERS) {
        for (const kase of BUTTON_CASES) {
          for (const cls of buttonRootClasses({
            shape: "pill",
            primary: "outline",
            secondary,
            case: kase,
            weight: "bold",
            tracking: "wide",
            hover,
          })) {
            all.add(cls);
          }
        }
      }
    }
    expect(all.size).toBe(11);
    for (const cls of all) {
      expect(theme, cls).toContain(`.${cls}.storefront-root`);
    }
  });

  it("each property rule sets the property from its variable", () => {
    const body = (head: string) => {
      const start = theme.indexOf(head);
      expect(start, head).toBeGreaterThan(-1);
      return theme
        .slice(theme.indexOf("{", start) + 1, theme.indexOf("}", start))
        .trim();
    };
    expect(
      body(
        ".sm-btn-shape.storefront-root :is(.sm-btn-primary, .sm-btn-secondary):not(.home-newsletter-button)",
      ),
    ).toBe("border-radius: var(--sm-btn-radius);");
    expect(
      body(
        ".sm-btn-upper.storefront-root :is(.sm-btn-primary, .sm-btn-secondary)",
      ),
    ).toBe("text-transform: uppercase;");
    expect(
      body(
        ".sm-btn-weight.storefront-root :is(.sm-btn-primary, .sm-btn-secondary)",
      ),
    ).toBe("font-weight: var(--sm-btn-weight);");
    expect(
      body(
        ".sm-btn-track.storefront-root :is(.sm-btn-primary, .sm-btn-secondary)",
      ),
    ).toBe("letter-spacing: var(--sm-btn-tracking);");
  });

  it("a ring takes the copy's own colour on a colour field or photo", () => {
    // Both field rules — the inverted hover and the ringed primary — must
    // name every field, the newsletter card included (its light theme is an
    // ink card, where a ring in a dark accent reads ink on ink).
    const fields =
      ":is(.home-hero, .home-carousel-slide, .home-banner, .home-newsletter) .sm-btn-primary";
    const rules: Record<string, string> = {
      ".storefront-root ": "--sm-btn-inv-ring: currentColor",
      ".sm-btn-p-outline.storefront-root ": "--sm-btn-bg: currentColor",
    };
    for (const [prefix, declaration] of Object.entries(rules)) {
      const start = theme.indexOf(`${prefix}${fields}`);
      expect(start, prefix).toBeGreaterThan(-1);
      expect(theme.slice(start, theme.indexOf("}", start))).toContain(
        declaration,
      );
    }
  });

  it("the storefront layout puts the root classes on the themed root", () => {
    const layout = norm(readFileSync("app/(storefront)/layout.tsx", "utf8"));
    expect(layout).toContain("...buttonRootClasses(design?.buttons)");
  });

  it("hover rules come after the fill rules they override", () => {
    const fillHover = theme.indexOf(
      ".sm-btn-p-outline.storefront-root .sm-btn-primary:hover:not(:disabled)",
    );
    const text = theme.indexOf(
      ".sm-btn-s-text.storefront-root .sm-btn-secondary:hover:not(:disabled)",
    );
    for (const hover of BUTTON_HOVERS) {
      const at = theme.indexOf(`.sm-btn-hover-${hover}.storefront-root`);
      expect(at, hover).toBeGreaterThan(fillHover);
      // An underlined label ignores every chosen hover, so it comes last.
      expect(text, hover).toBeGreaterThan(at);
    }
  });
});
