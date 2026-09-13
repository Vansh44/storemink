import { NextResponse } from "next/server";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedBytes } from "@/lib/mink/bounded-json";
import { validateMinkInput } from "@/lib/mink/input-validation";
import { reserveMinkInput } from "@/lib/mink/input-limits";
import { MinkRequestError } from "@/lib/mink/errors";
import { getMinkVoiceProvider } from "@/lib/mink/voice-settings";
import { transcribeMinkVoice } from "@/lib/mink/voice-transcription";
import { MINK_AUDIO_RATE, MINK_AUDIO_SECONDS } from "@/lib/mink/input-policy";
import type { MinkVoiceProvider } from "@/lib/mink/voice-provider";
import { logInfo } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAV_BYTES = 44 + MINK_AUDIO_RATE * MINK_AUDIO_SECONDS * 2;
const REQUEST_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });

let processing = 0;

export async function POST(request: Request) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return json({ error: "Voice dictation is not enabled." }, 404);
  if (processing >= 2)
    return json(
      { error: "Voice transcription is busy. Try again shortly." },
      429,
    );

  processing++;
  const requestId = crypto.randomUUID();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  let provider: MinkVoiceProvider | null = null;
  try {
    const actor = await getMinkActorContext(requestId);
    if (request.headers.get("content-type") !== "audio/wav")
      throw new MinkRequestError(
        "invalid_voice",
        "Use microphone-recorded WAV audio.",
        415,
      );
    const requestKey = request.headers.get("x-mink-request-key") ?? "";
    if (!REQUEST_KEY.test(requestKey))
      throw new MinkRequestError(
        "invalid_voice",
        "Invalid voice request.",
        400,
      );
    await reserveMinkInput(actor, requestKey);
    const bytes = await readMinkBoundedBytes(request, MAX_WAV_BYTES, signal);
    const checked = await validateMinkInput(
      { kind: "audio", bytes, name: "voice-note.wav", requestKey },
      signal,
    );
    if (checked.bytes.length > MAX_WAV_BYTES)
      throw new MinkRequestError(
        "invalid_voice",
        "Voice recording is too long.",
        400,
      );
    await getMinkActorContext(requestId);
    provider = await getMinkVoiceProvider();
    const result = await transcribeMinkVoice(provider, checked.bytes, signal);
    signal.throwIfAborted();
    await getMinkActorContext(requestId);
    if (!result.text || result.text.length > 4_000)
      throw new MinkRequestError(
        "invalid_voice",
        "Voice transcript is invalid.",
        400,
      );
    logInfo("mink.voice.completed", {
      requestId,
      storeId: actor.storeId,
      provider,
    });
    return json(result);
  } catch (error) {
    logInfo("mink.voice.failed", { requestId, provider });
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    return json(
      {
        error:
          "Voice transcription is unavailable or timed out. Nothing was added to your message.",
      },
      503,
    );
  } finally {
    processing--;
  }
}
