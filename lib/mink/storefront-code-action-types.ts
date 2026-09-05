import type { CustomCodeConfig } from "@/lib/sections/registry";
import type { MinkProductActionStatus } from "./product-action-types";

export interface MinkStorefrontCodeActionValues {
  page_slug: string;
  page_title: string;
  section_id: string;
  section_digest: string;
  html: string;
  css: string;
  js: string;
  height_mode: CustomCodeConfig["height_mode"];
  fixed_height: string;
}

export interface MinkStorefrontCodeActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "apply_storefront_code";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "storefront_section";
    id: string;
    label: string;
    dashboardPath: string;
  };
  before: MinkStorefrontCodeActionValues;
  after: MinkStorefrontCodeActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkStorefrontCodeActionResult {
  approval: MinkStorefrontCodeActionApproval;
  auditId: string;
  repeated: boolean;
}
