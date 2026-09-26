import { describe, expect, it } from "vitest";
import {
  chooseTone,
  colorLuminance,
  contrastRatio,
  percentile,
  relativeLuminance,
} from "./media-tone";

const INK = relativeLuminance(43, 34, 32); // a warm near-black
const ON_INK = 1; // white
const BLACK = 0;
const WHITE = 1;
const MID = relativeLuminance(128, 128, 128);

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("colour maths", () => {
  it("measures luminance and contrast the WCAG way", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 6);
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 6);
  });

  it("reads the colour formats a theme token can take", () => {
    expect(colorLuminance("#fff")).toBeCloseTo(1, 6);
    expect(colorLuminance(" #000000 ")).toBe(0);
    expect(colorLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 6);
    expect(colorLuminance("rgba(0 0 0 / 50%)")).toBe(0);
    expect(colorLuminance("var(--x)")).toBeNull();
    expect(colorLuminance("")).toBeNull();
  });

  it("takes percentiles from the sorted samples", () => {
    const s = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(s, 0.1)).toBe(1);
    expect(percentile(s, 0.9)).toBe(9);
    expect(percentile(s, 1)).toBe(9);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("chooseTone", () => {
  it("keeps the merchant's colour when it reads", () => {
    expect(chooseTone(fill(100, WHITE), "dark", INK, ON_INK)).toEqual({
      tone: "dark",
      scrim: false,
    });
    expect(chooseTone(fill(100, BLACK), "light", INK, ON_INK)).toEqual({
      tone: "light",
      scrim: false,
    });
  });

  it("switches to the other colour when only that one reads", () => {
    // Dark text chosen, but the words sit on a black boot.
    expect(chooseTone(fill(100, BLACK), "dark", INK, ON_INK)).toEqual({
      tone: "light",
      scrim: false,
    });
    // Light text chosen, but the words sit on a white wall.
    expect(chooseTone(fill(100, WHITE), "light", INK, ON_INK)).toEqual({
      tone: "dark",
      scrim: false,
    });
  });

  it("judges the worst tenth, not the average", () => {
    // Half black, half white averages to grey — both colours would pass an
    // average test, and half the words would vanish.
    const split = [...fill(50, BLACK), ...fill(50, WHITE)];
    expect(chooseTone(split, "dark", INK, ON_INK).scrim).toBe(true);
    expect(chooseTone(split, "light", INK, ON_INK).scrim).toBe(true);
  });

  it("forgives specks below the tail", () => {
    // 5% dark pixels (a stitch line, a shadow) do not flip white-wall copy.
    const speckled = [...fill(95, WHITE), ...fill(5, BLACK)];
    expect(chooseTone(speckled, "dark", INK, ON_INK)).toEqual({
      tone: "dark",
      scrim: false,
    });
  });

  it("on a busy photo keeps the better colour and asks for the scrim", () => {
    const busy = [...fill(40, BLACK), ...fill(20, MID), ...fill(40, WHITE)];
    const d = chooseTone(busy, "dark", INK, ON_INK);
    expect(d.scrim).toBe(true);
    // A tie keeps the merchant's choice rather than flipping on noise.
    expect(chooseTone(fill(10, MID), "dark", MID, MID)).toEqual({
      tone: "dark",
      scrim: true,
    });
  });

  it("changes nothing when there is nothing to measure", () => {
    expect(chooseTone([], "light", INK, ON_INK)).toEqual({
      tone: "light",
      scrim: false,
    });
  });
});
