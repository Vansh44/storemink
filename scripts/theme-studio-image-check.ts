/**
 * Exercise the Theme Studio image client end to end, with no database.
 *
 *   npm run theme-studio:image-check
 *       Offline. The fake image client: proves request building, the crop and
 *       compress step and the output files. Costs nothing.
 *
 *   npm run theme-studio:image-check -- --live --yes
 *       Live. Calls the image model on Vertex AI three times — an anchor, a
 *       product shot matched to it, and a second product shot matched to both —
 *       about $0.40 at list price. --yes is required. Needs ADC and
 *       THEME_STUDIO_GCP_PROJECT_ID (or GCP_PROJECT_ID).
 *   Add --review to use the production HIGH-effort image reviewer, and
 *   --apparel for two full-length garments. At most three draws and three
 *   reviews, under a nine-minute deadline. report.json records timings and
 *   quality findings. No private theme data or production writes.
 *   --retake-from=<prior apparel check directory> checks one tank retake with
 *   that synthetic check's anchor and passed leggings reference.
 *   --review-from=<prior apparel check directory> reviews the saved tank only,
 *   without drawing another image when a prior review timed out.
 *
 * Options: --out=<dir> (default: a new temp directory) receives each raw
 * provider image and its cropped, compressed slot WebP, so a paid run can be
 * looked at rather than only measured.
 */
