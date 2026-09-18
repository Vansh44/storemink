"use client";

import { useEffect, useRef } from "react";

/**
 * Ask the browser to confirm before a reload or tab close discards unsaved
 * edits.
 *
 * ★★ WHY THIS EXISTS AS A HOOK. A merchant lost a GA4 Measurement ID by
 * typing it, flicking a switch and refreshing: the page held everything in
 * local state until an explicit Save, so the reload simply threw it away. The
 * browser's own prompt is the ONLY thing that can interrupt that, and before
 * this hook exactly three surfaces in the codebase had one — the builder, the
 * blog editor, and the page that was reported. Every other form with an
 * explicit Save could silently discard a merchant's typing, including the
 * policies editor, which is the one place they write whole paragraphs.
 *
 * ★ TAKES A GETTER AS WELL AS A BOOLEAN. Most callers have a `dirty` boolean
 * computed during render. The builder's autosave instead keeps its status in a
 * REF that it updates the moment a save begins — ahead of any re-render — so
 * passing the rendered value would narrow its warning by one render. A getter
 * lets it keep the stricter behaviour without a second implementation.
 *
 * ★ THE LISTENER IS REGISTERED ONCE, and reads the current value through a ref
 * rather than re-subscribing whenever `unsaved` flips. Re-registering on every
 * keystroke is churn on the exact surfaces this protects — long textareas.
 *
 * ⚠ `preventDefault()` is the whole API. Browsers ignore any custom message and
 * ignore the call entirely until the user has interacted with the page, so this
 * is a safety net rather than a guarantee: it cannot replace saving, and a
 * surface that can autosave should.
 */
export function useUnsavedChangesWarning(unsaved: boolean | (() => boolean)) {
  const unsavedRef = useRef(unsaved);

  // ⚠ Written in an effect, never during render: a render-phase ref write is a
  // lint error here (react-hooks/refs) because it makes a component's output
  // depend on something React is not tracking. No dependency array, so it runs
  // after every render and the listener below always reads the latest value.
  useEffect(() => {
    unsavedRef.current = unsaved;
  });

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      const value = unsavedRef.current;
      if (typeof value === "function" ? value() : value) {
        event.preventDefault();
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
