import type {
  DesignFont,
  DesignPaletteToken,
  DesignShapeKey,
} from "@/lib/chrome/design";
import type { SectionType } from "@/lib/sections/registry";
import type {
  PermissionAction,
  RolePermissions,
} from "@/app/dashboard/lib/permissions";
import type {
  MinkDraftContent,
  MinkDraftCreditSource,
  MinkDraftField,
  MinkDraftKind,
  MinkDraftStatus,
} from "./draft-types";
import type { MinkMediaPurpose } from "./media-generation-contract";
import type {
  MinkWorkflowStatus,
  MinkWorkflowTemplate,
} from "./workflow-types";

export type MinkPlan = "free" | "basic" | "pro";

export type MinkSelectedResource = {
  type: "product" | "order";
  id: string;
};

export type MinkFilter = {
  label: string;
  value: string;
};

/**
 * What a Phase 9B layout proposal changes, for the human review card.
 *
 * ★ IT LIVES HERE, NOT IN THE CONTRACT, because the contract is `server-only`
 * and this shape is rendered by a dashboard client component. `import type` is
 * erased, so the compiler would allow it either way -- and that is exactly the
 * hazard: the day somebody reaches for a VALUE from the same module the build
 * breaks with a `server-only` error rather than a type error. The two halves of
 * the split are `lib/logs/failure-types.ts`'s rule.
 */
export interface MinkStorefrontLayoutSectionRef {
  id: string;
  /**
   * ★ THE TYPE RIDES ALONG BECAUSE AN ID IS NOT A NAME. Section ids are opaque
   * strings, so a card listing "Removed: sec_8f2a1c" tells a merchant nothing
   * about what they are being asked to approve deleting. The card turns the
   * type into a label through `SECTION_TYPE_META`, which is the same
   * vocabulary the Builder's own outline uses -- so the two agree by
   * construction rather than through a second copy of the labels.
   */
  type: SectionType;
}

export interface MinkStorefrontLayoutSummary {
  /** Sections present before and after, in their PROPOSED order. */
  kept: MinkStorefrontLayoutSectionRef[];
  added: MinkStorefrontLayoutSectionRef[];
  removed: MinkStorefrontLayoutSectionRef[];
  /** Order of the SURVIVING sections changed (a pure add is not a reorder). */
  reordered: boolean;
  /**
   * Pictures the proposal PUTS ON THE PAGE, newest-change first, capped.
   *
   * ★★ WITHOUT THESE THE CARD CANNOT SHOW WHAT IT IS ASKING TO APPROVE. It
   * renders section LABELS -- "Carousel · 1 slide", "0 added, 0 removed" -- so
   * a merchant who asked for a banner got a text list and no banner. Observed:
   * a proposal that correctly used the store's own product photograph was read
   * as having ignored it, and the merchant asked for a generated image instead,
   * which replaced their real one. The card was right and unreadable.
   *
   * ⚠ A URL here becomes an `<img src>` in the dashboard, restored from stored
   * conversation JSON -- so the parser re-checks every one against our own
   * media hosts (9E's rule for generated images, for the same reason: a forged
   * history row must not turn into a request to a third-party address).
   */
  previewImageUrls?: string[];
}

/**
 * What a Phase 9C design proposal changes, for the human review card.
 *
 * ★ ONLY THE FIELDS THAT MOVED, each carrying the theme value underneath it.
 * A design override is three-state -- set, cleared, or never touched -- and a
 * card that renders an empty swatch for "cleared" tells a merchant nothing
 * about what their shop will actually look like. `themeDefault` is the colour
 * the storefront paints when the override goes away, so "back to the theme"
 * can be shown as a real value rather than as an absence.
 */
export interface MinkStorefrontDesignSummary {
  palette: Array<{
    token: DesignPaletteToken;
    before: string | null;
    after: string | null;
    themeDefault: string | null;
  }>;
  fonts: Array<{
    slot: "body" | "display";
    before: DesignFont | null;
    after: DesignFont | null;
    themeDefault: DesignFont | null;
  }>;
  shape: Array<{
    key: DesignShapeKey;
    before: number | null;
    after: number | null;
    themeDefault: number | null;
  }>;
  /** Recomputed on read; empty on any proposal the contract accepted. */
  contrastIssues: string[];
}

