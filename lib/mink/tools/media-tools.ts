import "server-only";

import {
  MINK_MEDIA_ALT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MIN_CHARS,
  MINK_MEDIA_PURPOSES,
  MINK_MEDIA_PURPOSE_SPECS,
} from "../media-generation-contract";
import { createMinkMediaImageProposal } from "../media-image-proposals";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

/**
 * ★★ THE ASPECT RATIO IS NOT A PARAMETER, AND THAT IS THE POINT OF `purpose`.
 * A model asked for "a hero image" will cheerfully pick 9:16, and the hero
 * renderer then crops that through the middle of its subject. The purpose is a
 * statement about WHERE the image goes, which is something the model genuinely
 * knows; the shape follows from it, which is something the renderer knows.
 *
 * ★ SO IS THE NEGATIVE PROMPT. Its whole value is being byte-identical on
 * every call, so it is applied by the provider module and never exposed here.
 */
const generateStorefrontImage: MinkTool = {
  declaration: {
    name: "generate_storefront_image",
    description:
      "Create one charged decorative AI image, save it immediately in this store's Media Library, and return its exact URL. Infer purpose from the requested destination: hero for the top/lead area, gallery for a square tile, feature for an image beside text, banner for a full-width promo strip. Describe the SCENE — style, subject, mood, lighting and palette. This is never a photograph of the merchant's actual goods and cannot become a product photo. If the user also asked to use it on a page, do not stop here: use the returned URL in propose_storefront_layout in the same run when that tool is available; that later proposal still needs human approval. Do not ask for text, logos, packaging labels, branded products or people — those are removed automatically and asking for them wastes the charge. Do not use this to edit, crop or restyle an existing image. When the user explicitly asks to CREATE a new image, do not substitute an existing library image; when a broader layout request merely needs imagery, call list_storefront_media first and prefer a suitable image they already own.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          enum: [...MINK_MEDIA_PURPOSES],
          description: MINK_MEDIA_PURPOSES.map(
            (purpose) =>
              `${purpose}: ${MINK_MEDIA_PURPOSE_SPECS[purpose].placement} (${MINK_MEDIA_PURPOSE_SPECS[purpose].aspectRatio}).`,
          ).join(" "),
        },
        prompt: {
          type: "string",
          minLength: MINK_MEDIA_PROMPT_MIN_CHARS,
          maxLength: MINK_MEDIA_PROMPT_MAX_CHARS,
          description:
            "The scene to create, in plain English. Name the subject, the setting, the lighting and the palette. Concrete descriptions produce usable images; one or two words produce stock-photo noise.",
        },
        alt: {
          type: "string",
          minLength: 1,
          maxLength: MINK_MEDIA_ALT_MAX_CHARS,
          description:
            "Alt text describing what a shopper would see, for screen readers and for search. Required: nothing else in the dashboard will ask for it later.",
        },
      },
      required: ["purpose", "prompt", "alt"],
      additionalProperties: false,
    },
  },
  // ★ MEDIA MANAGE, NOT BUILDER. The artefact is saved to the Media Library;
  //   placing it is a separate layout proposal with its own Builder gate.
  permission: { section: "media", action: "manage" },
  available,
  // Generous against the read tools' own budgets: image generation routinely takes ten
  // seconds or more, and a timeout here would abandon an image the merchant
  // has already been charged for.
  timeoutMs: 50_000,
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "media_image_proposal" ? proposal : undefined;
  },
  async execute(actor, args) {
    const proposal = await createMinkMediaImageProposal({
      actor,
      purpose: args.purpose,
      prompt: args.prompt,
      alt: args.alt,
    });
    return {
      proposal,
      authority: {
        savedToMediaLibrary: true,
        canUseInLayoutProposal: true,
        canPlaceDirectlyOnStorefront: false,
        canUseAsProductPhoto: false,
        canEditExistingImages: false,
      },
    };
  },
};

export const minkMediaTools = [generateStorefrontImage];
