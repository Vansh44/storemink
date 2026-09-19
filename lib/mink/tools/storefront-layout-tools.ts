import "server-only";

import {
  HOMEPAGE_SECTION_TYPES,
  MAX_PAGE_SECTIONS,
} from "@/lib/sections/registry";
import {
  MINK_STOREFRONT_LAYOUT_MAX_CHARS,
  MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION,
} from "../storefront-layout-contract";
import { createMinkStorefrontLayoutProposal } from "../storefront-layout-proposals";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

/**
 * ★★ A SECTION IS EITHER KEPT BY REFERENCE OR SENT IN FULL, and the reference
 * form is what makes the tool usable at all. The Builder read returns a
 * section's type, position and a prose summary -- never its config, and never
 * custom-code source. So without `keep` a model asked for "the whole list"
 * would have to reinvent every block it means to leave alone, losing settings
 * nobody asked it to touch and failing outright on any page with custom code.
 *
 * ★ `config` IS AN OPEN OBJECT ON PURPOSE. It is a union of seventeen shapes
 * (hero, gallery, testimonials, …), and enumerating them here would put a
 * second, hand-maintained copy of `lib/homepage/section-types.ts` in a tool
 * declaration -- one that goes stale the first time a field is added, and
 * whose staleness shows up as a model refusing to emit a legal field. The
 * registry's own `validateConfig` is the authority and runs on every section
 * before anything is stored, so a wrong shape is refused with a specific
 * message rather than silently accepted.
 */
const SECTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "The EXACT existing section id to keep or replace, or a new unique id (letters, digits, hyphen, underscore) to add one.",
    },
    keep: {
      type: "boolean",
      description:
        "true to carry the merchant's existing section across UNCHANGED. Send only id and keep. This is the only way to preserve a custom-code section, whose source you are never shown.",
    },
    type: {
      type: "string",
      enum: [...HOMEPAGE_SECTION_TYPES],
      description: "Required unless keep is true.",
    },
    enabled: { type: "boolean", description: "Required unless keep is true." },
    config: {
      type: "object",
      description:
        "The section's own configuration for this type. Required unless keep is true.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const proposeStorefrontLayout: MinkTool = {
  declaration: {
    name: "propose_storefront_layout",
    description:
      "Create a charged, immutable private proposal for one page's COMPLETE section list — adding, removing, reordering and reconfiguring structured sections such as hero, gallery, testimonials or featured products. First read the exact page with get_storefront_page_context and pass its pageVersion and sectionsDigest back unchanged. Send the WHOLE list you want the page to have, in render order, not a diff: any existing section you omit is being DELETED. For every existing section you are not changing, send {id, keep: true} — that carries the merchant's own settings across exactly. Custom-code sections can only be kept, never added, edited or removed here; use propose_storefront_custom_code to change their code. It stores only a private proposal: it cannot save the Website Builder draft, publish, access the repository or deploy.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        page_slug: {
          type: "string",
          minLength: 1,
          maxLength: 60,
          description:
            "Exact page slug returned by list_storefront_pages, or home for the storefront homepage.",
        },
        expected_page_version: {
          type: "string",
          minLength: 20,
          maxLength: 40,
          description:
            "Exact pageVersion returned by current page context. Preserve all timestamp precision.",
        },
        expected_sections_digest: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description:
            "Exact lowercase sectionsDigest for the page's WHOLE current section list.",
        },
        sections: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PAGE_SECTIONS,
          items: SECTION_ITEM_SCHEMA,
          description:
            "The complete replacement list, in the order the page should render. Use {id, keep: true} for every section carried across unchanged.",
        },
        explanation: {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          description:
            "Plain-language explanation of what the page will look like and what was added, removed or reordered. Do not claim it was saved or published.",
        },
      },
      required: [
        "page_slug",
        "expected_page_version",
        "expected_sections_digest",
        "sections",
        "explanation",
      ],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  timeoutMs: 10_000,
  // A layout proposal is already the complete merchant-visible result. If the
  // model selects it on the last permitted reasoning turn, the orchestrator can
  // show its review card with this deterministic sentence instead of rejecting
  // the proposal merely because a prose-only model turn would come next.
  stepLimitCompletionText:
    "Your storefront layout proposal is ready. Review the card below and apply it to your Website Builder draft when you are satisfied.",
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "storefront_layout_proposal"
      ? proposal
      : undefined;
  },
  async execute(actor, args) {
    const proposal = await createMinkStorefrontLayoutProposal({
      actor,
      patch: {
        schemaVersion: MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION,
        operation: "replace_page_sections",
        target: {
          pageSlug: args.page_slug,
          expectedPageVersion: args.expected_page_version,
          expectedSectionsDigest: args.expected_sections_digest,
        },
        sections: args.sections,
      },
      explanation: args.explanation,
    });
    return {
      proposal,
      limits: {
        maxSections: MAX_PAGE_SECTIONS,
        maxCharactersCombined: MINK_STOREFRONT_LAYOUT_MAX_CHARS,
      },
      authority: {
        canPreview: true,
        canSaveBuilderDraft: false,
        canPublish: false,
        canEditCustomCode: false,
      },
    };
  },
};

export const minkStorefrontLayoutTools = [proposeStorefrontLayout];
