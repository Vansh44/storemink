import "server-only";

import { and, eq } from "drizzle-orm";
import { minkActionToolAccess } from "@/drizzle/schema";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { createMinkDraftProposal } from "./drafts";
import { MinkRequestError, MinkToolInputError } from "./errors";
import {
  MINK_GENERATED_MEDIA_FOLDER,
  MINK_MEDIA_PURPOSE_SPECS,
  aspectRatioFor,
  validateMinkMediaGenerationRequest,
  type MinkMediaPurpose,
} from "./media-generation-contract";
import {
  generateMinkMediaImage,
  reserveMinkImageGeneration,
} from "./media-generation";
import { getMinkConfig } from "./config";
import type { MinkDraftContent } from "./draft-types";
import type { MinkActorContext, MinkArtifact } from "./types";

// ---------------------------------------------------------------------------
// Phase 9E - one charged, immutable proposal that IS an image.
//
// ★★ THE IMAGE IS GENERATED WHEN THE PROPOSAL IS CREATED, NOT WHEN IT IS
// APPROVED, and that inverts 9B/9C's ordering deliberately. Those two propose
// a CHANGE to something the merchant can already see, so a card describing the
// change is reviewable. Here the artefact is a picture: a card describing a
// prompt asks a merchant to approve an image nobody has looked at, which is
// the one thing a review must never be. 9C's own rule -- the card shows the
// COLOURS, not a description of them -- read one step further.
//
// ★ THE CONSEQUENCE, ACCEPTED: a proposal the merchant discards has already
// cost a provider call. That is the right way round. The alternative spends
// the same money after an approval, and spends it on an image that may be
// wrong, which is a charge AND a disappointment rather than just a charge.
//
// ★★ AND SAVING IT IS NOT AN APPROVAL, IT IS A BUTTON -- 9D's precedent, in
// the same feature area. 9D's composer saves a merchant's own attachment to
// the Media Library behind `media:manage` and nothing else, because a library
// row changes nothing a shopper can see: 9D's ownership check means the only
// route from `media_assets` to a live storefront is a layout proposal the
// merchant separately approves. A generated image enters by the same door and
// is stopped by the same gate, so a second five-minute approval here would
// guard a boundary that is already guarded and teach merchants to click
// through one.
// ---------------------------------------------------------------------------

/**
 * The operator switch for image generation.
 *
 * ★★ IT GATES THE GENERATION, NOT THE SAVE, WHICH IS THE OPPOSITE OF EVERY
 * OTHER TOOL GATE HERE -- and it has to be. Everywhere else the expensive,
 * irreversible half is the write, so the gate sits on the action. Here the
 * write is a private library row and the PROVIDER CALL is the part that spends
 * real per-image money, so a gate on the save would leave the only thing worth
 * switching off ungated.
 */
const MEDIA_TOOL = "generate_media_image";

export interface MinkMediaProposalInput {
  actor: MinkActorContext;
  purpose: unknown;
  prompt: unknown;
  alt: unknown;
}

export async function createMinkMediaImageProposal(
  input: MinkMediaProposalInput,
): Promise<Extract<MinkArtifact, { type: "media_image_proposal" }>> {
  await assertMediaGenerationAuthority(input.actor);
  if (!gcsConfigured) {
    throw new MinkRequestError(
      "image_storage_not_configured",
      "Image generation needs media storage (GCS_BUCKET).",
      503,
    );
  }

  const validation = validateMinkMediaGenerationRequest({
    purpose: input.purpose,
    prompt: input.prompt,
    alt: input.alt,
  });
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The image request is invalid: ${validation.issues.join(" ")}`,
    );
  }
  const request = validation.value;

  // ★ THE SPEND CEILING IS CLAIMED BEFORE THE PROVIDER CALL AND BEFORE THE
  //   CREDIT CHARGE. Charging first and then refusing would bill a merchant
  //   for a picture they never received.
  if (!input.actor.runId) {
    throw new MinkToolInputError("The draft run is not available. Try again.");
  }
  await reserveMinkImageGeneration(input.actor, input.actor.runId);

  const image = await generateMinkMediaImage(getMinkConfig(), request);

  const extension = image.mimeType === "image/png" ? "png" : "jpg";
  const path = `stores/${input.actor.storeId}/${MINK_GENERATED_MEDIA_FOLDER}/${crypto.randomUUID()}.${extension}`;
  let url: string;
  try {
    url = await gcsUploadObject(path, image.bytes, image.mimeType);
  } catch (error) {
    logError("mink generated image upload failed", error, { path });
    throw new MinkRequestError(
      "image_storage_failed",
      "The image was created but could not be stored. Try again.",
      503,
    );
  }

  const spec = MINK_MEDIA_PURPOSE_SPECS[request.purpose];
  const filename = `${request.purpose}-${Date.now()}.${extension}`;
  let stored;
  try {
    stored = await createMinkDraftProposal({
      actor: input.actor,
      kind: "media_image",
      title: spec.label,
      destinationType: "media_asset",
      destinationLabel: `Media Library · ${spec.label}`,
      destinationPath: "/dashboard/media",
      content: draftContent({
        url,
        path,
        filename,
        contentType: image.mimeType,
        sizeBytes: image.bytes.length,
        purpose: request.purpose,
        prompt: request.prompt,
        alt: request.alt,
      }),
    });
  } catch (error) {
    // ★ AN ORPHANED OBJECT IS TIDIED UP THE WAY `uploadMediaAsset` TIDIES ITS
    //   OWN. Best effort: a failed cleanup costs a stray file under the
    //   store's prefix, which a store purge removes; failing the proposal a
    //   second time over it would lose the image AND the credit.
    await gcsDeletePaths([path]).catch(() => []);
    throw error;
  }
  if (stored.type !== "proposal") {
    throw new Error("Generated image persistence returned no proposal");
  }

  return {
    type: "media_image_proposal",
    draftId: stored.draftId,
    title: stored.title,
    destinationLabel: stored.destinationLabel,
    destinationPath: "/dashboard/media",
    url,
    alt: request.alt,
    prompt: request.prompt,
    purpose: request.purpose,
    aspectRatio: aspectRatioFor(request.purpose),
    placement: spec.placement,
    saved: false,
    status: "private_preview",
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}

function draftContent(input: {
  url: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  purpose: MinkMediaPurpose;
  prompt: string;
  alt: string;
}): MinkDraftContent {
  return {
    url: input.url,
    storage_path: input.path,
    filename: input.filename,
    content_type: input.contentType,
    size_bytes: String(input.sizeBytes),
    purpose: input.purpose,
    prompt: input.prompt,
    alt: input.alt,
  };
}

/** Drafting, Media manage, and the store's own image-generation gate. */
export async function assertMediaGenerationAuthority(
  actor: MinkActorContext,
): Promise<void> {
  if (actor.draftingEnabled !== true) {
    throw new MinkToolInputError("Mink AI drafting is not enabled.");
  }
  // ★ `media:manage`, NOT `builder:manage`. The artefact lands in the Media
  //   Library; putting it on a page is a separate 9B layout proposal with its
  //   own Builder gate, so requiring Builder here would withhold image
  //   generation from the person whose job the media actually is.
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(
      "You need Media manage permission to create an image.",
    );
  }
  const rows = await withService((db) =>
    db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, actor.storeId),
          eq(minkActionToolAccess.toolName, MEDIA_TOOL),
        ),
      )
      .limit(1),
  );
  if (!rows[0]?.enabled) {
    throw new MinkToolInputError(
      "Image generation is not enabled for this store.",
    );
  }
}
