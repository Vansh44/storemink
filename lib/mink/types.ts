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
      recordType: "order" | "product" | "inventory" | "storefront";
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
