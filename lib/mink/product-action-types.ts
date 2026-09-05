import type { MinkDraftContent } from "./draft-types";

export const MINK_PRODUCT_ACTION_TOOLS = [
  "apply_product_description",
  "apply_product_seo",
] as const;

export const MINK_DOMAIN_ACTION_TOOLS = [
  "create_product",
  "create_coupon",
  "update_coupon",
  "create_customer_group",
  "update_customer_group",
  // ★★ THREE TOOLS, NOT TWO, and the third is the whole point. An offer is
  // created DISABLED and activating it is its OWN approval with its own preview
  // (plan §14c). "Mink is capable of everything" and "one approval does
  // everything" are different claims; a disabled offer costs exactly nothing,
  // so the review can take as long as it needs, while a live automatic offer
  // applies itself to every qualifying order from the instant it goes live.
  "create_offer",
  "update_offer",
  "activate_offer",
] as const;

export const MINK_INVENTORY_ACTION_TOOLS = [
  "adjust_inventory",
  "bulk_adjust_inventory",
] as const;

export const MINK_ORDER_ACTION_TOOLS = ["transition_order_status"] as const;

export const MINK_CONTENT_ACTION_TOOLS = ["publish_blog"] as const;

export const MINK_MARKETING_ACTION_TOOLS = ["send_campaign"] as const;

export const MINK_PRICING_ACTION_TOOLS = ["bulk_update_prices"] as const;

export const MINK_STOREFRONT_ACTION_TOOLS = [
  "apply_storefront_code",
  "publish_storefront_code",
] as const;

export const MINK_ACTION_TOOLS = [
  ...MINK_PRODUCT_ACTION_TOOLS,
  ...MINK_DOMAIN_ACTION_TOOLS,
  ...MINK_INVENTORY_ACTION_TOOLS,
  ...MINK_ORDER_ACTION_TOOLS,
  ...MINK_CONTENT_ACTION_TOOLS,
  ...MINK_MARKETING_ACTION_TOOLS,
  ...MINK_PRICING_ACTION_TOOLS,
  ...MINK_STOREFRONT_ACTION_TOOLS,
] as const;

export type MinkProductActionTool = (typeof MINK_PRODUCT_ACTION_TOOLS)[number];
export type MinkDomainActionTool = (typeof MINK_DOMAIN_ACTION_TOOLS)[number];
export type MinkInventoryActionTool =
  (typeof MINK_INVENTORY_ACTION_TOOLS)[number];
export type MinkOrderActionTool = (typeof MINK_ORDER_ACTION_TOOLS)[number];
export type MinkContentActionTool = (typeof MINK_CONTENT_ACTION_TOOLS)[number];
export type MinkMarketingActionTool =
  (typeof MINK_MARKETING_ACTION_TOOLS)[number];
export type MinkPricingActionTool = (typeof MINK_PRICING_ACTION_TOOLS)[number];
export type MinkStorefrontActionTool =
  (typeof MINK_STOREFRONT_ACTION_TOOLS)[number];
export type MinkActionTool = (typeof MINK_ACTION_TOOLS)[number];
export type MinkProductActionOperation = "apply" | "rollback";
export type MinkProductActionStatus =
  | "pending"
  | "executed"
  | "conflicted"
  | "expired"
  | "cancelled";

export type MinkProductActionValues = Record<string, string | null>;

export interface MinkProductActionApproval {
  id: string;
  sourceApprovalId: string | null;
  toolName: MinkProductActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  product: {
    id: string;
    name: string;
    slug: string;
    dashboardPath: string;
  };
  before: MinkProductActionValues;
  after: MinkProductActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkProductActionResult {
  approval: MinkProductActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export function isMinkProductActionTool(
  value: unknown,
): value is MinkProductActionTool {
  return MINK_PRODUCT_ACTION_TOOLS.includes(value as MinkProductActionTool);
}

export function isMinkDomainActionTool(
  value: unknown,
): value is MinkDomainActionTool {
  return MINK_DOMAIN_ACTION_TOOLS.includes(value as MinkDomainActionTool);
}

export function isMinkActionTool(value: unknown): value is MinkActionTool {
  return MINK_ACTION_TOOLS.includes(value as MinkActionTool);
}

export const MINK_ACTION_TOOL_LABELS: Record<MinkActionTool, string> = {
  apply_product_description: "Product descriptions",
  apply_product_seo: "Product SEO",
  create_product: "Draft product creation",
  create_coupon: "Disabled coupon creation",
  update_coupon: "Disabled coupon updates",
  create_customer_group: "Customer-group creation",
  update_customer_group: "Customer-group updates",
  adjust_inventory: "Single-SKU inventory adjustments",
  bulk_adjust_inventory: "Bulk inventory adjustments",
  transition_order_status: "Delivery order-status transitions",
  publish_blog: "Blog publication and scheduling",
  send_campaign: "Coupon email campaigns",
  bulk_update_prices: "Bulk price updates",
  create_offer: "Disabled offer creation",
  update_offer: "Disabled offer updates",
  activate_offer: "Turning an offer on",
  apply_storefront_code: "Website Builder draft code saves",
  publish_storefront_code: "Checked storefront publication and rollback",
};

export function actionToolForDraftKind(
  kind: string,
): MinkProductActionTool | null {
  if (kind === "product_description") return "apply_product_description";
  if (kind === "product_seo") return "apply_product_seo";
  return null;
}

export function actionFieldsForTool(
  tool: MinkProductActionTool,
): readonly string[] {
  return tool === "apply_product_description"
    ? ["description"]
    : ["seo_title", "seo_description"];
}

export function draftContentForAction(
  tool: MinkProductActionTool,
  content: MinkDraftContent,
): MinkProductActionValues {
  return Object.fromEntries(
    actionFieldsForTool(tool).map((field) => [field, content[field] ?? ""]),
  );
}
