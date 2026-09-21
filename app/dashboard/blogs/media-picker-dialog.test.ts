import { describe, expect, it } from "vitest";
import { normalizeBlogCoverMediaUrl } from "./media-picker-dialog";

describe("blog cover Media URL", () => {
  it("accepts a copied StoreMink GCS image URL", () => {
    expect(
      normalizeBlogCoverMediaUrl(
        "  https://storage.googleapis.com/storemink-media/stores/store-1/media/cover.webp  ",
      ),
    ).toBe(
      "https://storage.googleapis.com/storemink-media/stores/store-1/media/cover.webp",
    );
  });

  it("refuses non-GCS and insecure URLs", () => {
    expect(
      normalizeBlogCoverMediaUrl("https://example.com/cover.webp"),
    ).toBeNull();
    expect(
      normalizeBlogCoverMediaUrl(
        "http://storage.googleapis.com/storemink-media/cover.webp",
      ),
    ).toBeNull();
  });
});
