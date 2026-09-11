import "server-only";

import {
  DESIGN_FONTS,
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_MIN_CONTRAST,
  DESIGN_SHAPE_KEYS,
} from "@/lib/chrome/design";
import { MINK_STOREFRONT_DESIGN_SCHEMA_VERSION } from "../storefront-design-contract";
import { createMinkStorefrontDesignProposal } from "../storefront-design-proposals";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

/**
 * ★★ EVERY FIELD IS NULLABLE, AND `null` IS THE ONLY WAY TO SAY "USE THE
 * THEME". An absent key would mean the same thing, but a model that cannot
 * state the intention explicitly tends to restate the theme's own hex instead
 * -- which PINS the store to today's preset, so a later theme upgrade stops
 * reaching it (`designOverrideCssVars` exists for exactly that reason). Making
 * the clear expressible is what keeps "put this back to the theme" a one-turn
 * instruction.
 */
const PALETTE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    DESIGN_PALETTE_TOKENS.map((token) => [
      token,
      {
        type: ["string", "null"],
        description: `Hex colour such as #1a1a1a, or null to inherit the pinned theme's ${token}.`,
      },
    ]),
  ),
  additionalProperties: false,
} as const;

const SHAPE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    DESIGN_SHAPE_KEYS.map((key) => [
      key,
      {
        type: ["integer", "null"],
        minimum: 0,
        maximum: key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX,
        description: `Corner radius in pixels (0-${key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX}), or null to inherit the pinned theme.`,
      },
    ]),
  ),
  additionalProperties: false,
} as const;

const proposeStorefrontDesign: MinkTool = {
  declaration: {
    name: "propose_storefront_design",
    description:
      "Create a charged, immutable private proposal for the store's WHOLE storefront design — its palette, its two typefaces and its corner radii. First read get_storefront_design_context and pass its designDigest back unchanged. Send the complete override set you want the store to have, not a diff: a token you leave out or set to null goes back to inheriting the pinned theme, which is a safe, designed state. Body text must stay legible — every colour pair is checked against WCAG AA and an illegible palette is refused with the exact pairs that failed, so use the theme defaults in the context to see what each colour will sit against. This changes no page content and no section: use propose_storefront_layout for a page's blocks and propose_storefront_custom_code for a custom-code section. It stores only a private proposal: it cannot save the Website Builder draft, publish, access the repository or deploy.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        expected_design_digest: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description:
            "Exact lowercase designDigest returned by the current design context.",
        },
        palette: {
          ...PALETTE_SCHEMA,
          description: `The storefront's colours. cream is the page background, surface is a card, ink is body text, inkSoft is muted text, inkFaint is the faintest text, border is a hairline, accent is the brand colour. Contrast of at least ${DESIGN_MIN_CONTRAST}:1 is required for ink on cream, ink on surface and inkSoft on cream.`,
        },
        fonts: {
          type: "object",
          properties: {
            body: {
              type: ["string", "null"],
              enum: [...Object.keys(DESIGN_FONTS), null],
              description:
                "Typeface for body copy, or null to inherit the pinned theme.",
            },
            display: {
              type: ["string", "null"],
              enum: [...Object.keys(DESIGN_FONTS), null],
              description:
                "Typeface for headings, or null to inherit the pinned theme.",
            },
          },
          additionalProperties: false,
          description:
            "Only these typefaces are loaded by the storefront; naming any other is refused.",
        },
        shape: {
          ...SHAPE_SCHEMA,
          description:
            "Corner radii in pixels. card is a card, control is a button or input, sm is a small chip, pill is a fully rounded control.",
        },
        explanation: {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          description:
            "Plain-language explanation of the look this creates and what changed. Do not claim it was saved or published.",
        },
      },
      required: ["expected_design_digest", "explanation"],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  timeoutMs: 10_000,
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "storefront_design_proposal"
      ? proposal
      : undefined;
  },
  async execute(actor, args) {
    // The declared shape is enforced by `validateMinkStorefrontDesignPatch`,
    // which names every rejected field rather than dropping it; this cast only
    // reaches the two nested keys the tool argument type erases.
    const fonts = args.fonts as
      | { body?: unknown; display?: unknown }
      | undefined;
    const proposal = await createMinkStorefrontDesignProposal({
      actor,
      patch: {
        schemaVersion: MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
        operation: "replace_design_overrides",
        target: { expectedDesignDigest: args.expected_design_digest },
        design: {
          palette: args.palette ?? {},
          fonts: {
            body: fonts?.body ?? null,
            display: fonts?.display ?? null,
          },
          shape: args.shape ?? {},
        },
      },
      explanation: args.explanation,
    });
    return {
      proposal,
      limits: {
        paletteTokens: DESIGN_PALETTE_TOKENS,
        fonts: Object.keys(DESIGN_FONTS),
        maxRadiusPx: DESIGN_RADIUS_MAX,
        maxPillRadiusPx: DESIGN_PILL_MAX,
        minContrastRatio: DESIGN_MIN_CONTRAST,
      },
      authority: {
        canPreview: true,
        canSaveBuilderDraft: false,
        canPublish: false,
        canEditPageContent: false,
      },
    };
  },
};

export const minkStorefrontDesignTools = [proposeStorefrontDesign];
