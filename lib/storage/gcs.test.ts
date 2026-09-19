import { describe, it, expect, vi, afterEach } from "vitest";

// gcsConfigured / GCS_BUCKET_NAME are evaluated at module load from env, so we
// re-import under a reset registry per env to test both states. (upload/sign/
// delete wrap the SDK and hit the network — not unit-tested here.)
async function loadGcs(bucket?: string) {
  vi.resetModules();
  if (bucket === undefined) vi.stubEnv("GCS_BUCKET", "");
  else vi.stubEnv("GCS_BUCKET", bucket);
  return import("./gcs");
}

describe("gcs helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  describe("with GCS_BUCKET configured", () => {
    it("reports configured and builds a public URL", async () => {
      const gcs = await loadGcs("storemink-media");
      expect(gcs.gcsConfigured).toBe(true);
      expect(gcs.GCS_BUCKET_NAME).toBe("storemink-media");
      expect(gcs.gcsPublicUrl("products/a.webp")).toBe(
        "https://storage.googleapis.com/storemink-media/products/a.webp",
      );
    });

    it("round-trips a public URL back to its in-bucket path", async () => {
      const gcs = await loadGcs("storemink-media");
      const url = gcs.gcsPublicUrl("blog/x_123.webp");
      expect(gcs.gcsPathFromUrl(url)).toBe("blog/x_123.webp");
    });

    it("returns null for a non-GCS or wrong-bucket URL", async () => {
      const gcs = await loadGcs("storemink-media");
      expect(
        gcs.gcsPathFromUrl("https://cdn.example.com/media/a.png"),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl("https://storage.googleapis.com/other-bucket/a.png"),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl(
          "https://evil.example/storage.googleapis.com/storemink-media/a.png",
        ),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl(
          "https://storage.googleapis.com/storemink-media/../other/a.png",
        ),
      ).toBeNull();
      expect(gcs.gcsPathFromUrl("")).toBeNull();
    });
  });

  describe("without GCS_BUCKET", () => {
    it("reports not configured and never matches a path", async () => {
      const gcs = await loadGcs(undefined);
      expect(gcs.gcsConfigured).toBe(false);
      expect(gcs.GCS_BUCKET_NAME).toBeNull();
      expect(
        gcs.gcsPathFromUrl("https://storage.googleapis.com/any/a.png"),
      ).toBeNull();
    });

    it("refuses an empty bulk-delete prefix before touching GCS", async () => {
      const gcs = await loadGcs(undefined);
      await expect(gcs.gcsDeletePrefix("")).resolves.toEqual({
        deleted: 0,
        failed: 0,
        error: "Refusing to delete an empty prefix.",
      });
    });
  });
});
