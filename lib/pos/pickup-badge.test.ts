// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  claimPickupBadge,
  publishPickupCount,
  usePickupBadge,
  __resetPickupBadge,
} from "./pickup-badge";

beforeEach(() => __resetPickupBadge());

describe("pickup badge store", () => {
  it("starts with nothing published and nobody owning it", () => {
    const { result } = renderHook(() => usePickupBadge());
    expect(result.current).toEqual({ count: null, owned: false });
  });

  it("publishes a count to every subscriber", () => {
    const { result } = renderHook(() => usePickupBadge());
    act(() => publishPickupCount(3));
    expect(result.current.count).toBe(3);
  });

  // ★ The nav renders on every POS screen; a store that handed back a fresh
  // object per read would re-render it forever.
  it("keeps snapshot identity when nothing changes", () => {
    const { result, rerender } = renderHook(() => usePickupBadge());
    act(() => publishPickupCount(2));
    const first = result.current;
    act(() => publishPickupCount(2));
    rerender();
    expect(result.current).toBe(first);
  });

  it("marks the badge owned while a screen is keeping it fresh", () => {
    const { result } = renderHook(() => usePickupBadge());
    let release!: () => void;
    act(() => {
      release = claimPickupBadge();
    });
    expect(result.current.owned).toBe(true);
    act(() => release());
    expect(result.current.owned).toBe(false);
  });

  // ★ Only the LAST release gives the badge back to the poller. The claim is
  // tied to a screen's poll being live, and React can mount the next one before
  // unmounting the last — a naive boolean would leave the nav polling under a
  // screen that is still publishing.
  it("stays owned until the last claim is released", () => {
    const { result } = renderHook(() => usePickupBadge());
    let a!: () => void;
    let b!: () => void;
    act(() => {
      a = claimPickupBadge();
      b = claimPickupBadge();
    });
    act(() => a());
    expect(result.current.owned).toBe(true);
    act(() => b());
    expect(result.current.owned).toBe(false);
  });

  // A release called twice (an effect cleanup running after a re-render) must
  // not drive the count negative and un-own a badge somebody else holds.
  it("ignores a release called more than once", () => {
    const { result } = renderHook(() => usePickupBadge());
    let a!: () => void;
    let b!: () => void;
    act(() => {
      a = claimPickupBadge();
    });
    act(() => {
      a();
      a();
      b = claimPickupBadge();
    });
    expect(result.current.owned).toBe(true);
    act(() => b());
    expect(result.current.owned).toBe(false);
  });

  it("keeps the published count across an ownership change", () => {
    const { result } = renderHook(() => usePickupBadge());
    let release!: () => void;
    act(() => {
      release = claimPickupBadge();
      publishPickupCount(5);
    });
    act(() => release());
    // The nav resumes polling, but until its first tick lands the last known
    // number is still the best one available.
    expect(result.current.count).toBe(5);

    // The nav poll is now another publisher into this one store. Its first
    // successful result must replace the released queue value; keeping two
    // state slots made the old shared value shadow nav results forever.
    act(() => publishPickupCount(6));
    expect(result.current.count).toBe(6);
  });
});
