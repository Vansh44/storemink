/** Shared input limits. Files are references, never action authority. */
export const MINK_INPUT_BYTES = 2 * 1024 * 1024;
export const MINK_INPUT_BODY_BYTES = 2_800_000;
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
