import type { MinkProductActionStatus } from "./product-action-types";
import type { MinkStorefrontDesignSummary } from "./types";

/**
 * What an approval binds itself to, on each side of the change.
 *
 * ★★ A DIGEST, NOT THE OVERRIDE SET -- 9B's rule, for a different reason. A
 * design is small enough to copy onto the approval row, but copying it would
 * create a THIRD place the same palette lives (draft `before_json`, draft
 * `content_json`, and here), and the one that drifts is the one nothing
 * re-validates. Execution re-reads both sides from their own rows and refuses
 * unless each hashes to what was approved, so nothing can be swapped
 * underneath the approval.
 *
 * `override_count` is decoration for the audit line, not a guard: how many
 * tokens a merchant chose to set is the one fact a human reading the log wants
 * that a digest cannot give them.
 */
export interface MinkStorefrontDesignActionValues {
  design_digest: string;
  override_count: string;
}

export interface MinkStorefrontDesignActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "apply_storefront_design";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "storefront_chrome";
    id: string;
    label: string;
    dashboardPath: string;
  };
  before: MinkStorefrontDesignActionValues;
  after: MinkStorefrontDesignActionValues;
  summary: MinkStorefrontDesignSummary;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkStorefrontDesignActionResult {
  approval: MinkStorefrontDesignActionApproval;
  auditId: string;
  repeated: boolean;
}
