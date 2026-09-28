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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  if (live && !process.argv.includes("--yes")) {
    console.error(
      "A live run calls a paid image model three times (about $0.40). Re-run with --yes.",
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
    themeName: "Hearth",
    summary:
      "A calm homeware store for small-batch stoneware and linen, for people furnishing a slow, warm home.",
    industries: ["home"],
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

  const signal = new AbortController().signal;
  let totalCost = 0;

  async function generate(
    label: string,
    request: ThemeImageRequest,
    slotAspect: number,
  ) {
    const started = Date.now();
    const result = await client.generateImage(request, signal);
    const ms = Date.now() - started;
    if (result.kind !== "ok") {
      console.log(`${label}: ${result.kind}`, result);
      return null;
    }
    const cost = estimateImageCostMicroUsd(result.usage);
    totalCost += cost;
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

  const anchor = await generate("anchor", buildAnchorRequest(direction), 4 / 3);
  if (!anchor) process.exit(1);
  const anchorRef = {
    role: "anchor" as const,
    mediaType: anchor.mediaType,
    base64: Buffer.from(anchor.bytes).toString("base64"),
  };
  const first = await generate(
    "product-mug",
    buildAssetRequest(
      direction,
      "product",
      {
        id: "product-mug",
        purpose: "Catalogue image",
        subject: "A speckled oat stoneware mug with a thumb rest",
        artDirection: "Matte glaze, soft morning light",
        aspectRatio: "4:5",
      },
      [anchorRef],
    ),
    4 / 5,
  );
  if (first) {
    await generate(
      "product-bowl",
      buildAssetRequest(
        direction,
        "product",
        {
          id: "product-bowl",
          purpose: "Catalogue image",
          subject: "A wide shallow serving bowl in olive-glazed stoneware",
          artDirection: "Matte glaze, soft morning light",
          aspectRatio: "4:5",
        },
        [
          anchorRef,
          {
            role: "set",
            mediaType: first.mediaType,
            base64: Buffer.from(first.bytes).toString("base64"),
          },
        ],
      ),
      4 / 5,
    );
  }
  console.log(`Estimated total: $${(totalCost / 1e6).toFixed(4)}`);
  console.log(`Files: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
