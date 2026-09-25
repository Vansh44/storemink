// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SectionShell } from "./section-shell";

// PARITY GUARD for the SectionShell refactor: live stores (wholesip, echos)
// have stored sections WITHOUT a `style` key. For those, the shell must render
// byte-identical markup to the old hardcoded roots — same tag, same classes,
// no inline style, no id — with only data-section-id added.
describe("SectionShell", () => {
  it("style-less render matches the pre-shell markup (plus data-section-id)", () => {
    const { container } = render(
      <SectionShell sectionId="s1">
        <span>x</span>
      </SectionShell>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toBe("home-section");
    expect(el.getAttribute("style")).toBeNull();
    expect(el.getAttribute("id")).toBeNull();
    expect(el.getAttribute("data-section-id")).toBe("s1");
  });

  it("keeps the type class exactly where it was (custom_code parity)", () => {
    const { container } = render(
      <SectionShell sectionId="s2" className="home-custom-code">
        <span>x</span>
      </SectionShell>,
    );
    expect((container.firstElementChild as HTMLElement).className).toBe(
      "home-section home-custom-code",
    );
  });

  it("applies style: padding class, fullbleed, background, anchor", () => {
    const { container } = render(
      <SectionShell
        sectionId="s3"
        style={{
          background: "#123456",
          padding_y: "lg",
          width: "full",
          anchor: "story",
        }}
      >
        <span>x</span>
      </SectionShell>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe("home-section home-pad-lg is-fullbleed");
    expect(el.style.background).toBe("rgb(18, 52, 86)");
    expect(el.id).toBe("story");
  });

  it('padding_y "none" adds no class (explicit default)', () => {
    const { container } = render(
      <SectionShell sectionId="s4" style={{ padding_y: "none" }}>
        <span>x</span>
      </SectionShell>,
    );
    expect((container.firstElementChild as HTMLElement).className).toBe(
      "home-section",
    );
  });
});

// "Full width" is a BAND: the background runs edge to edge, the text does not.
// A blanket `padding-inline: 0` on `.is-fullbleed` put media + text copy flush
// against the screen edge on every theme that used a band for it.
describe("full-width band gutter", () => {
  const css = readFileSync(
    "app/(storefront)/components/homepage/homepage.css",
    "utf8",
  );

  it("never drops the gutter for every full-width section", () => {
    expect(css).not.toMatch(/\.home-section\.is-fullbleed\s*\{/);
  });

  it("drops it only for sections that are their own surface", () => {
    const rule =
      /\.home-section\.is-fullbleed:has\(([^)]*)\)\s*\{\s*padding-inline:\s*0/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain(".home-carousel");
    expect(rule![1]).not.toContain(".home-media-text");
  });
});
