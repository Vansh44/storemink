import "server-only";
import sharp from "sharp";
import { spawn } from "node:child_process";
import path from "node:path";
import { MinkRequestError } from "./errors";
import {
  inputKind,
  MINK_INPUT_BYTES,
  type MinkInputKind,
} from "./input-policy";
export type ValidatedMinkInput = {
  kind: MinkInputKind;
  mimeType: string;
  bytes: Buffer;
};
const invalid = () =>
  new MinkRequestError(
    "invalid_input",
    "This file is unsupported, damaged or exceeds the limits. Use an image up to 12 megapixels, a plain PDF up to 10 pages, or mono 16 kHz PCM WAV up to 60 seconds; maximum 2 MiB.",
    400,
  );
export function parseMinkInput(body: Record<string, unknown>) {
  if (
    Object.keys(body).some(
      (k) => !["name", "data", "confirmed", "requestKey"].includes(k),
    ) ||
    body.confirmed !== true ||
    typeof body.name !== "string" ||
    body.name.length > 180 ||
    typeof body.data !== "string" ||
    typeof body.requestKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.requestKey,
    )
  )
    throw invalid();
  let kind: MinkInputKind;
  try {
    kind = inputKind(body.name);
  } catch {
    throw invalid();
  }
  if (
    !body.data.length ||
    body.data.length > Math.ceil(MINK_INPUT_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      body.data,
    )
  )
    throw invalid();
  const bytes = Buffer.from(body.data, "base64");
  if (
    !bytes.length ||
    bytes.length > MINK_INPUT_BYTES ||
    bytes.toString("base64") !== body.data
  )
    throw invalid();
  return { kind, bytes, name: body.name, requestKey: body.requestKey };
}
export async function validateMinkInput(
  input: ReturnType<typeof parseMinkInput>,
  signal: AbortSignal,
): Promise<ValidatedMinkInput> {
  const { bytes, kind } = input;
  try {
    signal.throwIfAborted();
    if (kind === "image") {
      const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp =
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
      if (!png && !jpeg && !webp) throw invalid();
      const img = sharp(bytes, {
        limitInputPixels: 12_000_000,
        failOn: "warning",
        animated: false,
      }).timeout({ seconds: 5 });
      const meta = await img.metadata();
      const expected = /\.png$/i.test(input.name)
        ? "png"
        : /\.webp$/i.test(input.name)
          ? "webp"
          : "jpeg";
      if (meta.format !== expected || (meta.pages ?? 1) !== 1) throw invalid();
      const normalized = await img
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer();
      signal.throwIfAborted();
      return { kind, mimeType: "image/jpeg", bytes: normalized };
    }
    if (kind === "pdf") {
      if (
        !bytes
          .subarray(0, 8)
          .toString("ascii")
          .match(/^%PDF-1\.[0-7]/) ||
        !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
      )
        throw invalid();
      await checkPdf(bytes, signal);
      return { kind, mimeType: "application/pdf", bytes };
    }
    // Deliberately narrow canonical PCM WAV: no metadata, codecs, hidden chunks or duration claims.
    if (
      bytes.length < 46 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
      bytes.readUInt32LE(16) !== 16 ||
      bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 ||
      bytes.readUInt32LE(24) !== 16000 ||
      bytes.readUInt32LE(28) !== 32000 ||
      bytes.readUInt16LE(32) !== 2 ||
      bytes.readUInt16LE(34) !== 16 ||
      bytes.toString("ascii", 36, 40) !== "data" ||
      bytes.readUInt32LE(40) !== bytes.length - 44 ||
      (bytes.length - 44) % 2 ||
      bytes.length - 44 > 1_920_000
    )
      throw invalid();
    return { kind, mimeType: "audio/wav", bytes };
  } catch {
    throw invalid();
  }
}
function checkPdf(bytes: Buffer, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=96",
        path.join(process.cwd(), "scripts/mink-pdf-check.cjs"),
      ],
      {
        env: { NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "ignore"],
        signal,
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 20) child.kill("SIGKILL");
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(invalid());
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /^(?:[1-9]|10)$/.test(output)) resolve();
      else reject(invalid());
    });
    child.stdin.on("error", () => {
      /* Process exit is handled above. */
    });
    child.stdin.end(bytes);
  });
}
