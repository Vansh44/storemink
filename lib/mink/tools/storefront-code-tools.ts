import "server-only";

import {
  CODE_HEIGHT_MAX,
  CODE_HEIGHT_MIN,
  CODE_MAX_CHARS,
} from "@/lib/sections/registry";
import { createMinkStorefrontCodeProposal } from "../storefront-code-proposals";
import {
  MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
  MINK_STOREFRONT_PATCH_MAX_CHARS,
} from "../storefront-code-contract";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

const proposeStorefrontCustomCode: MinkTool = {
  declaration: {
    name: "propose_storefront_custom_code",
    description:
      "Create a charged, immutable private Phase 7B code proposal and isolated preview for one EXISTING custom-code section. First read the exact page, section and design context. Pass the exact current page version and section digest unchanged. Provide complete replacement HTML/CSS/JavaScript; preserve existing code intentionally when it should remain. Unsafe APIs and stale targets are rejected. This tool stores only a private Mink proposal: it cannot add a section, edit/save the Website Builder draft, publish, access the repository or deploy.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        page_slug: {
          type: "string",
          minLength: 1,
          maxLength: 60,
          description:
            "Exact page slug returned by list_storefront_pages, or home.",
        },
        section_id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Exact existing custom-code section id returned by get_storefront_page_context.",
        },
        expected_page_version: {
          type: "string",
          minLength: 20,
          maxLength: 40,
          description:
            "Exact pageVersion returned by current page/section context. Preserve all timestamp precision.",
        },
        expected_section_digest: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description:
            "Exact lowercase sectionDigest returned by current page/section context.",
        },
        html: {
          type: "string",
          maxLength: CODE_MAX_CHARS,
          description:
            "Complete replacement HTML fragment. No script/style/embed/form/meta/link elements, event attributes, URL attributes or inline styles.",
        },
        css: {
          type: "string",
          maxLength: CODE_MAX_CHARS,
          description:
            "Complete replacement CSS. No @import, url(), expression, behavior or external resources.",
        },
        js: {
          type: "string",
          maxLength: CODE_MAX_CHARS,
          description:
            "Complete replacement JavaScript. No network, storage, cookies, parent/top access, dynamic evaluation, workers, navigation or resource loading.",
        },
        height_mode: {
          type: "string",
          enum: ["auto", "fixed"],
        },
        fixed_height: {
          type: "integer",
          minimum: CODE_HEIGHT_MIN,
          maximum: CODE_HEIGHT_MAX,
        },
        explanation: {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          description:
            "Plain-language explanation of the intended visual result, responsive behavior and changed source fields. Do not claim it was saved or published.",
        },
      },
      required: [
        "page_slug",
        "section_id",
        "expected_page_version",
        "expected_section_digest",
        "html",
        "css",
        "js",
        "height_mode",
        "fixed_height",
        "explanation",
      ],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  timeoutMs: 10_000,
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "storefront_code_proposal" ? proposal : undefined;
  },
  async execute(actor, args) {
    const proposal = await createMinkStorefrontCodeProposal({
      actor,
      patch: {
        schemaVersion: MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
        operation: "replace_custom_code",
        target: {
          pageSlug: args.page_slug,
          sectionId: args.section_id,
          expectedPageVersion: args.expected_page_version,
          expectedSectionDigest: args.expected_section_digest,
        },
        code: {
          html: args.html,
          css: args.css,
          js: args.js,
          heightMode: args.height_mode,
          fixedHeight: args.fixed_height,
        },
      },
      explanation: args.explanation,
    });
    return {
      proposal,
      limits: {
        maxCharactersPerField: CODE_MAX_CHARS,
        maxCharactersCombined: MINK_STOREFRONT_PATCH_MAX_CHARS,
      },
      authority: {
        canPreview: true,
        canSaveBuilderDraft: false,
        canPublish: false,
      },
    };
  },
};

export const minkStorefrontCodeTools = [proposeStorefrontCustomCode];
