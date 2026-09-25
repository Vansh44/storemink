import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { withService } from "@/lib/db/client";
import { prepareSlotImage, replaceThemeStudioSlotImages } from "./slot-images";
import { ThemeStudioError } from "./repository";

const LANDSCAPE = { width: 1600, height: 1200, aspect: 4 / 3 };

function solid(width: number, height: number, format: "jpeg" | "png" = "jpeg") {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 60 },
    },
  });
  return (format === "png" ? image.png() : image.jpeg()).toBuffer();
}

/** Random noise barely compresses, which exercises the size ceiling. */
function noise(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 2654435761) % 251;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe("preparing a slot image", () => {
  it("crops a wide photo to the slot's shape and re-encodes it as WebP", async () => {
    const prepared = await prepareSlotImage(
      await solid(3000, 1200),
      LANDSCAPE,
      500 * 1024,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.mediaType).toBe("image/webp");
    expect(prepared.value.width).toBe(1600);
    expect(prepared.value.height).toBe(1200);
    const meta = await sharp(prepared.value.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(prepared.value.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a smaller-but-sufficient crop at its own size rather than upscaling", async () => {
    const prepared = await prepareSlotImage(
      await solid(1000, 750, "png"),
      LANDSCAPE,
      500 * 1024,
    );
    expect(
      prepared.ok && [prepared.value.width, prepared.value.height],
    ).toEqual([1000, 750]);
  });

  it("refuses an image too small for the slot once cropped", async () => {
    const prepared = await prepareSlotImage(
      await solid(1000, 400),
      LANDSCAPE,
      500 * 1024,
    );
    expect(prepared).toEqual({ ok: false, code: "too_small" });
  });

  it("fits a tall mobile screenshot slot without dropping below 800px wide", async () => {
    const target = { width: 800, height: 1689, aspect: 9 / 19 };
    const prepared = await prepareSlotImage(
      await solid(1170, 2532),
      target,
      500 * 1024,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.width).toBe(800);
    expect(prepared.value.width / prepared.value.height).toBeCloseTo(9 / 19, 2);
  });

  it("compresses a detailed image under the catalog card's 250 KB", async () => {
    const prepared = await prepareSlotImage(
      await noise(1600, 1200),
      LANDSCAPE,
      250 * 1024,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.bytes.byteLength).toBeLessThanOrEqual(250 * 1024);
    expect(prepared.value.width).toBeGreaterThanOrEqual(800);
  });

  it("gives up with a reason when nothing fits the limit", async () => {
    const prepared = await prepareSlotImage(
      await noise(1600, 1200),
      LANDSCAPE,
      2 * 1024,
    );
    expect(prepared).toEqual({ ok: false, code: "too_detailed" });
  });

  it("refuses a non-image the same way a reference is refused", async () => {
    const prepared = await prepareSlotImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      LANDSCAPE,
      500 * 1024,
    );
    expect(prepared).toEqual({ ok: false, code: "unsupported_format" });
  });
});

describe("saving replacements", () => {
  it("refuses malformed input before touching the database", async () => {
    await expect(
      replaceThemeStudioSlotImages(
        { id: "00000000-0000-4000-8000-000000000001", email: "a@b.c" },
        {
          projectId: "00000000-0000-4000-8000-0000000000aa",
          versionId: "00000000-0000-4000-8000-0000000000bb",
          expectedRevision: 1,
          expectedPackageDigest: "x",
          replacements: [],
        },
      ),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    await expect(
      replaceThemeStudioSlotImages(
        { id: "00000000-0000-4000-8000-000000000001", email: "a@b.c" },
        {
          projectId: "nope",
          versionId: "00000000-0000-4000-8000-0000000000bb",
          expectedRevision: 1,
          expectedPackageDigest: "x",
          replacements: [{}],
        },
      ),
    ).rejects.toThrow(/no longer exists/);
    expect(withService).not.toHaveBeenCalled();
  });
});