export type MinkArtifact =
  | {
      type: "clarification";
      title: string;
      question: string;
      choices: Array<{
        label: string;
        description?: string;
        prompt: string;
      }>;
    }
  | {
      type: "metrics";
      title: string;
      currency?: string;
      metrics: Array<{
        label: string;
        value: number;
        format: "number" | "currency" | "percent";
        trendPercent?: number | null;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
    }
  | {
      type: "catalog";
      title: string;
      counts: {
        total: number;
        published: number;
        unpublished: number;
        draft: number;
        archived: number;
        inventoryItems: number | null;
        lowStock: number | null;
        outOfStock: number | null;
      };
      items: Array<{
        id: string;
        title: string;
        variant?: string;
        sku: string;
        publicationStatus: string;
        publicationTags: string[];
        inventoryStatus: string | null;
        stock: number | null;
        threshold: number | null;
        dashboardPath?: string;
      }>;
      locations?: Array<{
        id: string;
        name: string;
        type: string;
        inventoryItems: number;
        trackedItems: number;
        lowStock: number;
        outOfStock: number;
        dashboardPath?: string;
        prompt: string;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
      inventoryDashboardPath?: string;
      truncated?: boolean;
      locationsTruncated?: boolean;
    }
  | {
      type: "records";
      title: string;
      recordType: "order" | "product" | "inventory" | "storefront" | "offer";
      records: Array<{
        id: string;
        title: string;
        subtitle?: string;
        value?: string;
        status?: string;
        dashboardPath?: string;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
      truncated?: boolean;
    }
  | {
      type: "sources";
      title: string;
      sources: Array<{
        title: string;
        excerpt?: string;
        url: string;
      }>;
      query: string;
    }
  | {
      type: "proposal";
      draftId: string;
      draftKind: MinkDraftKind;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      before: MinkDraftField[];
      after: MinkDraftField[];
      content: MinkDraftContent;
      status: MinkDraftStatus;
      currentVersion: number;
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_code_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: {
        pageSlug: string;
        sectionId: string;
        expectedPageVersion: string;
        expectedSectionDigest: string;
      };
      patchDigest: string;
      changedFields: Array<"html" | "css" | "js" | "height">;
      beforeCharacters: number;
      afterCharacters: number;
      validationChecks: string[];
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_layout_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: {
        pageSlug: string;
        expectedPageVersion: string;
        expectedSectionsDigest: string;
      };
      patchDigest: string;
      summary: MinkStorefrontLayoutSummary;
      sectionCount: number;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_design_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: { expectedDesignDigest: string };
      patchDigest: string;
      summary: MinkStorefrontDesignSummary;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "media_image_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      /**
       * The image itself.
       *
       * ⚠ PUBLIC, like every other object in the media bucket (uniform
       * bucket-level access, §7), and saved into the Media Library as part of
       * generation so the same run may cite it in a layout proposal. The card
       * renders it directly; a proposal that only described the picture would
       * ask a merchant to approve something nobody has looked at.
       */
      url: string;
      alt: string;
      prompt: string;
      /** Number of verified current-store source images sent to the model. */
      referenceImageCount?: number;
      purpose: MinkMediaPurpose;
      aspectRatio: string;
      placement: string;
      saved: boolean;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "workflow";
      runId: string;
      template: MinkWorkflowTemplate;
      title: string;
      description: string;
      status: MinkWorkflowStatus;
      currentStep: number;
      totalSteps: number;
    };

export type MinkFeedbackRating = "helpful" | "unhelpful";
export type MinkFeedbackIssue =
  | "incorrect"
  | "missing_context"
  | "privacy"
  | "slow"
  | "other";

/**
 * Trusted, server-derived identity for one Mink run. Model-generated input must
 * never be able to replace any field on this object.
 */
export interface MinkActorContext {
  storeId: string;
  adminId: string;
  email: string | null;
  roleSlug: string;
  permissions: RolePermissions;
  isSuperadmin: boolean;
  effectivePlan: MinkPlan;
  /** Null means unrestricted; an array is the exact server-derived location scope. */
  locationIds: string[] | null;
  analyticsTimeZone: string;
  currency: string;
  defaultLowStockThreshold: number;
  currentPath?: string | null;
  selectedResource?: MinkSelectedResource | null;
  /** Trusted run id is attached only after the run row is created. */
  runId?: string;
  /** Operator-controlled Phase 3 access; never inferred from the prompt. */
  draftingEnabled?: boolean;
  /** Store-authored style context. It may shape copy but never authority. */
  brandVoice?: string;
  requestId: string;
}

export interface MinkToolPermission {
  section: string;
  action: PermissionAction;
}

export interface MinkToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface MinkToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MinkToolResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
  artifact?: MinkArtifact;
}

export interface MinkUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  /**
   * The SUBSET of `promptTokens` the provider served from a context cache, so
   * `promptTokens - cachedTokens` is what was charged at the full input rate.
   * The provider documents `promptTokenCount` as already including cached
   * content, so this must never be added to it.
   *
   * Recorded as a raw fact rather than folded into a cost: the system prompt
   * plus tool declarations are a deterministic ~10.5k-token prefix re-sent on
   * every step of every run, and it is the single largest cost line. Whether a
   * cache is actually serving it is otherwise invisible.
   */
  cachedTokens: number;
}

export interface MinkModelTurn {
  text: string;
  functionCalls: MinkToolCall[];
  usage: MinkUsage;
  /** Provider-call retries consumed while producing this turn. */
  retryCount: number;
}

export interface MinkModelSession {
  sendUserMessage(message: string): Promise<MinkModelTurn>;
  sendToolResponses(responses: MinkToolResponse[]): Promise<MinkModelTurn>;
}

export type MinkRunEvent =
  | { type: "tool_call"; sequence: number; call: MinkToolCall }
  | {
      type: "tool_result";
      sequence: number;
      name: string;
      ok: boolean;
      errorCode?: string;
      artifact?: MinkArtifact;
    };

export interface MinkRunResult {
  text: string;
  model: string;
  steps: number;
  toolCalls: number;
  retryCount: number;
  usage: MinkUsage;
  artifacts: MinkArtifact[];
}

export interface MinkRunProgress {
  steps: number;
  toolCalls: number;
  retryCount: number;
  usage: MinkUsage;
}
