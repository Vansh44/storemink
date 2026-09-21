"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ImageUpload } from "@/components/ui/image-upload";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
  /**
   * This store's own public media prefix, e.g.
   * `https://storage.googleapis.com/<bucket>/stores/<storeId>/`.
   *
   * Server-computed, because the bucket name is a server-only env value and
   * because the store id must not be something the browser chooses. Empty when
   * GCS is not configured, which hides the paste field entirely rather than
   * offering a control that can only ever be refused.
   */
  mediaUrlPrefix?: string;
};

export function MediaPickerDialog({
  open,
  onClose,
  onSelect,
  mediaUrlPrefix = "",
}: Props) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [urlError, setUrlError] = useState("");

  function applyMediaUrl() {
    const normalized = normalizeBlogCoverMediaUrl(mediaUrl, mediaUrlPrefix);
    if (!normalized) {
      setUrlError("Paste an image URL from this store's own Media Library.");
      return;
    }
    setUrlError("");
    setMediaUrl("");
    onSelect(normalized);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Choose cover image</DialogTitle>
          <DialogDescription>
            {mediaUrlPrefix
              ? "Upload a new image or paste one of this store's existing Media Library URLs."
              : "Upload an image to use as the blog cover photo."}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <ImageUpload
            folder="blog-covers"
            onUploadSuccess={(url) => {
              if (url) {
                onSelect(url);
              }
            }}
          />

          {mediaUrlPrefix ? (
            <>
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or use an existing Media image
                <span className="h-px flex-1 bg-border" />
              </div>

              <label
                className="block text-sm font-medium"
                htmlFor="blog-cover-url"
              >
                Media Library URL
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="blog-cover-url"
                  type="url"
                  value={mediaUrl}
                  onChange={(event) => {
                    setMediaUrl(event.target.value);
                    if (urlError) setUrlError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyMediaUrl();
                    }
                  }}
                  placeholder="https://storage.googleapis.com/…"
                  className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={applyMediaUrl}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  Use image
                </button>
              </div>
              {urlError ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {urlError}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Accept only an image this store provably owns.
 *
 * ★★ THE BUCKET AND THE STORE PREFIX ARE BOTH LOAD-BEARING, and checking the
 *    HOST alone is what made this dangerous: `storage.googleapis.com` is
 *    shared by every GCS customer on earth AND by every StoreMink store, so a
 *    host-only rule accepted an arbitrary third party's object (a tracking
 *    beacon rendered on the merchant's public storefront) and, worse, another
 *    store's object - which `deleteStorageUrls` then permanently deletes the
 *    next time this blog's cover changes, because that sweep resolves any
 *    in-bucket URL to a path with no tenant predicate. Same rule, same reason,
 *    as `sanitizePhotos` (returns) and `isGeneratedImageUrl` (Mink artifacts).
 *
 * ★ THE PREFIX IS SUPPLIED, NOT DERIVED. `GCS_BUCKET` is server-only env and
 *   the store id must not come from the browser, so the caller passes the
 *   exact allowed prefix and an empty one accepts nothing.
 *
 * ⚠ THIS IS NOT THE BOUNDARY - `createBlog`, `updateBlog` and `autosaveBlog`
 *   re-check server-side, because a server action is reachable without the UI.
 */
export function normalizeBlogCoverMediaUrl(
  value: string,
  allowedPrefix: string,
): string | null {
  if (!allowedPrefix) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    const normalized = url.toString();
    // Compare the parsed form so a `..` segment or an encoded separator cannot
    // spell its way out of the prefix after the browser resolves it.
    if (!normalized.startsWith(allowedPrefix)) return null;
    if (normalized.length <= allowedPrefix.length) return null;
    return normalized;
  } catch {
    return null;
  }
}
