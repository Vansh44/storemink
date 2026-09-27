import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sanitizeReferenceImage, sniffReferenceFormat } from "./references";

async function image(
  format: "png" | "jpeg" | "webp",
  width = 64,
  height = 48,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  });
  return format === "png"
    ? base.png().toBuffer()
    : format === "jpeg"
      ? base
          .jpeg()
          .withMetadata({
            exif: { IFD0: { Copyright: "secret-gps-like-data" } },
          })
          .toBuffer()
      : base.webp().toBuffer();
}

describe("reference sanitization", () => {
  it("accepts JPEG, PNG and WebP and always stores a re-encoded WebP", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const input = await image(format);
      const result = await sanitizeReferenceImage(input);
      expect(result.ok, format).toBe(true);
      if (!result.ok) continue;
      expect(result.value.mediaType).toBe("image/webp");
      expect(sniffReferenceFormat(result.value.bytes)).toBe("image/webp");
      expect(result.value.originalMediaType).toBe(`image/${format}`);
      expect(result.value.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Buffer.compare(result.value.bytes, input)).not.toBe(0);
    }
  });

  it("strips metadata from what it stores", async () => {
    const input = await image("jpeg");
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await sanitizeReferenceImage(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((await sharp(result.value.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it("bounds the stored image to a 2048px long edge", async () => {
    const result = await sanitizeReferenceImage(await image("png", 3000, 1000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.width).toBe(2048);
      expect(result.value.height).toBeLessThanOrEqual(683);
    }
  });

  it("refuses SVG, HTML and anything without an allowed magic number", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    expect(await sanitizeReferenceImage(svg)).toEqual({
      ok: false,
      code: "unsupported_format",
    });
    expect(await sanitizeReferenceImage(html)).toEqual({
      ok: false,
      code: "unsupported_format",
    });
  });

  it("refuses a body whose header claims PNG but is not a decodable PNG", async () => {
    const forged = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not really a png at all"),
    ]);
    expect(await sanitizeReferenceImage(forged)).toEqual({
      ok: false,
      code: "decode_failed",
    });
  });

  it("refuses a WebP header on a JPEG body as a format mismatch", async () => {
    const jpeg = await image("jpeg");
    const lie = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), jpeg]);
    const result = await sanitizeReferenceImage(lie);
    expect(result.ok).toBe(false);
  });

  it("refuses animated images, including AVIF image sequences", async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame("#f00"), await frame("#0f0")], {
      join: { animated: true },
    })
      .webp({ loop: 0 })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    expect(await sanitizeReferenceImage(animated)).toEqual({
      ok: false,
      code: "animated",
    });
    const avis = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypavis"),
      Buffer.alloc(16),
    ]);
    expect(await sanitizeReferenceImage(avis)).toEqual({
      ok: false,
      code: "animated",
    });
  });

  it("refuses empty and oversized input before decoding", async () => {
    expect(await sanitizeReferenceImage(Buffer.alloc(0))).toEqual({
      ok: false,
      code: "empty",
    });
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0xff);
    expect(await sanitizeReferenceImage(big)).toEqual({
      ok: false,
      code: "too_large",
    });
  });

  it("fails closed when the image processor is unavailable", async () => {
    const result = await sanitizeReferenceImage(
      await image("png"),
      async () => null,
    );
    expect(result).toEqual({ ok: false, code: "processor_unavailable" });
  });
});
