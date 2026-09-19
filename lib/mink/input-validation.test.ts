// @vitest-environment node
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { parseMinkInput, validateMinkInput } from "./input-validation";
import { encodeMinkWav } from "./input-policy";
const key = "11111111-1111-4111-8111-111111111111";
const body = (name: string, bytes: Uint8Array) => ({
  name,
  data: Buffer.from(bytes).toString("base64"),
  confirmed: true,
  requestKey: key,
});
const validate = (name: string, bytes: Uint8Array) =>
  validateMinkInput(
    parseMinkInput(body(name, bytes)),
    new AbortController().signal,
  );
describe("bounded multimodal decoding", () => {
  it("requires explicit consent and rejects authority-bearing fields, URLs and noncanonical base64", () => {
    for (const extra of [
      { confirmed: false },
      { confirmed: "true" },
      { storeId: "other" },
      { data: "https://evil" },
      { data: "YQ=" },
      { data: "YR==" },
      { requestKey: "../foo" },
    ])
      expect(() =>
        parseMinkInput({ ...body("x.png", new Uint8Array([1])), ...extra }),
      ).toThrow();
    expect(() => parseMinkInput(body("x.svg", new Uint8Array([1])))).toThrow();
    expect(() =>
      parseMinkInput(body("x.png", new Uint8Array(2 * 1024 * 1024 + 1))),
    ).toThrow();
  });
  it("decodes and resizes images without EXIF, rejecting disguised or corrupt formats", async () => {
    const png = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const result = await validate("echos.png", png);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    await expect(validate("echos.jpg", png)).rejects.toThrow();
    await expect(validate("fake.png", Buffer.from("<svg/>"))).rejects.toThrow();
    await expect(validate("bad.png", png.subarray(0, 50))).rejects.toThrow();
  });
  it("rejects pixel bombs", async () => {
    const big = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(validate("big.png", big)).rejects.toThrow();
  });
  it("validates actual PCM duration/rate/length rather than trusting MIME or metadata", async () => {
    const wav = Buffer.from(encodeMinkWav(new Float32Array(16000)));
    expect((await validate("voice.wav", wav)).mimeType).toBe("audio/wav");
    for (const offset of [4, 16, 20, 22, 24, 28, 32, 34, 40]) {
      const invalid = Buffer.from(wav);
      invalid[offset] ^= 1;
      await expect(validate("voice.wav", invalid)).rejects.toThrow();
    }
    await expect(
      validate("voice.wav", Buffer.concat([wav, Buffer.from("hidden")])),
    ).rejects.toThrow();
    expect(() => encodeMinkWav(new Float32Array(960001))).toThrow();
    expect(() => encodeMinkWav(new Float32Array())).toThrow();
  });
  it("parses PDFs in an isolated process and rejects damaged, excessive-page and active files", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await validate("notes.pdf", await doc.save())).kind).toBe("pdf");
    await expect(
      validate("bad.pdf", Buffer.from("%PDF-1.7\ngarbage\n%%EOF")),
    ).rejects.toThrow();
    for (let i = 0; i < 10; i++) doc.addPage();
    await expect(validate("long.pdf", await doc.save())).rejects.toThrow();
    const active = await PDFDocument.create();
    active.addPage();
    active.catalog.set(PDFName.of("OpenAction"), PDFString.of("evil"));
    await expect(validate("active.pdf", await active.save())).rejects.toThrow();
  }, 15000);
  it("cancels before parsing or sending bytes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      validateMinkInput(
        parseMinkInput(body("x.pdf", Buffer.from("%PDF-1.7\n%%EOF"))),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
  it("rejects compressed PDF object-stream expansion beyond the pinned decoder budget", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.register(
      doc.context.flateStream(" ".repeat(9 * 1024 * 1024), {
        Type: "ObjStm",
        N: 1,
        First: 0,
      }),
    );
    const bytes = await doc.save({ useObjectStreams: false });
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    await expect(validate("compressed.pdf", bytes)).rejects.toThrow();
  }, 10000);
});

// ---------------------------------------------------------------------------
// ★ `mode` chooses WHAT is read from an attachment, not whether it is sent.
// The default has to stay "extract", or an older client that knows nothing
// about the field silently starts getting a different kind of answer.
// ---------------------------------------------------------------------------
describe("input mode", () => {
  const png = () =>
    sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 200, g: 190, b: 170 },
      },
    })
      .png()
      .toBuffer();

  it("defaults to extraction when no mode is sent", async () => {
    const parsed = parseMinkInput(body("shot.png", await png()));
    expect(parsed.mode).toBe("extract");
  });

  it("accepts a design read of an image", async () => {
    const parsed = parseMinkInput({
      ...body("shot.png", await png()),
      mode: "design",
    });
    expect(parsed.mode).toBe("design");
  });

  // ★ Refused, never coerced: the two modes return different shapes, and a
  // caller that asked for one must not quietly receive the other.
  it("refuses an unrecognised mode rather than falling back", async () => {
    for (const mode of ["", "DESIGN", "extract ", 1, null, true, ["design"]]) {
      expect(() =>
        parseMinkInput({ ...body("shot.png", "" as never), mode }),
      ).toThrow();
    }
    const bytes = await png();
    for (const mode of ["", "DESIGN", 1, null, true]) {
      expect(() =>
        parseMinkInput({ ...body("shot.png", bytes), mode }),
      ).toThrow();
    }
  });

  // Only an image has a design to read; a PDF or a recording does not.
  // ⚠ Uses a real PDF, not a .txt — `inputKind` refuses .txt outright, so that
  // version of this test passed without the guard even existing.
  it("★ refuses a design read of anything that is not an image", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const pdf = Buffer.from(await doc.save());
    // The same file is fine for ordinary extraction...
    expect(parseMinkInput(body("notes.pdf", pdf)).kind).toBe("pdf");
    // ...and refused for a design read.
    expect(() =>
      parseMinkInput({ ...body("notes.pdf", pdf), mode: "design" }),
    ).toThrow();
  });
});