import { loadEnvConfig } from "@next/env";
import type {
  ThemeImageRequest,
  ThemeStudioImageClient,
} from "../lib/theme-studio/image-provider";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const live = process.argv.includes("--live");
  const checkReview = process.argv.includes("--review");
  const apparel = process.argv.includes("--apparel");
  const retakeFrom = option("retake-from");
  const reviewFrom = option("review-from");
  if (retakeFrom && reviewFrom)
    throw new Error("Choose either --retake-from or --review-from");
  const sourceCheck = retakeFrom ?? reviewFrom;
  if (sourceCheck && (!apparel || !checkReview))
    throw new Error(
      "Saved-image checks require --apparel --review and a prior synthetic apparel check directory",
    );
  if (sourceCheck) {
    const prior = JSON.parse(
      readFileSync(join(sourceCheck, "report.json"), "utf8"),
    );
    if (
      prior.apparel !== true ||
      prior.reviewed !== true ||
      !["anchor", "product-leggings"].every((label) =>
        prior.records?.some(
          (r: {
            label: string;
            result: string;
            review?: { problems?: unknown[] };
          }) =>
            r.label === label &&
            r.result === "ok" &&
            Array.isArray(r.review?.problems) &&
            r.review.problems.length === 0,
        ),
      )
    )
      throw new Error(
        "The source check must contain a passed anchor and leggings review",
      );
  }
  if (live && !process.argv.includes("--yes")) {
    console.error(
      "A live run calls paid models. Re-run with --yes (three draws normally, one with --retake-from, no draws with --review-from).",
    );
    process.exit(2);
  }

  const { buildAnchorRequest, buildAssetRequest } =
    await import("../lib/theme-studio/image-prompt");
  const { createFakeImageClient } =
    await import("../lib/theme-studio/image-fake");
  const { createVertexImageClient } =
    await import("../lib/theme-studio/image-vertex");
  const { getThemeStudioImageConfig } =
    await import("../lib/theme-studio/image-models");
  const { estimateImageCostMicroUsd } =
    await import("../lib/theme-studio/cost");
  const { prepareSlotImage } = await import("../lib/theme-studio/slot-images");
  const { slotTargetSize, SLOT_IMAGE_LONG_EDGE } =
    await import("../lib/theme-studio/slot-images-core");
  const {
    reviewThemeImage,
    THEME_IMAGE_REVIEW_MODEL_KEY,
    THEME_IMAGE_PROBLEM_TEXT,
  } = await import("../lib/theme-studio/image-review");
  const { createVertexModelClient, getVertexConfig } =
    await import("../lib/theme-studio/gemini-vertex");
  const { resolveThemeStudioModel } =
    await import("../lib/theme-studio/models");
  const { createFakeImageReviewClient } =
    await import("../lib/theme-studio/image-fake");
  const reviewer = !checkReview
    ? null
    : live
      ? (() => {
          const config = getVertexConfig();
          if (!config) throw new Error("No Vertex review configuration");
          return createVertexModelClient(config);
        })()
      : createFakeImageReviewClient();

  let client: ThemeStudioImageClient;
  if (live) {
    const config = getThemeStudioImageConfig();
    if (!config) {
      console.error("Set THEME_STUDIO_GCP_PROJECT_ID or GCP_PROJECT_ID.");
      process.exit(2);
    }
    client = createVertexImageClient(config);
    console.log(
      `Live: ${config.providerModel} in ${config.location} (${config.projectId})`,
    );
  } else {
    client = createFakeImageClient();
    console.log("Offline: fake image client");
  }

  const out = option("out") ?? mkdtempSync(join(tmpdir(), "theme-images-"));
  mkdirSync(out, { recursive: true });

  const direction = {
    themeName: apparel ? "Studio Apparel Check" : "Hearth",
    summary: apparel
      ? "A fictional apparel store with clean, full-length garment photography."
      : "A calm homeware store for small-batch stoneware and linen, for people furnishing a slow, warm home.",
    industries: [apparel ? "fashion" : "home"],
    moodKeywords: ["warm", "quiet", "tactile", "natural light"],
    paletteDirection: "Warm oat and clay neutrals with a deep olive accent.",
    density: "airy" as const,
    shape: "soft" as const,
    palette: {
      page: "#f6f1ea",
      surface: "#ffffff",
      ink: "#2a2420",
      accent: "#5b6b3a",
    },
  };

  const signal = AbortSignal.timeout(9 * 60_000);
  let totalCost = 0;
  const started = Date.now();
  const records: Record<string, unknown>[] = [];
  let anchorForReview: string | null = null;
  let setForReview: string | null = null;
  const saveReport = () =>
    writeFileSync(
      join(out, "report.json"),
      JSON.stringify(
        {
          live,
          apparel,
          reviewed: checkReview,
          durationMs: Date.now() - started,
          estimatedCostMicroUsd: totalCost,
          records,
        },
        null,
        2,
      ),
    );

  async function generate(
    label: string,
    request: ThemeImageRequest,
    slotAspect: number,
    subject: string,
    attempt = 1,
  ) {
    const started = Date.now();
    const result = await client.generateImage(request, signal);
    const ms = Date.now() - started;
    const cost = estimateImageCostMicroUsd(result.usage);
    totalCost += cost;
    if (result.kind !== "ok") {
      console.log(`${label}: ${result.kind}`, result);
      records.push({
        label,
        result: result.kind,
        durationMs: ms,
        timing: result.timing,
      });
      saveReport();
      process.exitCode = 1;
      return null;
    }
    const ext = result.mediaType.split("/")[1];
    writeFileSync(join(out, `${label}.raw.${ext}`), result.bytes);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    const target = slotTargetSize({
      width: SLOT_IMAGE_LONG_EDGE,
      height: Math.round(SLOT_IMAGE_LONG_EDGE / slotAspect),
    });
    const prepared = target
      ? await prepareSlotImage(result.bytes, target, 500 * 1024)
      : null;
    if (prepared?.ok) {
      writeFileSync(join(out, `${label}.slot.webp`), prepared.value.bytes);
    }
    let review = null;
    let reviewMs = 0;
    if (reviewer && prepared?.ok) {
      const reviewStarted = Date.now();
      review = await reviewThemeImage(
        reviewer,
        live
          ? resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY).providerModel
          : "fake",
        {
          purpose: request.purpose,
          brief: {
            subject,
            artDirection: "Clean, repeatable product photography",
            aspectRatio: request.aspectRatio,
          },
          candidate: Buffer.from(prepared.value.bytes).toString("base64"),
          anchor: request.purpose === "anchor" ? null : anchorForReview,
          set: request.purpose === "product" ? setForReview : null,
          attempt,
        },
        signal,
      );
      reviewMs = Date.now() - reviewStarted;
      totalCost += review.estimatedCostMicroUsd;
      if (review.kind !== "reviewed" || review.problems.length)
        process.exitCode = 1;
    }
    if (!prepared?.ok) process.exitCode = 1;
    if (
      prepared?.ok &&
      (!reviewer || (review?.kind === "reviewed" && !review.problems.length))
    ) {
      const bytes = Buffer.from(prepared.value.bytes).toString("base64");
      if (request.purpose === "anchor") anchorForReview = bytes;
      else if (request.purpose === "product" && !setForReview)
        setForReview = bytes;
    }
    records.push({
      label,
      result: result.kind,
      durationMs: ms,
      timing: result.timing,
      width: prepared?.ok ? prepared.value.width : null,
      height: prepared?.ok ? prepared.value.height : null,
      bytes: prepared?.ok ? prepared.value.bytes.byteLength : null,
      reviewMs,
      review:
        review?.kind === "reviewed"
          ? { problems: review.problems, note: review.note }
          : (review?.kind ?? null),
      reviewError: review?.kind === "unavailable" ? review.code : null,
    });
    saveReport();
    console.log(
      `${label}: ${meta.width}x${meta.height} ${result.mediaType} ${result.bytes.byteLength} B in ${ms} ms` +
        ` · tokens in ${result.usage.inputTokens} out ${result.usage.outputTokens}` +
        ` · est $${(cost / 1e6).toFixed(4)}` +
        (prepared?.ok
          ? ` · slot ${prepared.value.width}x${prepared.value.height} ${prepared.value.bytes.byteLength} B`
          : ` · slot ${prepared ? prepared.code : "n/a"}`),
    );
    return result;
  }

  if (sourceCheck) {
    anchorForReview = readFileSync(
      join(sourceCheck, "anchor.slot.webp"),
    ).toString("base64");
    setForReview = readFileSync(
      join(sourceCheck, "product-leggings.slot.webp"),
    ).toString("base64");
    const subject =
      "One unbranded sleeveless studio crop tank, unfolded and laid flat";
    if (reviewFrom) {
      const review = await reviewThemeImage(
        reviewer!,
        live
          ? resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY).providerModel
          : "fake",
        {
          purpose: "product",
          brief: {
            subject,
            artDirection: "Same photographic staging as SET",
            aspectRatio: "4:5",
          },
          candidate: readFileSync(
            join(reviewFrom, "product-tank.slot.webp"),
          ).toString("base64"),
          anchor: anchorForReview,
          set: setForReview,
          attempt: 1,
        },
        signal,
      );
      totalCost += review.estimatedCostMicroUsd;
      records.push({
        label: "product-tank-review",
        result: "existing",
        reviewMs: Date.now() - started,
        review:
          review.kind === "reviewed"
            ? { problems: review.problems, note: review.note }
            : review.kind,
        reviewError: review.kind === "unavailable" ? review.code : null,
      });
      if (review.kind !== "reviewed" || review.problems.length)
        process.exitCode = 1;
      saveReport();
      console.log(`Review: ${review.kind} · files: ${out}`);
      return;
    }
    await generate(
      "product-tank-retake",
      buildAssetRequest(
        direction,
        "product",
        {
          id: "product-tank",
          purpose: "Catalogue image",
          subject,
          artDirection:
            "Soft even studio light, full garment, same photographic staging as SET",
          aspectRatio: "4:5",
        },
        [
          { role: "anchor", mediaType: "image/webp", base64: anchorForReview },
          { role: "set", mediaType: "image/webp", base64: setForReview },
        ],
        undefined,
        {
          problems: [THEME_IMAGE_PROBLEM_TEXT.staging_mismatch],
          note: "The earlier tank used a flat backdrop while the validated SET used a raised plaster surface. Match the SET's surface, borders, camera and light.",
        },
      ),
      4 / 5,
      subject,
      2,
    );
    console.log(`Files: ${out}`);
    return;
  }
  const anchor = await generate(
    "anchor",
    buildAnchorRequest(direction),
    4 / 3,
    "An unbranded product still life establishing the store's look",
  );
  if (!anchor || (checkReview && !anchorForReview)) return;
  const anchorRef = {
    role: "anchor" as const,
    mediaType: anchor.mediaType,
    base64: Buffer.from(anchor.bytes).toString("base64"),
  };
  const first = await generate(
    apparel ? "product-leggings" : "product-mug",
    buildAssetRequest(
      direction,
      "product",
      {
        id: "product-mug",
        purpose: "Catalogue image",
        subject: apparel
          ? "One unbranded full-length pair of high-rise active leggings, unfolded and laid flat"
          : "A speckled oat stoneware mug with a thumb rest",
        artDirection: apparel
          ? "Soft even studio light, a plain matte oat background, the full garment unfolded"
          : "Matte glaze, soft morning light",
        aspectRatio: "4:5",
      },
      [anchorRef],
    ),
    4 / 5,
    apparel
      ? "One full-length pair of high-rise active leggings"
      : "A speckled oat stoneware mug with a thumb rest",
  );
  if (first) {
    await generate(
      apparel ? "product-tank" : "product-bowl",
      buildAssetRequest(
        direction,
        "product",
        {
          id: "product-bowl",
          purpose: "Catalogue image",
          subject: apparel
            ? "One unbranded sleeveless studio crop tank, unfolded and laid flat"
            : "A wide shallow serving bowl in olive-glazed stoneware",
          artDirection: apparel
            ? "Soft even studio light, a plain matte oat background, the full garment unfolded"
            : "Matte glaze, soft morning light",
          aspectRatio: "4:5",
        },
        [
          anchorRef,
          ...(checkReview && !setForReview
            ? []
            : [
                {
                  role: "set" as const,
                  mediaType: first.mediaType,
                  base64: Buffer.from(first.bytes).toString("base64"),
                },
              ]),
        ],
      ),
      4 / 5,
      apparel
        ? "One sleeveless studio crop tank"
        : "A wide shallow serving bowl in olive-glazed stoneware",
    );
  }
  console.log(`Estimated total: $${(totalCost / 1e6).toFixed(4)}`);
  console.log(`Files: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
