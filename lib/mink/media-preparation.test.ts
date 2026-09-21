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
});
