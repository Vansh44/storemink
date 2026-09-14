import { describe, expect, it } from "vitest";
import { readStoredGeneratedImage } from "./media-generation-contract";

const STORE = "a0000000-0000-4000-8000-000000000001";
const BASE = {
  url: `https://storage.googleapis.com/sm-media/stores/${STORE}/mink-generated/img.jpg`,
  storage_path: `stores/${STORE}/mink-generated/img.jpg`,
  filename: "hero-1.jpg",
  content_type: "image/jpeg",
  size_bytes: "140322",
  purpose: "hero",
  prompt: "A warm overhead still life of loose grains on linen.",
  alt: "Grains and pulses arranged on a linen cloth",
};

describe("reading one stored generated image", () => {
  it("accepts a complete row belonging to this store", () => {
    const image = readStoredGeneratedImage(STORE, BASE);
    expect(image.url).toBe(BASE.url);
    expect(image.path).toBe(BASE.storage_path);
    expect(image.sizeBytes).toBe(140_322);
  });

  it("★★ REFUSES A PATH BELONGING TO ANOTHER STORE", () => {
    // The save writes `media_assets.url` verbatim and 9D's ownership guard
    // treats that column as proof the image belongs to the store — so a draft
    // naming a neighbour's object is exactly what must not reach it.
    const other = "b0000000-0000-4000-8000-000000000002";
    expect(() =>
      readStoredGeneratedImage(STORE, {
        ...BASE,
        url: `https://storage.googleapis.com/sm-media/stores/${other}/mink-generated/img.jpg`,
        storage_path: `stores/${other}/mink-generated/img.jpg`,
      }),
    ).toThrow(/no longer refers to a file in this store/);
  });

  it("★ REFUSES A PATH OUTSIDE THE GENERATED FOLDER", () => {
    // `stores/<id>/media/` is the merchant's OWN uploads. A generated-image
    // draft pointing there could re-file somebody's existing asset under a new
    // library row with an AI provenance note it never had.
    expect(() =>
      readStoredGeneratedImage(STORE, {
        ...BASE,
        url: `https://storage.googleapis.com/sm-media/stores/${STORE}/media/img.jpg`,
        storage_path: `stores/${STORE}/media/img.jpg`,
      }),
    ).toThrow(/no longer refers to a file in this store/);
  });

  it("★★ REFUSES A URL THAT DOES NOT END IN ITS OWN PATH", () => {
    // The two fields are written together and checked against each other, so a
    // row whose url points somewhere the path does not describe is tampering,
    // not drift. The path alone passing is what makes this worth asserting.
    expect(() =>
      readStoredGeneratedImage(STORE, {
        ...BASE,
        url: "https://attacker.example/pixel.jpg",
      }),
    ).toThrow(/storage integrity check/);
  });

  it("refuses a traversal in the stored path", () => {
    expect(() =>
      readStoredGeneratedImage(STORE, {
        ...BASE,
        url: `https://storage.googleapis.com/sm-media/stores/${STORE}/mink-generated/../media/img.jpg`,
        storage_path: `stores/${STORE}/mink-generated/../media/img.jpg`,
      }),
    ).toThrow(/no longer refers to a file in this store/);
  });

  it("refuses a purpose with no placement behind it", () => {
    expect(() =>
      readStoredGeneratedImage(STORE, { ...BASE, purpose: "product_photo" }),
    ).toThrow(/no usable placement/);
  });

  it("★ NEVER TRUSTS A CONTENT TYPE IT DOES NOT SERVE", () => {
    // The stored value becomes `media_assets.content_type`. An SVG there would
    // be an active document served from the store's own bucket.
    const image = readStoredGeneratedImage(STORE, {
      ...BASE,
      content_type: "image/svg+xml",
    });
    expect(image.contentType).toBe("image/jpeg");
  });
});
