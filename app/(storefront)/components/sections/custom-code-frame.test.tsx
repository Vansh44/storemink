import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CustomCodeFrame } from "./custom-code-frame";

const CONFIG = {
  html: '<section class="hero">Private preview</section>',
  css: ".hero { color: rebeccapurple; }",
  js: "document.querySelector('.hero')?.classList.add('ready');",
  height_mode: "fixed" as const,
  fixed_height: 480,
};

describe("CustomCodeFrame Phase 7B isolation", () => {
  it("removes popup authority and injects a deny-by-default CSP for strict previews", () => {
    render(
      <CustomCodeFrame
        config={CONFIG}
        title="Mink private preview"
        strictNetworkIsolation
      />,
    );

    const frame = screen.getByTitle("Mink private preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    const source = frame.getAttribute("srcdoc") ?? "";
    expect(source).toContain("Content-Security-Policy");
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("form-action 'none'");
    expect(source).not.toContain('<base target="_blank">');
    expect(source).toContain("Private preview");
  });

  it("adds the bounded Phase 7D validation harness without weakening isolation", () => {
    render(
      <CustomCodeFrame
        config={CONFIG}
        title="Mink checked publication"
        strictNetworkIsolation
        validation={{
          token: "validation-token",
          viewport: "mobile",
          width: 390,
          onResult: () => undefined,
        }}
      />,
    );
    const frame = screen.getByTitle("Mink checked publication");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const source = frame.getAttribute("srcdoc") ?? "";
    expect(source).toContain('source:"sm-cc-validation"');
    expect(source).toContain('viewport:"mobile"');
    expect(source).toContain("width:390");
    expect(source).toContain("securitypolicyviolation");
    expect(source).toContain("horizontal_overflow");
  });

  it("does not change the established live-storefront sandbox contract", () => {
    render(<CustomCodeFrame config={CONFIG} title="Live custom section" />);
    const frame = screen.getByTitle("Live custom section");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-popups");
    expect(frame.getAttribute("srcdoc")).toContain('<base target="_blank">');
    expect(frame.getAttribute("srcdoc")).not.toContain(
      "Content-Security-Policy",
    );
    // ★ A srcdoc document inherits this attribute, so setting it here strips
    // `Referer` from a live section's third-party requests — which is how a
    // referrer-restricted Google Maps or reCAPTCHA key inside an existing
    // merchant section silently breaks. It belongs to strict previews only.
    expect(frame).not.toHaveAttribute("referrerpolicy");
  });
});
