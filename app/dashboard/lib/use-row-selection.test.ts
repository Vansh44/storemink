// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRowSelection } from "./use-row-selection";

const IDS = ["a", "b", "c"];

describe("useRowSelection", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useRowSelection(IDS));
    expect(result.current.count).toBe(0);
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);
    expect(result.current.selectedIds).toEqual([]);
  });

  it("toggles a single row on and off", () => {
    const { result } = renderHook(() => useRowSelection(IDS));
    act(() => result.current.toggle("a"));
    expect(result.current.isSelected("a")).toBe(true);
    expect(result.current.count).toBe(1);
    expect(result.current.someSelected).toBe(true);

    act(() => result.current.toggle("a"));
    expect(result.current.isSelected("a")).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it("toggleAll selects every visible row, then clears them", () => {
    const { result } = renderHook(() => useRowSelection(IDS));
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(3);
    expect(result.current.allSelected).toBe(true);
    expect(result.current.someSelected).toBe(false);

    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });

  it("reports an indeterminate (some) state for a partial selection", () => {
    const { result } = renderHook(() => useRowSelection(IDS));
    act(() => result.current.toggle("b"));
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(true);
  });

  it("clear() empties the selection", () => {
    const { result } = renderHook(() => useRowSelection(IDS));
    act(() => result.current.toggleAll());
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
    expect(result.current.selectedIds).toEqual([]);
  });
});
