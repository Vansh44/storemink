// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRef } from "react";

vi.mock("@/app/actions/page-actions", () => ({ savePageDraft: vi.fn() }));

import { savePageDraft } from "@/app/actions/page-actions";
import { useAutosave } from "./use-autosave";

function setup(sections: any[] = [{ id: "a" }]) {
  const onSaved = vi.fn();
  const state = { sections };
  const hook = renderHook(() => {
    const tokenRef = useRef("t0");
    const auto = useAutosave({
      pageId: "p1",
      getSections: () => state.sections as any,
      tokenRef,
      onSaved,
    });
    return { ...auto, tokenRef };
  });
  return { hook, onSaved, state };
}

describe("useAutosave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(savePageDraft).mockResolvedValue({
      success: true,
      data: { updated_at: "t1" },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces content edits into one save and refreshes the token", async () => {
    vi.useFakeTimers();
    const { hook, onSaved } = setup();

    act(() => {
      hook.result.current.markDirty("content");
      hook.result.current.markDirty("content");
      hook.result.current.markDirty("content");
    });
    expect(savePageDraft).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("dirty");

    await act(async () => {
      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();
    });

    expect(savePageDraft).toHaveBeenCalledTimes(1);
    expect(savePageDraft).toHaveBeenCalledWith("p1", [{ id: "a" }], "t0");
    expect(hook.result.current.status).toBe("saved");
    expect(hook.result.current.tokenRef.current).toBe("t1");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("saves structural changes immediately (no debounce)", async () => {
    const { hook } = setup();
    await act(async () => {
      hook.result.current.markDirty("structural");
    });
    await waitFor(() => expect(savePageDraft).toHaveBeenCalledTimes(1));
  });

  it("serialises overlapping saves and sends the LATEST sections", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(savePageDraft)
      .mockImplementationOnce(async () => {
        await gate; // hold the first save in flight
        return { success: true, data: { updated_at: "t1" } };
      })
      .mockResolvedValueOnce({ success: true, data: { updated_at: "t2" } });

    const { hook, state } = setup([{ id: "v1" }]);

    await act(async () => {
      hook.result.current.markDirty("structural"); // save #1 (in flight)
    });
    state.sections = [{ id: "v2" }]; // edit lands mid-save
    await act(async () => {
      hook.result.current.markDirty("structural"); // queues save #2
      release();
    });

    await waitFor(() => expect(savePageDraft).toHaveBeenCalledTimes(2));
    // Second save snapshots the latest sections and the refreshed token.
    expect(vi.mocked(savePageDraft).mock.calls[1]).toEqual([
      "p1",
      [{ id: "v2" }],
      "t1",
    ]);
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  });

  it("hard-blocks on a stale-token response and ignores further edits", async () => {
    vi.mocked(savePageDraft).mockResolvedValue({
      error: "changed somewhere else",
      data: { stale: true },
    });
    const { hook } = setup();
    await act(async () => {
      hook.result.current.markDirty("structural");
    });
    await waitFor(() => expect(hook.result.current.status).toBe("blocked"));

    await act(async () => {
      hook.result.current.markDirty("structural");
    });
    expect(savePageDraft).toHaveBeenCalledTimes(1); // no further saves
    expect(await hook.result.current.flush()).toBe(false);
  });

  it("keeps edits dirty on transient errors and retries via flush", async () => {
    vi.mocked(savePageDraft)
      .mockResolvedValueOnce({ error: "network down" })
      .mockResolvedValueOnce({ success: true, data: { updated_at: "t1" } });
    const { hook } = setup();

    await act(async () => {
      hook.result.current.markDirty("structural");
    });
    await waitFor(() => expect(hook.result.current.status).toBe("error"));

    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await hook.result.current.flush();
    });
    expect(flushed).toBe(true);
    expect(savePageDraft).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  });

  it("flush with nothing dirty resolves without saving", async () => {
    const { hook } = setup();
    expect(await hook.result.current.flush()).toBe(true);
    expect(savePageDraft).not.toHaveBeenCalled();
  });

  it("unblock re-saves the local sections after a take-over (fresh token)", async () => {
    vi.mocked(savePageDraft)
      .mockResolvedValueOnce({
        error: "changed somewhere else",
        data: { stale: true },
      })
      .mockResolvedValueOnce({ success: true, data: { updated_at: "t9" } });
    const { hook } = setup();

    await act(async () => {
      hook.result.current.markDirty("structural");
    });
    await waitFor(() => expect(hook.result.current.status).toBe("blocked"));

    // The caller re-pulled a fresh token (getPageDraft) and chose to overwrite.
    hook.result.current.tokenRef.current = "t-fresh";
    let ok: boolean | undefined;
    await act(async () => {
      ok = await hook.result.current.unblock();
    });
    expect(ok).toBe(true);
    // Saved the LOCAL sections with the fresh token; token refreshed again.
    expect(vi.mocked(savePageDraft).mock.calls[1]).toEqual([
      "p1",
      [{ id: "a" }],
      "t-fresh",
    ]);
    expect(hook.result.current.tokenRef.current).toBe("t9");
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
  });
});
