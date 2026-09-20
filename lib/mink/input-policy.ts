/** Shared input limits. Files are references, never action authority. */
export const MINK_INPUT_BYTES = 5 * 1024 * 1024;
/** Base64 adds roughly one third; leave bounded room for JSON metadata. */
export const MINK_INPUT_BODY_BYTES = 7_100_000;
export const MINK_INPUT_FILES = 5;
/** Five bounded readings plus their durable attachment references fit here. */
export const MINK_MESSAGE_MAX_CHARS = 12_000;
/** Matches the input API's own floor, so a derived budget is never refused. */
export const MINK_READING_MIN_CHARS = 200;
export const MINK_READING_MAX_CHARS = 2_200;
/**
 * One reading's non-text cost: the 76-character reference marker, the 43-char
 * JSON wrapper, a filename capped at 160, and the media reference an image also
 * carries (83 + 24 + a GCS URL). Rounded up, because under-counting here is
 * what pushes the LAST attachment over the cap.
 */
const READING_ENVELOPE_CHARS = 480;
/**
 * JSON-escaping slack. `addReviewedMinkDocument` stringifies the reading, so
 * every newline and quote in it costs two characters; prose runs a few percent.
 */
const ESCAPE_SLACK = 1.15;

/**
 * How many characters the next attachment's reading may occupy, or null when
 * there is no room for another one.
 *
 * ★★ DERIVED FROM THE MESSAGE AS IT REALLY STANDS, NOT A FIXED SHARE. It was
 * `floor(7500 / providerCount)` — a number unrelated to `MINK_MESSAGE_MAX_CHARS`
 * — so five readings plus five media references plus a long message could pass
 * every per-file check and still make `addReviewedMinkDocument` throw at the
 * very end, AFTER five provider calls and five Media uploads had been paid for.
 * Recomputing against the live message makes that overflow impossible: a
 * verbose early reading simply narrows what is left for the rest.
 *
 * ★ NULL IS A REFUSAL BEFORE SPENDING, not a clamp. Clamping to the floor and
 * calling the provider anyway buys a reading that cannot fit in the message
 * that is about to be assembled — the exact waste this exists to prevent.
 */
export function minkReadingBudget(
  usedCharacters: number,
  pendingReadings: number,
): number | null {
  const pending = Math.max(1, pendingReadings);
  const free =
    MINK_MESSAGE_MAX_CHARS - usedCharacters - pending * READING_ENVELOPE_CHARS;
  const share = Math.floor(free / pending / ESCAPE_SLACK);
  if (share < MINK_READING_MIN_CHARS) return null;
  return Math.min(MINK_READING_MAX_CHARS, share);
}

/**
 * Can this set of attachments still fit the message cap?
 *
 * ★ LOCAL TEXT IS EXACT AT SELECTION TIME, and that is the whole point of
 * asking here. A .txt/.md file is decoded on the device, so five 3,000-character
 * notes — a combination the Help guide explicitly offers — are KNOWN to overflow
 * before anything is staged. Left to Send, the merchant got "shorten the text"
 * about a file they cannot edit from the composer.
 * ⚠ Provider readings are reserved at their FLOOR, never their cap: their real
 * length is unknowable until the provider answers, and `minkReadingBudget`
 * shrinks them to fit at Send. Reserving the cap here would refuse ordinary
 * five-image messages that fit comfortably.
 */
export function minkAttachmentsFit(
  messageLength: number,
  localTextLengths: readonly number[],
  providerFileCount: number,
): boolean {
  const local = localTextLengths.reduce(
    (total, length) => total + Math.ceil(length * ESCAPE_SLACK),
    0,
  );
  const files = localTextLengths.length + providerFileCount;
  return (
    messageLength +
      local +
      providerFileCount * MINK_READING_MIN_CHARS +
      files * READING_ENVELOPE_CHARS <=
    MINK_MESSAGE_MAX_CHARS
  );
}
export const MINK_INPUT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.wav";
export const MINK_AUDIO_RATE = 16000;
export const MINK_AUDIO_SECONDS = 30;
export type MinkInputKind = "image" | "pdf" | "audio";
export function inputKind(name: string): MinkInputKind {
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.wav$/i.test(name)) return "audio";
  throw new Error("Choose a PNG, JPEG, WebP, PDF or mono 16 kHz PCM WAV file.");
}
export function encodeMinkWav(samples: Float32Array): ArrayBuffer {
  if (!samples.length || samples.length > MINK_AUDIO_RATE * MINK_AUDIO_SECONDS)
    throw new Error("Record between 1 sample and 30 seconds.");
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, MINK_AUDIO_RATE, true);
  view.setUint32(28, MINK_AUDIO_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) =>
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      true,
    ),
  );
  return bytes;
}
