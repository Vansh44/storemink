import type { MinkProductActionStatus } from "./product-action-types";
import type { MinkStorefrontLayoutSummary } from "./types";

/**
 * What an approval binds itself to, on each side of the change.
 *
 * ★★ DIGESTS, NOT THE SECTION LISTS THEMSELVES. The 7B approval carries the
 * whole before/after code because a code field is small and there is nowhere
 * else to read it from. A section list is bounded at 128 KB, so copying both
 * sides onto the approval row would store a quarter of a megabyte per preview
 * -- of content that already exists twice, in the draft's `before_json` and
 * `content_json`. The digest binds it just as tightly: execution re-reads both
 * lists from their own rows and refuses unless each hashes to what was
 * approved, so nothing can be swapped underneath the approval.
 */
export interface MinkStorefrontLayoutActionValues {
  page_slug: string;
  page_title: string;
  sections_digest: string;
  section_count: string;
}

export interface MinkStorefrontLayoutActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "apply_storefront_layout";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "storefront_page";
    id: string;
    label: string;
    dashboardPath: string;
  };
  before: MinkStorefrontLayoutActionValues;
  after: MinkStorefrontLayoutActionValues;
  summary: MinkStorefrontLayoutSummary;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkStorefrontLayoutActionResult {
  approval: MinkStorefrontLayoutActionApproval;
  auditId: string;
  repeated: boolean;
}
