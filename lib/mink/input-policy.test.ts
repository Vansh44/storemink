import { describe, expect, it } from "vitest";
import {
  minkAttachmentsFit,
  minkReadingBudget,
  MINK_INPUT_FILES,
  MINK_MESSAGE_MAX_CHARS,
  MINK_READING_MIN_CHARS,
  MINK_READING_MAX_CHARS,
} from "./input-policy";

describe("reading budget derived from the real message", () => {
  it("gives a lone reading the cap", () => {
    expect(minkReadingBudget(20, 1)).toBe(MINK_READING_MAX_CHARS);
  });

  // ★★ THE WHOLE POINT: five readings plus a long message must not be able to
  // overflow the cap. The old `floor(7500 / count)` was unrelated to
  // MINK_MESSAGE_MAX_CHARS, so the overflow surfaced at the end of submit()
  // AFTER every provider call had been paid for.
  it("shares what is actually left between the pending readings", () => {
    const budget = minkReadingBudget(6_000, MINK_INPUT_FILES)!;
    expect(budget).toBeGreaterThanOrEqual(MINK_READING_MIN_CHARS);
    expect(budget * MINK_INPUT_FILES + 6_000).toBeLessThan(
      MINK_MESSAGE_MAX_CHARS,
    );
  });

  it("narrows as the message it is measured against grows", () => {
    expect(minkReadingBudget(9_000, 3)!).toBeLessThan(
      minkReadingBudget(1_000, 3)!,
    );
  });

  // ★ Null, not a clamp to the floor: calling the provider for a reading that
  //   cannot fit the message being assembled is the waste this prevents.
  it("refuses rather than clamping when there is no room", () => {
    expect(minkReadingBudget(MINK_MESSAGE_MAX_CHARS - 100, 1)).toBeNull();
  });
});

describe("selection-time fit", () => {
  it("accepts five images with an ordinary message", () => {
    expect(minkAttachmentsFit(200, [], MINK_INPUT_FILES)).toBe(true);
  });

  // ★★ Five 3,000-character notes is a combination the Help guide offers and
  // the message cap cannot hold. Known exactly on the device, so it is refused
  // before anything is staged.
  it("refuses five full-size text files", () => {
    expect(minkAttachmentsFit(20, [3_000, 3_000, 3_000, 3_000, 3_000], 0)).toBe(
      false,
    );
  });

  it("accepts a pair of them", () => {
    expect(minkAttachmentsFit(20, [3_000, 3_000], 0)).toBe(true);
  });

  // ⚠ Provider files are reserved at the FLOOR, not the cap, or an ordinary
  //   five-image message that fits comfortably would be refused up front.
  it("reserves provider readings at the floor, not the cap", () => {
    expect(
      minkAttachmentsFit(
        MINK_MESSAGE_MAX_CHARS -
          MINK_INPUT_FILES * (MINK_READING_MAX_CHARS + 480),
        [],
        MINK_INPUT_FILES,
      ),
    ).toBe(true);
  });
});
