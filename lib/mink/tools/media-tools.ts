import "server-only";

import {
  MINK_MEDIA_ALT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MIN_CHARS,
  MINK_MEDIA_PURPOSES,
  MINK_MEDIA_PURPOSE_SPECS,
  MINK_MEDIA_REFERENCE_MAX,
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
 * ★ SO IS THE GENERATION CONTRACT. The detailed instruction stays in the
 * validated Markdown prompt; this declaration makes the model resolve exact
 * store-owned source images before it spends the merchant's credits.
 */
const generateStorefrontImage: MinkTool = {
  declaration: {
    name: "generate_storefront_image",
    description:
      "Create one charged AI storefront image, save it immediately in this store's Media Library, and return its exact URL. BEFORE every generation, read the source that matches the request: search_products/get_current_product for a named or selected product, search_storefront_categories for a named category, and list_storefront_media for a particular saved image or for general store visual context. Pass up to four exact relevant URLs from those results in reference_image_urls; pass [] only after the relevant read found no suitable image. The image model receives those files, not merely their URLs. A named product or category must be grounded in its authentic images rather than replaced with an invented stand-in; a specific saved image must guide the new composition exactly as the user requested. Infer purpose from the requested destination: hero for the top/lead area, gallery for a square tile, feature for an image beside text, banner for a full-width promo strip. Describe the requested outcome in prompt — subject, composition, setting, mood, lighting and palette — and say how the references should be used. The result is AI-generated campaign/storefront artwork and cannot be written to a product's catalogue images. If the request also names a page destination, use the returned URL in propose_storefront_layout in the same run when available. Do not add new text, watermarks, signatures or people. Do not pass arbitrary web URLs, guessed URLs, unrelated products, or references the read tools did not return.",
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
        reference_image_urls: {
          type: "array",
          minItems: 0,
          maxItems: MINK_MEDIA_REFERENCE_MAX,
          uniqueItems: true,
          description:
            "Exact relevant PNG, JPEG or WebP URLs returned by search_products, get_current_product, search_storefront_categories or list_storefront_media immediately before this call. Preserve relevance order. Use [] only when the relevant reads returned no suitable image.",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
          },
        },
        alt: {
          type: "string",
          minLength: 1,
          maxLength: MINK_MEDIA_ALT_MAX_CHARS,
          description:
            "Alt text describing what a shopper would see, for screen readers and for search. Required: nothing else in the dashboard will ask for it later.",
        },
      },
      required: ["purpose", "prompt", "reference_image_urls", "alt"],
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
      referenceImageUrls: args.reference_image_urls,
      alt: args.alt,
    });
    return {
      proposal,
      authority: {
        savedToMediaLibrary: true,
        canUseInLayoutProposal: true,
        canPlaceDirectlyOnStorefront: false,
        canUseAsProductPhoto: false,
        canCreateFromOwnedReferences: true,
        canOverwriteReferenceImages: false,
      },
    };
  },
};

export const minkMediaTools = [generateStorefrontImage];
