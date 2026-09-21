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
};

export function MediaPickerDialog({ open, onClose, onSelect }: Props) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [urlError, setUrlError] = useState("");

  function applyMediaUrl() {
    const normalized = normalizeBlogCoverMediaUrl(mediaUrl);
    if (!normalized) {
      setUrlError("Paste a valid StoreMink Media Library URL.");
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
            Upload a new image or paste an existing Media Library URL.
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

          <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or use an existing Media image
            <span className="h-px flex-1 bg-border" />
          </div>

          <label className="block text-sm font-medium" htmlFor="blog-cover-url">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function normalizeBlogCoverMediaUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "storage.googleapis.com" ||
      url.pathname.split("/").filter(Boolean).length < 2
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
