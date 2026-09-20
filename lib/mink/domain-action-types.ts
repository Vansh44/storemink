import type { MinkDraftContent } from "./draft-types";
import type {
  MinkDomainActionTool,
  MinkProductActionOperation,
  MinkProductActionStatus,
} from "./product-action-types";

/**
 * ★★ ONE LIST, DERIVED BOTH WAYS. This was a bare union, and `domain-actions.ts`
 * carried a hand-written `isResourceType` guard beside it that still read
 * `product | coupon | customer_group`. `validateDomainApprovalRow` runs that
 * guard over every approval it creates, executes or rolls back, so ADDING
 * "offer" to the union changed the types and nothing else: the database
 * accepted `resource_type = 'offer'` (migration 0070) and the application
 * threw "This Mink approval is invalid" on the way in. Deriving the type from
 * the array means the next resource type cannot be half-added.
 */
export const MINK_DOMAIN_RESOURCE_TYPES = [
  "product",
  "coupon",
  "customer_group",
  "offer",
] as const;

export type MinkDomainResourceType =
  (typeof MINK_DOMAIN_RESOURCE_TYPES)[number];

export function isMinkDomainResourceType(
  value: string,
): value is MinkDomainResourceType {
  return (MINK_DOMAIN_RESOURCE_TYPES as readonly string[]).includes(value);
}

export type MinkDomainActionValues = Record<string, string | null>;

export interface MinkDomainActionApproval {
  id: string;
  sourceApprovalId: string | null;
  toolName: MinkDomainActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: MinkDomainResourceType;
    id: string | null;
    label: string;
    dashboardPath: string;
  };
  before: MinkDomainActionValues;
  after: MinkDomainActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkDomainActionResult {
  approval: MinkDomainActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export function domainActionToolForDraftKind(
  kind: string,
): MinkDomainActionTool | null {
  if (kind === "product_create") return "create_product";
  if (kind === "coupon_create") return "create_coupon";
  if (kind === "coupon_update") return "update_coupon";
  if (kind === "customer_group_create") return "create_customer_group";
  if (kind === "customer_group_update") return "update_customer_group";
  if (kind === "offer_create") return "create_offer";
  if (kind === "offer_update") return "update_offer";
  if (kind === "offer_activate") return "activate_offer";
  return null;
}

export function resourceTypeForDomainTool(
  tool: MinkDomainActionTool,
): MinkDomainResourceType {
  if (tool === "create_product") return "product";
  if (tool === "create_coupon" || tool === "update_coupon") return "coupon";
  // ★★ NAMED EXPLICITLY, BEFORE THE FALLTHROUGH. This function ended
  // `return "customer_group"`, so every tool it did not recognise was
  // silently reported as a customer group — and TypeScript is happy, because
  // the return type is satisfied either way. A new tool added without touching
  // this line would write an offer while the approval, the audit row and the
  // dashboard link all said "customer group". Same shape as the reward decoder
  // that made two whole reward types silently inert (plan §19).
  if (
    tool === "create_offer" ||
    tool === "update_offer" ||
    tool === "activate_offer"
  ) {
    return "offer";
  }
  return "customer_group";
}

export function isCreateDomainTool(tool: MinkDomainActionTool) {
  return tool.startsWith("create_");
}

/**
 * Turning an offer on is its OWN approval, with its own preview.
 *
 * ★★ THE POINT OF SEPARATING IT (plan §14c). A disabled offer costs exactly
 * nothing, so its review can take as long as it needs; a live automatic offer
 * applies itself to every qualifying order from the instant it goes live. One
 * approval that both wrote the terms AND switched them on would collapse those
 * two very different decisions into one click.
 */
export function isActivationTool(tool: MinkDomainActionTool) {
  return tool === "activate_offer";
}

export function domainActionFields(
  tool: MinkDomainActionTool,
): readonly string[] {
  if (tool === "create_product") {
    return [
      "name",
      "slug",
      "description",
      "seo_title",
      "seo_description",
      "base_price",
      "selling_price",
      "image_url",
      "status",
      "track_inventory",
    ];
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    return [
      "code",
      "description",
      "discount_type",
      "discount_value",
      "min_order_amount",
      "max_uses",
      "valid_from",
      "valid_until",
      "status",
      "show_on_storefront",
      "audience",
    ];
  }
  if (
    tool === "create_offer" ||
    tool === "update_offer" ||
    tool === "activate_offer"
  ) {
    return [
      "name",
      "description",
      "reward_type",
      "reward_value",
      "min_subtotal",
      "budget",
      "max_redemptions",
      "valid_until",
      // ★ CARRIED IN THE FIELD LIST so the approval hash binds it. Create and
      // update pin it to "disabled"; only `activate_offer` moves it, and that
      // is the entire difference between the two decisions.
      "status",
    ];
  }
  return ["name", "description", "color"];
}

export const MINK_DOMAIN_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  slug: "URL slug",
  description: "Description",
  seo_title: "SEO title",
  seo_description: "SEO description",
  base_price: "Base price (INR)",
  selling_price: "Selling price (INR)",
  image_url: "Product image",
  status: "Status",
  track_inventory: "Inventory tracking",
  code: "Coupon code",
  discount_type: "Discount type",
  discount_value: "Discount value",
  min_order_amount: "Minimum order amount",
  max_uses: "Maximum uses",
  valid_from: "Valid from",
  valid_until: "Valid until",
  show_on_storefront: "Shown on storefront",
  audience: "Audience restrictions",
  color: "Colour",
};

export function draftValuesForDomainAction(
  tool: MinkDomainActionTool,
  content: MinkDraftContent,
): MinkDomainActionValues {
  const values: MinkDomainActionValues = Object.fromEntries(
    domainActionFields(tool).map((field) => [field, content[field] ?? null]),
  );
  if (tool === "create_product") {
    values.status = "draft";
    values.track_inventory = "disabled";
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    values.status = "disabled";
    values.show_on_storefront = "no";
    values.audience = "all customers (no group restriction)";
  }
  // ★★ CREATED AND UPDATED DISABLED, ALWAYS — pinned here rather than trusted
  // from the proposal, so a model that asks for an active offer gets a
  // disabled one and the approval screen says "disabled". Activation is a
  // separate approval (plan §14c). Not pinned for `activate_offer`, which is
  // the one tool whose whole job is to move this field.
  if (tool === "create_offer" || tool === "update_offer") {
    values.status = "disabled";
  }
  return values;
}
