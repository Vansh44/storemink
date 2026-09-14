// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import NotFound from "./not-found";

describe("unknown-store 404 branding", () => {
  it("uses the shared StoreMink mark in the header lockup", () => {
    render(<NotFound />);

    const brand = screen.getByRole("link", { name: "StoreMink" });
    expect(brand).toHaveAttribute("href", expect.stringContaining("storemink"));
    expect(brand.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("storemink-mark.png"),
    );
  });

  it("uses the root layout's global Inter font instead of a storefront font", () => {
    const css = readFileSync(join(process.cwd(), "app/not-found.css"), "utf8");
    const rootRule = css.match(/\.sm404\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(rootRule).toContain("var(--font-inter)");
    expect(rootRule).not.toContain("var(--font-outfit)");
  });
});
