// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useHistory,
  HISTORY_CAPACITY,
  HISTORY_COALESCE_MS,
  type HistoryEntry,
} from "./use-history";
import type { PageSectionItem } from "@/lib/sections/registry";

const entry = (n: number): HistoryEntry => ({
  sections: [{ id: `s${n}` } as PageSectionItem],
  selectedSectionId: null,
});

describe("useHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("undo returns the last recorded snapshot; redo restores what undo replaced", () => {
    const { result } = renderHook(() => useHistory());
    act(() => result.current.record(entry(1)));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    let restored: HistoryEntry | null = null;
    act(() => {
      restored = result.current.undo(entry(2)); // current state = 2
    });
    expect(restored).toEqual(entry(1));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      restored = result.current.redo(entry(1));
    });
    expect(restored).toEqual(entry(2));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("returns null when the stacks are empty", () => {
    const { result } = renderHook(() => useHistory());
    let out: HistoryEntry | null = entry(0);
    act(() => {
      out = result.current.undo(entry(1));
    });
    expect(out).toBeNull();
    act(() => {
      out = result.current.redo(entry(1));
    });
    expect(out).toBeNull();
  });

  it("coalesces same-key records within the window into one entry", () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.record(entry(1), "hero:content");
      result.current.record(entry(2), "hero:content"); // burst → skipped
      result.current.record(entry(3), "hero:content"); // burst → skipped
    });
    let restored: HistoryEntry | null = null;
    act(() => {
      restored = result.current.undo(entry(4));
    });
    // One Cmd+Z lands on the pre-burst snapshot.
    expect(restored).toEqual(entry(1));
    expect(result.current.canUndo).toBe(false);
  });

  it("does not coalesce across the time window or across keys", () => {
    const { result } = renderHook(() => useHistory());
    act(() => result.current.record(entry(1), "a:content"));
    act(() => vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1));
    act(() => result.current.record(entry(2), "a:content")); // window passed
    act(() => result.current.record(entry(3), "b:content")); // different key
    let r: HistoryEntry | null = null;
    act(() => {
      r = result.current.undo(entry(4));
    });
    expect(r).toEqual(entry(3));
    act(() => {
      r = result.current.undo(entry(3));
    });
    expect(r).toEqual(entry(2));
    act(() => {
      r = result.current.undo(entry(2));
    });
    expect(r).toEqual(entry(1));
  });

  it("a new record clears the redo branch (even a coalesced one)", () => {
    const { result } = renderHook(() => useHistory());
    act(() => result.current.record(entry(1), "a:content"));
    act(() => result.current.undo(entry(2)));
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.record(entry(3), "a:content"));
    expect(result.current.canRedo).toBe(false);
  });

  it("caps the undo stack, dropping the oldest entries", () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      for (let i = 0; i < HISTORY_CAPACITY + 10; i++)
        result.current.record(entry(i));
    });
    // Unwind everything; the oldest reachable snapshot is entry(10).
    let last: HistoryEntry | null = null;
    act(() => {
      for (let i = 0; i < HISTORY_CAPACITY; i++)
        last = result.current.undo(entry(999));
    });
    expect(last).toEqual(entry(10));
    expect(result.current.canUndo).toBe(false);
  });

  it("reset clears both stacks", () => {
    const { result } = renderHook(() => useHistory());
    act(() => {
      result.current.record(entry(1));
      result.current.undo(entry(2));
      result.current.reset();
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
