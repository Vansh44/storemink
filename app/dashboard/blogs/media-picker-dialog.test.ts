import { describe, expect, it } from "vitest";
import { normalizeBlogCoverMediaUrl } from "./media-picker-dialog";

const PREFIX = "https://storage.googleapis.com/storemink-media/stores/store-1/";

describe("blog cover Media URL", () => {
  it("accepts a copied URL from this store's own prefix", () => {
    expect(
      normalizeBlogCoverMediaUrl(`  ${PREFIX}media/cover.webp  `, PREFIX),
    ).toBe(`${PREFIX}media/cover.webp`);
  });

  it("refuses non-GCS and insecure URLs", () => {
    expect(
      normalizeBlogCoverMediaUrl("https://example.com/cover.webp", PREFIX),
    ).toBeNull();
    expect(
      normalizeBlogCoverMediaUrl(
        "http://storage.googleapis.com/storemink-media/stores/store-1/c.webp",
        PREFIX,
      ),
    ).toBeNull();
  });

  // ★ The two that made this dangerous. `storage.googleapis.com` is shared by
  //   every GCS customer AND by every StoreMink store, so a host-only check
  //   accepted a third party's tracking image and another merchant's object —
  //   which the orphan sweep then deletes on the next cover change.
  it("refuses another store's object in the same bucket", () => {
    expect(
      normalizeBlogCoverMediaUrl(
        "https://storage.googleapis.com/storemink-media/stores/store-2/uploads/victim.webp",
        PREFIX,
      ),
    ).toBeNull();
  });

  it("refuses an arbitrary third-party bucket", () => {
    expect(
      normalizeBlogCoverMediaUrl(
        "https://storage.googleapis.com/attacker-bucket/tracker.png",
        PREFIX,
      ),
    ).toBeNull();
  });

  it("refuses a look-alike bucket that merely starts the same way", () => {
    expect(
      normalizeBlogCoverMediaUrl(
        "https://storage.googleapis.com/storemink-media-evil/stores/store-1/x.webp",
        PREFIX,
      ),
    ).toBeNull();
  });

  it("refuses the bare prefix, which names no object", () => {
    expect(normalizeBlogCoverMediaUrl(PREFIX, PREFIX)).toBeNull();
  });

  // Without a configured bucket there is no prefix to prove ownership against,
  // so nothing is accepted and the field is not rendered at all.
  it("accepts nothing when no prefix is configured", () => {
    expect(
      normalizeBlogCoverMediaUrl(`${PREFIX}media/cover.webp`, ""),
    ).toBeNull();
  });
});
