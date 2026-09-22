import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderMinkImageForDestination } from "./media-preparation";

async function solid(width: number, height: number) {
  return new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 180, g: 40, b: 30 },
      },
    })
      .png()
      .toBuffer(),
  );
}

describe("destination-safe Mink image preparation", () => {
  it("places a portrait product photo on an exact square canvas", async () => {
    const prepared = await renderMinkImageForDestination(
      await solid(500, 900),
      "product_photo",
    );
    expect(prepared).not.toBeNull();
    const metadata = await sharp(prepared!).metadata();
    expect(metadata).toMatchObject({ width: 1_200, height: 1_200 });

    // The white side padding proves `contain`, not a centre crop that would
    // remove the top and bottom of the merchant's authentic photograph.
    const leftPixel = await sharp(prepared!)
      .extract({ left: 0, top: 600, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([...leftPixel.slice(0, 3)]).toEqual([255, 255, 255]);
  });

  it("turns a portrait attachment into an exact 16:9 blog cover", async () => {
    const prepared = await renderMinkImageForDestination(
      await solid(600, 1_000),
      "blog_cover",
    );
    expect(prepared).not.toBeNull();
    const metadata = await sharp(prepared!).metadata();
    expect(metadata).toMatchObject({ width: 1_600, height: 900 });
  });

  it("keeps an already-correct source URL instead of creating a duplicate", async () => {
    await expect(
      renderMinkImageForDestination(await solid(1_600, 900), "blog_cover"),
    ).resolves.toBeNull();
    await expect(
      renderMinkImageForDestination(await solid(900, 900), "product_photo"),
    ).resolves.toBeNull();
  });

  // ★★ THE TEST IS "WHAT WOULD BE LOST", NOT "IS THE RATIO EXACT". CODEBASE
  //    records the image model rounding a requested 21:9 to 3168x1344 — the
  //    request is honoured, the arithmetic is not — so an exact test would
  //    push a freshly generated cover, the DEFAULT path, through the blurred
  //    letterbox and downscale it from 2K.
  it("leaves a generated cover alone when its ratio is merely close", async () => {
    // 1.800 against 16:9 = 1.7778: a 1.2% crop nobody can see.
    await expect(
      renderMinkImageForDestination(await solid(2_016, 1_120), "blog_cover"),
    ).resolves.toBeNull();
  });

  it("still prepares a source the destination would crop through", async () => {
    // A 21:9 banner used as a 16:9 cover loses a quarter of its width.
    await expect(
      renderMinkImageForDestination(await solid(3_168, 1_344), "blog_cover"),
    ).resolves.not.toBeNull();
    // A portrait photo on a square card loses a third of its height.
    await expect(
      renderMinkImageForDestination(await solid(1_000, 1_500), "product_photo"),
    ).resolves.not.toBeNull();
  });

  // ★ A small authentic photo is CENTRED at native size, not interpolated up
  //   to three times its size and handed back softer than it arrived.
  it("pads a small photo onto the canvas without enlarging it", async () => {
    const prepared = await renderMinkImageForDestination(
      await solid(300, 500),
      "product_photo",
    );
    expect(prepared).not.toBeNull();
    const metadata = await sharp(prepared!).metadata();
    // The canvas is still the full destination size...
    expect(metadata).toMatchObject({ width: 1_200, height: 1_200 });
    // ...and the photo did not grow to fill it. A 300x500 source enlarged to
    // `contain` spans x 240-960, while at native size it spans x 450-750 — so
    // x=300 is the pixel that tells the two apart, and it must be canvas.
    const band = await sharp(prepared!)
      .extract({ left: 300, top: 600, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([...band.slice(0, 3)]).toEqual([255, 255, 255]);
  });
});
