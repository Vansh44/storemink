import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger", () => ({
  logError,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

/**
 * sharp is mocked PER TEST with `vi.doMock`, not once at the top.
 *
 * ⚠ A hoisted `vi.mock` factory is cached, so `vi.resetModules()` does not
 * re-run it — the "missing module" case silently behaved like the working one.
 * `doMock` is not hoisted, so each test installs the behaviour it needs before
 * importing the module under test.
 */
type SharpMode = "ok" | "missing" | "throws";

async function load(mode: SharpMode = "ok") {
  vi.resetModules();
  vi.doMock("sharp", () => {
    if (mode === "missing") {
      throw new Error(
        'Could not load the "sharp" module using the linux-x64 runtime',
      );
    }
    const chain = {
      rotate: () => chain,
      resize: () => chain,
      webp: () => chain,
      toBuffer: async () => {
        if (mode === "throws") throw new Error("unsupported image");
        return Buffer.from("webp-bytes");
      },
    };
    return { default: () => chain };
  });
  return import("./process-image");
}

const file = (type: string, name = "shot.png", size = 1000) =>
  ({
    type,
    name,
    size,
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as File;

beforeEach(() => {
  vi.clearAllMocks();
  vi.doUnmock("sharp");
});

describe("processImageUpload", () => {
  it("optimizes a supported image to WebP", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(file("image/png"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.contentType).toBe("image/webp");
      expect(r.data.ext).toBe("webp");
    }
  });

  it("refuses a type it will not process", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(file("application/pdf", "a.pdf"));
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a file over the 5 MB input cap", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(
      file("image/png", "big.png", 6 * 1024 * 1024),
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/maximum is 5 mb/i);
  });

  describe("a broken install and an awkward image are different failures", () => {
    it("FAILS CLOSED when sharp itself cannot load", async () => {
      // ★★ THE PRODUCTION FAULT (2026-09-10). sharp's native libvips was
      // missing from the container, which is a MODULE-LOAD failure — so no
      // route could catch it and /api/upload answered a bare framework 500
      // with no JSON body in 6 ms.
      const { processImageUpload } = await load("missing");
      const r = await processImageUpload(file("image/png"));
      expect(r).toMatchObject({ ok: false, status: 503 });
      if (!r.ok) expect(r.error).toMatch(/image processing is unavailable/i);
      expect(logError).toHaveBeenCalledWith(
        "image processing unavailable",
        expect.anything(),
        expect.objectContaining({ type: "image/png" }),
      );
    });

    it("does NOT store the original when sharp is missing", async () => {
      // ⚠ THE REASON IT FAILS CLOSED RATHER THAN FALLING BACK. The fallback
      // below is right for one awkward file and wrong for a broken install:
      // every upload would keep its EXIF (a photo carries GPS) and skip the
      // SVG rasterisation this module exists to enforce — silently, for as
      // long as nobody noticed.
      const { processImageUpload } = await load("missing");
      const r = await processImageUpload(file("image/jpeg", "photo.jpg"));
      expect(r.ok).toBe(false);
    });

    it("stores the original when ONE image will not optimize", async () => {
      const { processImageUpload } = await load("throws");
      const r = await processImageUpload(file("image/png"));
      expect(r.ok).toBe(true);
      // Kept as it arrived, so an awkward file does not block the upload...
      if (r.ok) expect(r.data.contentType).toBe("image/png");
      // ...but loudly enough to be found in Error Reporting.
      expect(logError).toHaveBeenCalledWith(
        "image optimization failed, storing original",
        expect.anything(),
        expect.objectContaining({ type: "image/png" }),
      );
    });

    it("never stores an SVG raw, whichever way sharp failed", async () => {
      // A crafted SVG can carry <script> that runs on the storage origin.
      for (const mode of ["missing", "throws"] as const) {
        const { processImageUpload } = await load(mode);
        const r = await processImageUpload(file("image/svg+xml", "logo.svg"));
        expect(r.ok, `mode=${mode}`).toBe(false);
      }
    });
  });

  it("passes an animated GIF through without touching sharp", async () => {
    // Re-encoding would drop the animation, so these skip optimization — and
    // therefore keep working even when sharp cannot load at all.
    const { processImageUpload } = await load("missing");
    const r = await processImageUpload(file("image/gif", "loop.gif"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.contentType).toBe("image/gif");
  });

  it("loads sharp once and remembers it is unavailable", async () => {
    const { processImageUpload } = await load("missing");
    await processImageUpload(file("image/png"));
    await processImageUpload(file("image/png"));
    // Two refusals, but the failed import is not retried per upload.
    expect(logError).toHaveBeenCalledTimes(2);
  });
});
