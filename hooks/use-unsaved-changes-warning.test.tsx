// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useUnsavedChangesWarning } from "./use-unsaved-changes-warning";

function fire() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function Harness({ unsaved }: { unsaved: boolean | (() => boolean) }) {
  useUnsavedChangesWarning(unsaved);
  return null;
}

beforeEach(() => cleanup());

describe("useUnsavedChangesWarning", () => {
  it("lets a clean page unload without a prompt", () => {
    render(<Harness unsaved={false} />);
    expect(fire()).toBe(false);
  });

  it("interrupts the unload that would discard edits", () => {
    render(<Harness unsaved />);
    expect(fire()).toBe(true);
  });

  // ★ The listener is registered once and reads a ref, so it must still see a
  // value that changed after mount — the whole point of not re-subscribing.
  it("follows the latest value without re-registering", () => {
    const { rerender } = render(<Harness unsaved={false} />);
    expect(fire()).toBe(false);
    rerender(<Harness unsaved />);
    expect(fire()).toBe(true);
    rerender(<Harness unsaved={false} />);
    expect(fire()).toBe(false);
  });

  it("accepts a getter, for callers whose truth leads the render", () => {
    // The builder's autosave sets a ref the instant a save begins; the
    // rendered value trails it by a render.
    const live = { dirty: false };
    render(<Harness unsaved={() => live.dirty} />);
    expect(fire()).toBe(false);
    live.dirty = true;
    expect(fire()).toBe(true);
  });

  it("stops warning once unmounted", () => {
    const { unmount } = render(<Harness unsaved />);
    expect(fire()).toBe(true);
    unmount();
    expect(fire()).toBe(false);
  });

  it("adds exactly one listener and removes it", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender, unmount } = render(<Harness unsaved={false} />);
    rerender(<Harness unsaved />);
    rerender(<Harness unsaved={false} />);
    const added = add.mock.calls.filter(([e]) => e === "beforeunload");
    expect(added).toHaveLength(1);
    unmount();
    expect(
      remove.mock.calls.filter(([e]) => e === "beforeunload"),
    ).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
