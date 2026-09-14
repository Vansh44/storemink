// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { RealtimeRefresher } from "./realtime-refresher";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// RealtimeRefresher polls (+ refreshes on tab focus) to keep a dashboard list
// fresh — the Cloud SQL replacement for Supabase Realtime (Phase 5).
describe("RealtimeRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    setVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls router.refresh() on the interval while visible", () => {
    render(<RealtimeRefresher tables={["orders"]} intervalMs={1000} />);
    expect(refresh).not.toHaveBeenCalled(); // no refresh on mount (page is fresh)

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops polling while the tab is hidden and resumes (with an immediate refresh) on return", () => {
    render(<RealtimeRefresher tables={["orders"]} intervalMs={1000} />);

    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled(); // hidden → no polling

    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1); // immediate catch-up on focus
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2); // polling resumed
  });

  it("stops polling after unmount", () => {
    const { unmount } = render(
      <RealtimeRefresher tables={["orders"]} intervalMs={1000} />,
    );
    unmount();
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
