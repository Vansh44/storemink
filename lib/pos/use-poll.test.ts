// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePoll, POS_POLL_MS, type PollRun } from "./use-poll";

// ---------------------------------------------------------------------------
// The register's refresh mechanism, used by four screens (the pickup badge, the
// pickup queue, the stock list and the catalog sync). What is pinned here is
// the behaviour that makes it dependable rather than merely periodic: it stops
// when the till is not being looked at, stops when the network is gone, and
// CATCHES UP the instant either comes back.
// ---------------------------------------------------------------------------

let visibility: DocumentVisibilityState = "visible";
let online = true;

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}
function setOnline(v: boolean) {
  online = v;
  window.dispatchEvent(new Event(v ? "online" : "offline"));
}

beforeEach(() => {
  vi.useFakeTimers();
  // ★ Jitter is ±15% of the interval. Pinning Math.random to 0.5 makes the
  // multiplier exactly 1, so every timing assertion below is about the RULE
  // being tested rather than about the spread. Jitter gets its own test.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePoll", () => {
  // ★ MOUNT IS NOT A CATCH-UP. The server has just rendered this screen, so
  // firing immediately would be a wasted round-trip on every navigation.
  it("does not fire on mount", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    expect(fn).not.toHaveBeenCalled();
  });

  // ⚠ `advanceTimersByTimeAsync`, not the sync form, throughout the tests that
  // span more than ONE tick. The timer re-arms after the callback settles, so
  // the next one is scheduled from a microtask — which the sync advance does not
  // flush. That is deliberate in the implementation: chaining rather than a
  // fixed-rate `setInterval` means a slow response delays the next request
  // instead of stacking one on top of it, which is what stops a till on bad wifi
  // building a queue of overlapping polls.
  it("fires on the interval", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("defaults to the shared POS interval", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn));
    await vi.advanceTimersByTimeAsync(POS_POLL_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops entirely when disabled, and resumes when re-enabled", async () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => usePoll(fn, 1000, on),
      { initialProps: { on: false } },
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).not.toHaveBeenCalled();

    rerender({ on: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ★ A till is left open all night and browsers keep background timers
  // running. Without this every closed shop spends the small hours making
  // requests nobody will read.
  describe("visibility", () => {
    it("stops while the tab is hidden", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("★ catches up the moment the tab is visible again", async () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(5000);
      setVisibility("visible");
      // Immediately, not after another full interval: someone walking back to
      // the till expects the screen to be true now.
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("never starts while mounted hidden", () => {
      visibility = "hidden";
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ★ Shop wifi drops. A bare interval keeps firing into a dead network, each
  // call failing silently — and the first attempt after it returns is up to a
  // full interval away, so the screen stays wrong long after the connection is
  // back.
  describe("network", () => {
    it("stops while offline", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setOnline(false);
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("★ catches up the moment the network returns", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setOnline(false);
      vi.advanceTimersByTime(5000);
      setOnline(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    // ★★ THESE TWO ARE WHAT `navigator.onLine` IS FOR, and they are the only
    // ones that catch its removal. "Stops while offline" above passes either
    // way, because the `offline` EVENT clears the timer directly — so without
    // these the gate could be deleted and the suite would stay green.
    it("never starts when mounted while already offline", () => {
      online = false;
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not start on becoming visible while still offline", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      online = false;
      setVisibility("hidden");
      setVisibility("visible");
      // No catch-up and no timer: the tab is being looked at, but a request
      // could only fail.
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("stays stopped if the tab is hidden when the network returns", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      setOnline(false);
      setOnline(true);
      vi.advanceTimersByTime(5000);
      // Both gates have to be open. Coming back online in a background tab is
      // not a reason to start making requests.
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ★ A flapping connection must not leave two timers running against one
  // screen — that is how a poll silently doubles its request rate.
  it("never stacks intervals", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    for (let i = 0; i < 5; i++) {
      setOnline(false);
      setOnline(true);
    }
    fn.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePoll(fn, 1000));
    unmount();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("invalidates a run already in flight when disabled", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let committed = false;
    let aborted = false;
    const fn = vi.fn(async (run: PollRun) => {
      run.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await pending;
      if (run.isCurrent()) committed = true;
    });
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePoll(fn, { ms: 1000, enabled }),
      { initialProps: { enabled: true } },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    expect(aborted).toBe(true);

    await act(async () => finish());
    expect(committed).toBe(false);
  });

  // ★ The latest callback runs WITHOUT restarting the timer. A poll that resets
  // whenever its closure changes is a poll that may never fire — and these
  // callbacks close over search text and filters, which change constantly.
  it("uses the latest callback without resetting the interval", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => usePoll(fn, 1000),
      { initialProps: { fn: first } },
    );
    await vi.advanceTimersByTimeAsync(900);
    rerender({ fn: second });
    await vi.advanceTimersByTimeAsync(100);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What was added after measuring the mechanism at scale.
// ---------------------------------------------------------------------------

describe("usePoll — catch-up throttle", () => {
  // ★★ THE BUG THIS FIXES. `visibilitychange` fires on EVERY tab switch, window
  // minimise and app switch. Unthrottled, somebody flipping between two tabs
  // kicked off a full catalogue re-sync — several requests over hundreds of
  // products — on every single flip.
  it("skips a catch-up when it already ran inside one interval", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000); // one scheduled run
    expect(fn).toHaveBeenCalledTimes(1);

    // Flip away and back four times, well inside the interval.
    for (let i = 0; i < 4; i++) {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(50);
      setVisibility("visible");
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Away for longer than an interval is the case that matters — someone coming
  // back to the till expecting the screen to be true.
  it("still catches up after a real absence", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throttles the network catch-up the same way", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    fn.mockClear();
    for (let i = 0; i < 4; i++) {
      setOnline(false);
      await vi.advanceTimersByTimeAsync(20);
      setOnline(true);
    }
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("usePoll — back-off", () => {
  // ★ A shop taking two collections a day was making ~2,880 requests to learn
  // "still nothing" 2,878 times.
  it("doubles while unchanged and resets on a change", async () => {
    const fn = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    renderHook(() => usePoll(fn, { ms: 1000, backOff: true }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1); // next in 2000

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2); // next in 4000

    fn.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(3);

    // Reported a change ⇒ straight back to the base interval.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("is capped, so a quiet till never goes silent", async () => {
    const fn = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    renderHook(() => usePoll(fn, { ms: 30_000, backOff: true }));
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(600_000);
    const calls = fn.mock.calls.length;
    // 10 × 10min at the 2-minute cap is ~50 runs; the point is that it keeps
    // running rather than stretching without bound.
    expect(calls).toBeGreaterThan(20);
  });

  // ★ An uninstrumented poll must not slow itself down on no evidence.
  it("does not back off when the callback reports nothing", async () => {
    const fn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    renderHook(() => usePoll(fn, { ms: 1000, backOff: true }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stays at the base interval when back-off is off", async () => {
    const fn = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    renderHook(() => usePoll(fn, { ms: 1000 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // A throw is not a verdict on whether anything changed.
  it("survives a callback that throws", async () => {
    const fn = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(new Error("x"));
    renderHook(() => usePoll(fn, { ms: 1000, backOff: true }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("usePoll — jitter", () => {
  // ★ A deploy restarts every till at once and a shop opens its registers
  // together; on a fixed interval they stay in step forever, turning steady
  // traffic into a spike against one database every interval.
  it("spreads the interval either side of the base", async () => {
    const delays: number[] = [];
    for (const r of [0, 0.5, 1]) {
      vi.mocked(Math.random).mockReturnValue(r);
      const fn = vi.fn();
      const { unmount } = renderHook(() => usePoll(fn, 1000));
      let waited = 0;
      while (fn.mock.calls.length === 0 && waited < 3000) {
        await vi.advanceTimersByTimeAsync(10);
        waited += 10;
      }
      delays.push(waited);
      unmount();
    }
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[2]).toBeGreaterThan(1000);
    expect(new Set(delays).size).toBe(3);
  });
});
