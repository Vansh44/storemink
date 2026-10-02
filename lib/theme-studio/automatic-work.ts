import "server-only";
import {
  themeStudioCaptures,
  themeStudioMessages,
  themeStudioRuns,
} from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { AUTOMATIC_CAPTURE_MAX_ATTEMPTS } from "./capture-core";
import { getThemeStudioImageConfig } from "./image-models";
import {
  THEME_STUDIO_IMAGE_FAKE_PROMPT_VERSION,
  THEME_STUDIO_IMAGE_PROMPT_VERSION,
} from "./image-provider";
import { IMAGE_CRASH_ATTEMPTS } from "./image-recovery";
import { recordThemeStudioEvent } from "./repository";

export interface AutomaticWork {
  id: string;
  projectId: string;
  provider: string;
  modelKey: string;
  qaIteration: number;
  createdBy: string | null;
}

export function automaticImageProvider(run: AutomaticWork) {
  if (run.provider === "fake") {
    return {
      providerModel: "fake",
      promptVersion: THEME_STUDIO_IMAGE_FAKE_PROMPT_VERSION,
    };
  }
  const image = getThemeStudioImageConfig();
  return image
    ? {
        providerModel: image.providerModel,
        promptVersion: THEME_STUDIO_IMAGE_PROMPT_VERSION,
      }
    : null;
}

export async function queueAutomaticCapture(
  db: Db,
  run: AutomaticWork,
  version: { id: string },
  packageDigest: string,
  phase: "layout" | "final" = "final",
) {
  const [capture] = await db
    .insert(themeStudioCaptures)
    .values({
      projectId: run.projectId,
      versionId: version.id,
      packageDigest,
      previousStatus: "generating",
      idempotencyKey: `auto_${phase}_${run.id}`,
      phase,
      automatic: true,
      qaIteration: run.qaIteration,
      maxAttempts: AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioCaptures.id });
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    actor: "worker",
    eventType: "capture_requested",
    detail: {
      captureId: capture.id,
      versionId: version.id,
      phase,
      automatic: true,
      qaIteration: run.qaIteration,
    },
  });
}

export async function queueAutomaticImages(
  db: Db,
  run: AutomaticWork,
  version: { id: string },
  packageDigest: string,
  slots: number,
  imageSlotIds: string[] = [],
  corrections: Record<string, string> = {},
): Promise<string | null> {
  const resolved = automaticImageProvider(run);
  if (!resolved) return null;
  const [message] = await db
    .insert(themeStudioMessages)
    .values({
      projectId: run.projectId,
      kind: "images",
      body: imageSlotIds.length
        ? JSON.stringify({ qaImageCorrections: corrections })
        : `Automatically generate images for ${slots} slot${slots === 1 ? "" : "s"} before visual QA.`,
      referenceAssetIds: [],
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioMessages.id });
  const [imageRun] = await db
    .insert(themeStudioRuns)
    .values({
      projectId: run.projectId,
      messageId: message.id,
      kind: "images",
      baseVersionId: version.id,
      basePackageDigest: packageDigest,
      contextMessageIds: [],
      provider: run.provider,
      modelKey: run.modelKey,
      providerModel: resolved.providerModel,
      promptVersion: resolved.promptVersion,
      idempotencyKey: `auto_images_${run.id}`,
      maxAttempts: IMAGE_CRASH_ATTEMPTS,
      imageSlotIds,
      automatic: true,
      qaIteration: run.qaIteration,
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioRuns.id });
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: imageRun.id,
    actor: "worker",
    eventType: "images_requested",
    detail: {
      versionId: version.id,
      slots,
      automatic: true,
      qaIteration: run.qaIteration,
    },
  });
  return imageRun.id;
}
