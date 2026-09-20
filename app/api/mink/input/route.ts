import { NextResponse } from "next/server";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MINK_INPUT_BODY_BYTES } from "@/lib/mink/input-policy";
import { describeDesignReading } from "@/lib/mink/design-from-image";
import { parseMinkInput, validateMinkInput } from "@/lib/mink/input-validation";
import { extractMinkDesign, extractMinkInput } from "@/lib/mink/input-provider";
import { reserveMinkInput } from "@/lib/mink/input-limits";
import { MinkRequestError } from "@/lib/mink/errors";
import { logInfo } from "@/lib/observability/logger";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
const enabled = () => getMinkConfig().enabled;
export async function GET() {
  try {
    await getMinkActorContext(crypto.randomUUID());
    return json({ enabled: enabled() });
  } catch {
    return json({ enabled: false }, 403);
  }
}
let processing = 0;
export async function POST(request: Request) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!enabled())
    return json(
      { error: "Multimodal input is not enabled for this deployment." },
      404,
    );
  if (processing >= 2)
    return json({ error: "Input processing is busy. Try again shortly." }, 429);
  processing++;
  const id = crypto.randomUUID();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  let attempted = false;
  try {
    const actor = await getMinkActorContext(id);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new MinkRequestError("invalid_input", "Use a JSON upload.", 415);
    const input = parseMinkInput(
      await readMinkBoundedJson(request, MINK_INPUT_BODY_BYTES, signal),
    );
    await reserveMinkInput(actor, input.requestKey);
    const checked = await validateMinkInput(input, signal);
    signal.throwIfAborted();
    // Recheck access after decoding, and again before returning sensitive extracted text.
    if (!enabled())
      throw new MinkRequestError(
        "input_disabled",
        "Input processing was disabled.",
        403,
      );
    await getMinkActorContext(id);
    const config = getMinkConfig();
    attempted = true;
    // ★ Same isolated reader, same limits and consent — only the SHAPE of what
    // comes back differs. Routing the design read through this endpoint is what
    // gives it the 5 MiB cap, the image validation, the replay key and the rate
    // limits for free; a second endpoint would have had to repeat all of them.
    const result =
      input.mode === "design"
        ? await extractMinkDesign(config, checked, signal)
        : await extractMinkInput(config, checked, signal, input.maxCharacters);
    // Content-free telemetry only. Never log a filename, byte buffer, transcript or provider error.
    logInfo("mink.input.completed", {
      requestId: id,
      storeId: actor.storeId,
      kind: checked.kind,
      mode: input.mode,
      model: config.model,
      inputTokens: result.usage?.promptTokenCount ?? null,
      outputTokens: result.usage?.candidatesTokenCount ?? null,
      thoughtTokens: result.usage?.thoughtsTokenCount ?? null,
      chargedCredits: 0,
    });
    signal.throwIfAborted();
    if (!enabled())
      throw new MinkRequestError(
        "input_disabled",
        "Input processing was disabled.",
        403,
      );
    await getMinkActorContext(id);
    return json(
      "reading" in result
        ? {
            // The exact values, plus the block the composer shows the merchant.
            design: result.reading,
            text: describeDesignReading(result.reading).slice(
              0,
              input.maxCharacters,
            ),
            kind: checked.kind,
            mode: "design",
          }
        : { text: result.text, kind: checked.kind, mode: "extract" },
    );
  } catch (error) {
    logInfo("mink.input.failed", {
      requestId: id,
      providerAttempted: attempted,
      usageStatus: "unavailable",
    });
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    return json(
      {
        error:
          "Input processing is unavailable, timed out, or the configured Vertex model does not support this input. Nothing was added to chat.",
      },
      503,
    );
  } finally {
    processing--;
  }
}
