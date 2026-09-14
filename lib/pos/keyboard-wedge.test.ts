// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createKeyboardWedge,
  isEditableTarget,
  isTouchPrimary,
} from "./keyboard-wedge";

/** A scanner types fast: a few ms per character. */
function scan(
  wedge: ReturnType<typeof createKeyboardWedge>,
  code: string,
  { start = 1000, step = 6 } = {},
) {
  let at = start;
  for (const ch of code) {
    wedge.handleKey(ch, at);
    at += step;
  }
  return wedge.handleKey("Enter", at);
}

describe("createKeyboardWedge", () => {
  it("turns a fast burst ending in Enter into a scan", () => {
    const wedge = createKeyboardWedge();
    expect(scan(wedge, "8901234567890")).toEqual({
      type: "scan",
      code: "8901234567890",
    });
  });

  it("reports every character as buffered so the caller can swallow it", () => {
    // This is what stops a scan's characters from re-triggering the product
    // tile a cashier just tapped (Space and Enter both activate a focused
    // button).
    const wedge = createKeyboardWedge();
    expect(wedge.handleKey("8", 1000)).toEqual({ type: "buffered" });
    expect(wedge.handleKey(" ", 1006)).toEqual({ type: "buffered" });
  });

  it("ignores a burst shorter than minLength", () => {
    const wedge = createKeyboardWedge({ minLength: 3 });
    expect(scan(wedge, "12")).toEqual({ type: "ignored" });
  });

  it("ignores a bare Enter", () => {
    const wedge = createKeyboardWedge();
    expect(wedge.handleKey("Enter", 1000)).toEqual({ type: "ignored" });
  });

  it("starts a fresh burst after a long gap", () => {
    // Two stray keypresses minutes apart must not join into a code.
    const wedge = createKeyboardWedge({ gapMs: 250 });
    wedge.handleKey("9", 1000);
    wedge.handleKey("9", 2000);
    expect(scan(wedge, "12345", { start: 5000 })).toEqual({
      type: "scan",
      code: "12345",
    });
  });

  it("keeps a slow Bluetooth scanner inside one burst", () => {
    const wedge = createKeyboardWedge({ gapMs: 250 });
    expect(scan(wedge, "8901234", { step: 120 })).toEqual({
      type: "scan",
      code: "8901234",
    });
  });

  it("drops the burst on a non-printable key", () => {
    const wedge = createKeyboardWedge();
    wedge.handleKey("1", 1000);
    wedge.handleKey("2", 1006);
    wedge.handleKey("Escape", 1012);
    expect(scan(wedge, "45", { start: 1020 })).toEqual({ type: "ignored" });
  });

  it("caps the buffer so a stuck key cannot grow it without bound", () => {
    const wedge = createKeyboardWedge({ maxLength: 5 });
    const res = scan(wedge, "1234567890");
    expect(res).toEqual({ type: "scan", code: "12345" });
  });

  it("does not carry a completed code into the next scan", () => {
    const wedge = createKeyboardWedge();
    scan(wedge, "1111111");
    expect(scan(wedge, "2222222", { start: 5000 })).toEqual({
      type: "scan",
      code: "2222222",
    });
  });
});

describe("isEditableTarget", () => {
  it("recognises the fields whose keystrokes must be left alone", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
  });

  it("is false for a button, a div, and nothing at all", () => {
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("recognises a contenteditable host", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(isEditableTarget(el)).toBe(true);
  });
});

describe("isTouchPrimary", () => {
  it("is false when matchMedia is unavailable (SSR, jsdom)", () => {
    expect(isTouchPrimary()).toBe(false);
  });
});
