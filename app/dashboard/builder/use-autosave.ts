"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { savePageDraft } from "@/app/actions/page-actions";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import type { PageSectionItem } from "@/lib/sections/registry";

// ---------------------------------------------------------------------------
// Builder autosave engine. Google-Docs model: the draft saves itself; Publish
// is the only explicit action.
//
//  • markDirty("content")    → debounced save (350ms after the last change)
//  • markDirty("structural") → immediate save (add/delete/reorder/toggle)
//  • flush()                 → save now; awaited by Publish
//
// Concurrency: saves run on a single promise chain (never parallel). Each save
// snapshots the LATEST sections at send time, so a queued save automatically
// carries later edits (latest-wins). The stale-tab token (updated_at) lives in
// a ref fed from each save's response — a completing save can never race a
// render. A stale-token response hard-blocks the session (another tab saved);
// any other failure keeps the draft dirty locally and retries on the next
// change or explicit retry — nothing is ever lost.
// ---------------------------------------------------------------------------

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "blocked";

const CONTENT_DEBOUNCE_MS = 350;

export function useAutosave({
  pageId,
  getSections,
  tokenRef,
  onSaved,
}: {
  pageId: string | null;
  /** Read the LATEST draft sections (from a ref, not state). */
  getSections: () => PageSectionItem[];
  /** updated_at stale-tab token — seeded on page load, refreshed per save. */
  tokenRef: React.MutableRefObject<string>;
  /** Fired when the queue drains after a successful save (preview refresh). */
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  // Event handlers (markDirty/flush/beforeunload) need the CURRENT status
  // without re-subscribing; the ref is written only alongside setStatus (in
  // handlers/effects), never during render (react-hooks/refs).
  const statusRef = useRef<SaveStatus>("saved");
  const applyStatus = useCallback((s: SaveStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));

  // Fresh page selected → clean slate. (Intentional reset-on-prop-change
  // effect — same pattern/disable as the section editor dialog.)
  useEffect(() => {
    dirtyRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyStatus("saved");
  }, [pageId, applyStatus]);

  const runSave = useCallback(async (): Promise<boolean> => {
    if (!pageId) return true;
    // Another edit may have landed while we were queued; if a later queued
    // save already wrote it, dirty is false and we can skip.
    if (!dirtyRef.current) return true;
    dirtyRef.current = false;
    applyStatus("saving");

    const result = await savePageDraft(pageId, getSections(), tokenRef.current);

    if (result.error) {
      if (result.data?.stale) {
        applyStatus("blocked");
        return false;
      }
      // Transient failure: keep the edits marked dirty so the next change (or
      // an explicit retry) re-saves them.
      dirtyRef.current = true;
      applyStatus("error");
      return false;
    }

    const nextToken = result.data?.updated_at;
    if (typeof nextToken === "string") tokenRef.current = nextToken;

    if (dirtyRef.current) {
      // New edits arrived mid-save — their own markDirty scheduled the next
      // save; show "dirty" until it lands.
      applyStatus("dirty");
    } else {
      applyStatus("saved");
      onSaved();
    }
    return true;
  }, [pageId, getSections, tokenRef, onSaved, applyStatus]);

  const enqueueSave = useCallback((): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const p = chainRef.current.then(runSave, runSave);
    chainRef.current = p;
    return p;
  }, [runSave]);

  const markDirty = useCallback(
    (kind: "content" | "structural" = "content") => {
      if (statusRef.current === "blocked") return;
      dirtyRef.current = true;
      if (statusRef.current !== "saving") applyStatus("dirty");
      if (kind === "structural") {
        void enqueueSave();
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => void enqueueSave(),
        CONTENT_DEBOUNCE_MS,
      );
    },
    [enqueueSave, applyStatus],
  );

  /** Save everything now. Publish awaits this and aborts when it fails. */
  const flush = useCallback((): Promise<boolean> => {
    if (statusRef.current === "blocked") return Promise.resolve(false);
    if (!dirtyRef.current) return chainRef.current;
    return enqueueSave();
  }, [enqueueSave]);

  /**
   * Escape hatch for the blocked state ("take over"): the caller has re-pulled
   * a FRESH stale-tab token (getPageDraft → tokenRef) and explicitly chose to
   * overwrite the other tab's version with the local sections. Re-marks dirty
   * and saves through the normal chain — with the fresh token the save is
   * valid, and the local draft wins.
   */
  const unblock = useCallback((): Promise<boolean> => {
    dirtyRef.current = true;
    applyStatus("dirty");
    return enqueueSave();
  }, [enqueueSave, applyStatus]);

  // Warn before closing the tab while edits are unsaved or failing.
  // ⚠ A GETTER, not the rendered status: applyStatus writes statusRef the
  // instant a save begins, ahead of the re-render, and narrowing this to the
  // rendered value would drop the warning for that window.
  useUnsavedChangesWarning(() =>
    ["dirty", "saving", "error"].includes(statusRef.current),
  );

  return { status, markDirty, flush, unblock };
}
