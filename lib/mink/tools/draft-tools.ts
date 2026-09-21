import "server-only";

import { and, count, eq, sql } from "drizzle-orm";
import {
  coupons,
  inventoryLevels,
  products,
  productVariants,
  userGroups,
} from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { slugify } from "@/lib/slug";
import { limitsFor } from "@/lib/plans";
import { createMinkDraftProposal } from "../drafts";
import {
  INVENTORY_ADJUSTMENT_REASONS,
  MAX_MINK_BULK_INVENTORY_LINES,
} from "../draft-types";
import { MinkRequestError, MinkToolInputError } from "../errors";
import { can } from "@/app/dashboard/lib/permissions";
import type {
  MinkActorContext,
  MinkArtifact,
  MinkToolDeclaration,
} from "../types";
import {
  resolveMinkBulkInventoryTargets,
  type MinkBulkInventoryLookupInput,
} from "../bulk-inventory-targets";
import {
  assertMinkSpecialPriceSupported,
  MAX_MINK_BULK_PRICE_LINES,
  normalizeMinkPriceSet,
} from "../bulk-price-policy";
import {
  resolveMinkBulkPriceTargets,
  type MinkBulkPriceLookupInput,
  type MinkBulkPriceTarget,
} from "../bulk-price-targets";
import type { MinkTool } from "./registry";
import { resolveMinkLocation } from "./location-scope";
import {
  evaluateMinkOrderTransition,
  MINK_ORDER_STATUS_TARGETS,
  nextMinkOrderStatus,
} from "../order-status-policy";
import {
  minkOrderStatusSnapshot,
  normalizeMinkOrderReference,
  readMinkOrderStatusTarget,
} from "../order-status-target";
import { prepareMinkImageForDestination } from "../media-preparation";

const draftingAvailable = (actor: MinkActorContext) =>
  actor.draftingEnabled === true;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const currentProductAvailable = (actor: MinkActorContext) =>
  draftingAvailable(actor) && actor.selectedResource?.type === "product";
const customerGroupCreateAvailable = (actor: MinkActorContext) =>
  draftingAvailable(actor) && limitsFor(actor.effectivePlan).customerGroups;

export const proposeCurrentProductDescriptionTool: MinkTool = {
  declaration: {
    name: "propose_current_product_description",
    description:
      "Create a charged, private product-description proposal for the product currently selected in the dashboard. Use only supplied facts and the trusted brand voice. This does not edit or publish the product; the admin must separately save the private proposal.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Honest product description using only verified facts.",
          minLength: 1,
          maxLength: 3_000,
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: currentProductAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const product = await readCurrentProduct(actor);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_description",
        title: `Description for ${product.name}`,
        destinationType: "product",
        destinationId: product.id,
        destinationLabel: product.name,
        destinationPath: `/dashboard/products/${product.id}`,
        before: { description: product.description ?? "" },
        content: {
          description: readString(args.description, "description", 3_000),
        },
      }),
    );
  },
};

export const proposeCurrentProductSeoTool: MinkTool = {
  declaration: {
    name: "propose_current_product_seo",
    description:
      "Create a charged, private SEO-title and meta-description proposal for the product currently selected in the dashboard. Never invent product claims. This does not edit or publish the product.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        seo_title: {
          type: "string",
          minLength: 1,
          maxLength: 70,
          description: "Search title, at most 70 characters.",
        },
        seo_description: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          description: "Search description, at most 180 characters.",
        },
      },
      required: ["seo_title", "seo_description"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: currentProductAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const product = await readCurrentProduct(actor);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_seo",
        title: `SEO for ${product.name}`,
        destinationType: "product",
        destinationId: product.id,
        destinationLabel: product.name,
        destinationPath: `/dashboard/products/${product.id}`,
        before: {
          seo_title: product.seoTitle ?? "",
          seo_description: product.seoDescription ?? "",
        },
        content: {
          seo_title: readString(args.seo_title, "seo_title", 70),
          seo_description: readString(
            args.seo_description,
            "seo_description",
            180,
          ),
        },
      }),
    );
  },
};

/**
 * Whether ANY tool this actor is offered can return an image URL.
 *
 * ★★ THIS IS WHAT DECIDES THE COVER IS REQUIRED, NOT A CONSTANT. Every cover
 *    URL comes from a tool behind a permission `propose_blog_draft` does not
 *    require: `list_storefront_media` (media:view), `generate_storefront_image`
 *    (media:manage, which `can` resolves through media:view), the catalogue
 *    reads (products:view) and `search_storefront_categories`
 *    (categories:view). So an admin holding ONLY blogs:manage has no way to
 *    obtain one, and a flatly mandatory `cover_image_url` fails every blog
 *    proposal that role makes with "cover_image_url must be text." - an error
 *    naming an argument nothing on the platform could have given them.
 *
 * ★ IT NARROWS, IT NEVER WIDENS. A cover stays required for everybody who can
 *   produce one, which is the merchant-visible promise the Help guide makes;
 *   the coverless proposal is the fallback for a role that would otherwise be
 *   locked out of blog drafting entirely.
 */
function canSupplyBlogCover(actor: MinkActorContext): boolean {
  return (
    can(actor.permissions, "media", "view", actor.isSuperadmin) ||
    can(actor.permissions, "products", "view", actor.isSuperadmin) ||
    can(actor.permissions, "categories", "view", actor.isSuperadmin)
  );
}

const BLOG_COVER_REQUIRED_RULE =
  "EVERY new blog proposal requires a cover: unless the merchant supplied an exact image or explicitly chose an existing current-store image, generate one 16:9 editorial cover first, then pass its exact returned URL as cover_image_url in this same run. Never stop after saving the image to Media and never tell the merchant to attach it manually. The server preserves the whole source and prepares an exact 16:9 copy when needed.";

const BLOG_COVER_UNAVAILABLE_RULE =
  "This admin has no image permission, so no tool can return a cover URL for them: omit cover_image_url and propose the article without one. Never invent a URL, and do not tell the merchant to generate or attach an image you cannot reach.";

function blogDraftDeclaration(coverRequired: boolean): MinkToolDeclaration {
  return {
    name: "propose_blog_draft",
    description: `Create one charged, private and editable blog proposal in the store's brand voice. Call list_blogs first so the new article is grounded in the current blog catalogue and does not accidentally duplicate an existing post. ${coverRequired ? BLOG_COVER_REQUIRED_RULE : BLOG_COVER_UNAVAILABLE_RULE} Use only facts in the conversation or trusted tool results. This does not create or publish a blog post.`,
    parametersJsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        excerpt: { type: "string", minLength: 1, maxLength: 500 },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 12_000,
          description: "Plain Markdown blog body. Do not output HTML.",
        },
        cover_image_url: {
          type: "string",
          minLength: 1,
          maxLength: 2_048,
          description: coverRequired
            ? "Required exact current-store Media Library or catalogue image URL returned by a trusted read or image-generation tool. A blog-creation request includes its cover by default; never guess a URL or leave this out after generating the image."
            : "Unavailable to this admin, who holds no Media, Products or Categories View permission. Omit it rather than guessing a URL.",
        },
        seo_title: { type: "string", maxLength: 70 },
        seo_description: { type: "string", maxLength: 180 },
      },
      required: coverRequired
        ? ["title", "excerpt", "content", "cover_image_url"]
        : ["title", "excerpt", "content"],
      additionalProperties: false,
    },
  };
}

export const proposeBlogDraftTool: MinkTool = {
  declaration: blogDraftDeclaration(true),
  declarationFor: (actor) => blogDraftDeclaration(canSupplyBlogCover(actor)),
  permission: { section: "blogs", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 25_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const title = readString(args.title, "title", 200);
    // Re-derived from the actor, never from the declaration the model saw:
    // tool visibility is not authorization anywhere else here either.
    const coverRequired = canSupplyBlogCover(actor);
    const requestedCoverImageUrl = coverRequired
      ? readString(args.cover_image_url, "cover_image_url", 2_048)
      : readOptionalString(args.cover_image_url, "cover_image_url", 2_048);
    const coverImageUrl = requestedCoverImageUrl
      ? (
          await prepareMinkImageForDestination(
            actor,
            requestedCoverImageUrl,
            "blog_cover",
          )
        ).url
      : "";
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "blog",
        title: `Blog draft: ${title}`,
        destinationType: "blog",
        destinationLabel: "Blogs",
        destinationPath: "/dashboard/blogs",
        content: {
          title,
          excerpt: readString(args.excerpt, "excerpt", 500),
          content: readString(args.content, "content", 12_000),
          cover_image_url: coverImageUrl,
          seo_title: readOptionalString(args.seo_title, "seo_title", 70),
          seo_description: readOptionalString(
            args.seo_description,
            "seo_description",
            180,
          ),
        },
      }),
    );
  },
};

export const proposeCouponEmailTool: MinkTool = {
  declaration: {
    name: "propose_coupon_email",
    description:
      "Create a charged, private coupon-email proposal for an existing coupon in this store. First call get_coupon_for_draft, then pass its opaque coupon_snapshot unchanged. Pass the visible coupon code, never an ID. Do not claim the email was sent or scheduled.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        coupon_code: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Exact visible coupon code from the user or tool data.",
        },
        coupon_snapshot: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description:
            "Opaque snapshot returned by get_coupon_for_draft. Pass it unchanged.",
        },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 5_000,
          description: "Plain-text or Markdown email body; never raw HTML.",
        },
      },
      required: ["coupon_code", "coupon_snapshot", "subject", "body"],
      additionalProperties: false,
    },
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const code = readString(args.coupon_code, "coupon_code", 100);
    const coupon = await readCoupon(actor, code);
    const snapshot = readString(args.coupon_snapshot, "coupon_snapshot", 64);
    if (snapshot !== (await couponSnapshot(actor, coupon))) {
      throw new MinkToolInputError(
        "Coupon details changed or were not checked. Call get_coupon_for_draft again before drafting.",
      );
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_email",
        title: `Coupon email for ${coupon.code}`,
        destinationType: "coupon",
        destinationId: coupon.id,
        destinationLabel: `Coupon ${coupon.code}`,
        destinationPath: `/dashboard/marketing/coupons/${coupon.id}/edit`,
        before: { subject: "", body: "" },
        content: {
          subject: readString(args.subject, "subject", 200),
          body: readString(args.body, "body", 5_000),
        },
      }),
    );
  },
};

export const getCouponForDraftTool: MinkTool = {
  declaration: {
    name: "get_coupon_for_draft",
    description:
      "Read exact existing coupon facts before drafting a coupon email or coupon update. Returns an opaque coupon_snapshot that must be passed unchanged to the matching proposal tool. Never infer or alter coupon terms.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        coupon_code: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Exact visible coupon code, never an ID.",
        },
      },
      required: ["coupon_code"],
      additionalProperties: false,
    },
  },
  permission: { section: "marketing", action: "view" },
  available: draftingAvailable,
  timeoutMs: 5_000,
  async execute(actor, args) {
    const coupon = await readCoupon(
      actor,
      readString(args.coupon_code, "coupon_code", 100),
    );
    return {
      code: coupon.code,
      description: coupon.description,
      status: coupon.status,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      minimumOrderAmount: coupon.minOrderAmount,
      maximumUses: coupon.maxUses,
      validFrom: coupon.validFrom,
      validUntil: coupon.validUntil,
      showOnStorefront: coupon.showOnStorefront,
      coupon_snapshot: await couponSnapshot(actor, coupon),
    };
  },
};

export const proposeCustomerMessageTool: MinkTool = {
  declaration: {
    name: "propose_customer_message",
    description:
      "Create a charged, private reusable customer-message template. Do not accept customer identifiers or personal data, and do not claim it was sent. The admin must copy approved text into a normal StoreMink workflow.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        subject: { type: "string", maxLength: 200 },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          description:
            "Generic message body without a customer's email, phone, address, or account ID.",
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  permission: { section: "users", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_message",
        title: "Customer message template",
        destinationType: "customer_message",
        destinationLabel: "Customers",
        destinationPath: "/dashboard/users",
        content: {
          subject: readOptionalString(args.subject, "subject", 200),
          body: readString(args.body, "body", 4_000),
        },
      }),
    );
  },
};

export const proposeProductCreateTool: MinkTool = {
  declaration: {
    name: "propose_product_create",
    description:
      "Create a charged, private proposal for a new draft product. The proposal can later create only an unpublished product with inventory tracking disabled; it cannot publish, add stock, variants, categories or tax/shipping settings. When the composer supplies an exact saved image URL with the request, pass that exact source as image_url; the server analyses its dimensions, preserves the complete authentic photo and automatically prepares a square product canvas when needed before storing the proposal. Never invent, omit or substitute an attached product image URL.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", minLength: 1, maxLength: 3_000 },
        seo_title: { type: "string", minLength: 1, maxLength: 70 },
        seo_description: { type: "string", minLength: 1, maxLength: 180 },
        base_price: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 99_999_999.99,
        },
        selling_price: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 99_999_999.99,
        },
        image_url: {
          type: "string",
          maxLength: 2048,
          description:
            "Optional exact store-owned Media Library URL supplied with the current user message.",
        },
      },
      required: [
        "name",
        "description",
        "seo_title",
        "seo_description",
        "base_price",
        "selling_price",
      ],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 25_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    await assertProductProposalCapacity(actor);
    const name = readString(args.name, "name", 200);
    const proposedSlug = slugify(name).slice(0, 200);
    if (!proposedSlug) {
      throw new MinkToolInputError(
        "The product name must contain letters or numbers so StoreMink can create a URL slug.",
      );
    }
    const requestedImageUrl = readOptionalString(
      args.image_url,
      "image_url",
      2_048,
    );
    const imageUrl = requestedImageUrl
      ? (
          await prepareMinkImageForDestination(
            actor,
            requestedImageUrl,
            "product_photo",
          )
        ).url
      : "";
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_create",
        title: `New draft product: ${name}`,
        destinationType: "product",
        destinationLabel: "New draft product",
        destinationPath: "/dashboard/products/new",
        content: {
          name,
          slug: proposedSlug,
          description: readString(args.description, "description", 3_000),
          seo_title: readString(args.seo_title, "seo_title", 70),
          seo_description: readString(
            args.seo_description,
            "seo_description",
            180,
          ),
          base_price: readNumberString(args.base_price, "base_price"),
          selling_price: readNumberString(args.selling_price, "selling_price"),
          image_url: imageUrl,
        },
      }),
    );
  },
};

export const proposeCouponCreateTool: MinkTool = {
  declaration: {
    name: "propose_coupon_create",
    description:
      "Create a charged, private proposal for a new coupon. Any later approved action creates it disabled, hidden from the storefront, unused and unrestricted; this tool cannot activate or publish it.",
    parametersJsonSchema: couponActionSchema(false),
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const content = couponProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_create",
        title: `New disabled coupon: ${content.code}`,
        destinationType: "coupon",
        destinationLabel: `New coupon ${content.code}`,
        destinationPath: "/dashboard/marketing/coupons/new",
        content,
      }),
    );
  },
};

export const proposeCouponUpdateTool: MinkTool = {
  declaration: {
    name: "propose_coupon_update",
    description:
      "Create a charged, private proposal to edit the terms of an existing disabled coupon. First call get_coupon_for_draft and pass its coupon_snapshot unchanged. This cannot activate, publish, restrict, send or change usage for a coupon.",
    parametersJsonSchema: couponActionSchema(true),
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const currentCode = readString(
      args.current_coupon_code,
      "current_coupon_code",
      100,
    );
    const coupon = await readCoupon(actor, currentCode);
    if (coupon.status !== "disabled" || coupon.showOnStorefront) {
      throw new MinkToolInputError(
        "Coupon terms can be proposed for a live action only after the coupon is disabled and hidden from the storefront.",
      );
    }
    const snapshot = readString(args.coupon_snapshot, "coupon_snapshot", 64);
    if (snapshot !== (await couponSnapshot(actor, coupon))) {
      throw new MinkToolInputError(
        "Coupon details changed or were not checked. Call get_coupon_for_draft again before proposing an update.",
      );
    }
    const content = couponProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_update",
        title: `Update disabled coupon ${coupon.code}`,
        destinationType: "coupon",
        destinationId: coupon.id,
        destinationLabel: `Coupon ${coupon.code}`,
        destinationPath: `/dashboard/marketing/coupons/${coupon.id}/edit`,
        before: couponDraftValues(coupon),
        content,
      }),
    );
  },
};

export const getCustomerGroupForDraftTool: MinkTool = {
  declaration: {
    name: "get_customer_group_for_draft",
    description:
      "Read an exact customer group by visible name before proposing a metadata update. Returns an opaque group_snapshot. This does not return or change group membership.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        group_name: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["group_name"],
      additionalProperties: false,
    },
  },
  permission: { section: "users", action: "view" },
  available: draftingAvailable,
  timeoutMs: 5_000,
  async execute(actor, args) {
    const group = await readCustomerGroup(
      actor,
      readString(args.group_name, "group_name", 120),
    );
    return {
      name: group.name,
      description: group.description,
      color: group.color,
      group_snapshot: await customerGroupSnapshot(actor, group),
    };
  },
};

export const proposeCustomerGroupCreateTool: MinkTool = {
  declaration: {
    name: "propose_customer_group_create",
    description:
      "Create a charged, private proposal for new customer-group metadata. This does not add customers, restrict coupons or contact anyone.",
    parametersJsonSchema: customerGroupSchema(false),
  },
  permission: { section: "users", action: "manage" },
  available: customerGroupCreateAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const content = customerGroupProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_group_create",
        title: `New customer group: ${content.name}`,
        destinationType: "customer_group",
        destinationLabel: `New group ${content.name}`,
        destinationPath: "/dashboard/users/user_groups/new",
        content,
      }),
    );
  },
};

export const proposeCustomerGroupUpdateTool: MinkTool = {
  declaration: {
    name: "propose_customer_group_update",
    description:
      "Create a charged, private proposal to update an existing customer group's name, description or colour. First call get_customer_group_for_draft and pass group_snapshot unchanged. This cannot change membership, coupon audiences or contact customers.",
    parametersJsonSchema: customerGroupSchema(true),
  },
  permission: { section: "users", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const currentName = readString(
      args.current_group_name,
      "current_group_name",
      120,
    );
    const group = await readCustomerGroup(actor, currentName);
    const snapshot = readString(args.group_snapshot, "group_snapshot", 64);
    if (snapshot !== (await customerGroupSnapshot(actor, group))) {
      throw new MinkToolInputError(
        "Customer-group details changed or were not checked. Call get_customer_group_for_draft again before proposing an update.",
      );
    }
    const content = customerGroupProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_group_update",
        title: `Update customer group ${group.name}`,
        destinationType: "customer_group",
        destinationId: group.id,
        destinationLabel: `Customer group ${group.name}`,
        destinationPath: `/dashboard/users/user_groups/${group.id}/edit`,
        before: customerGroupDraftValues(group),
        content,
      }),
    );
  },
};

export const getInventoryItemForAdjustmentTool: MinkTool = {
  declaration: {
    name: "get_inventory_item_for_adjustment",
    description:
      "Read one exact tracked SKU at one exact accessible active location before proposing an inventory adjustment. Use an exact SKU returned by a trusted StoreMink tool and a visible location name; never use IDs. Returns an opaque inventory_snapshot that must be passed unchanged.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        product_sku: { type: "string", minLength: 1, maxLength: 100 },
        location_name: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["product_sku", "location_name"],
      additionalProperties: false,
    },
  },
  permission: { section: "inventory", action: "view" },
  available: draftingAvailable,
  timeoutMs: 7_000,
  async execute(actor, args) {
    const target = await readInventoryAdjustmentTarget(
      actor,
      readString(args.product_sku, "product_sku", 100),
      args.location_name,
    );
    return {
      product: target.productName,
      variant: target.variantName,
      sku: target.sku,
      location: target.locationName,
      on_hand: target.onHand,
      reserved: target.reserved,
      available: target.onHand - target.reserved,
      inventory_snapshot: await inventorySnapshot(actor, target),
      dataAsOf: new Date().toISOString(),
    };
  },
};

export const proposeInventoryAdjustmentTool: MinkTool = {
  declaration: {
    name: "propose_inventory_adjustment",
    description:
      "Create a charged private proposal to add/remove a bounded whole-number quantity or set an absolute on-hand target for one exact tracked SKU at one exact location. First call get_inventory_item_for_adjustment and pass its inventory_snapshot unchanged. Supply exactly one of quantity_change or target_quantity. This never changes stock; a human must save, review and approve the exact adjustment separately.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        product_sku: { type: "string", minLength: 1, maxLength: 100 },
        location_name: { type: "string", minLength: 1, maxLength: 100 },
        inventory_snapshot: { type: "string", minLength: 64, maxLength: 64 },
        quantity_change: {
          type: "integer",
          minimum: -1_000_000,
          maximum: 1_000_000,
          description:
            "Signed non-zero quantity: positive adds, negative removes.",
        },
        target_quantity: {
          type: "integer",
          minimum: 0,
          maximum: 2_147_483_647,
          description:
            "Optional absolute resulting on-hand quantity. Supply exactly one of target_quantity or quantity_change.",
        },
        reason: {
          type: "string",
          enum: [...INVENTORY_ADJUSTMENT_REASONS],
        },
        note: { type: "string", maxLength: 200 },
      },
      required: [
        "product_sku",
        "location_name",
        "inventory_snapshot",
        "reason",
      ],
      additionalProperties: false,
    },
  },
  permission: { section: "inventory", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const sku = readString(args.product_sku, "product_sku", 100);
    const target = await readInventoryAdjustmentTarget(
      actor,
      sku,
      args.location_name,
    );
    const snapshot = readString(
      args.inventory_snapshot,
      "inventory_snapshot",
      64,
    );
    if (snapshot !== (await inventorySnapshot(actor, target))) {
      throw new MinkToolInputError(
        "The SKU, location or stock checkpoint changed or was not checked. Read the inventory item again before proposing an adjustment.",
      );
    }
    const quantityChange = resolveInventoryQuantityChange(
      args.quantity_change,
      args.target_quantity,
      target.onHand,
    );
    const reason = readString(args.reason, "reason", 20);
    if (!INVENTORY_ADJUSTMENT_REASONS.includes(reason as never)) {
      throw new MinkToolInputError(
        `reason must be one of: ${INVENTORY_ADJUSTMENT_REASONS.join(", ")}.`,
      );
    }
    const note = readOptionalString(args.note, "note", 200);
    if (reason === "other" && !note) {
      throw new MinkToolInputError("note is required when reason is other.");
    }
    const resulting = target.onHand + quantityChange;
    if (resulting < 0) {
      throw new MinkToolInputError(
        `This would reduce ${target.sku} below zero at ${target.locationName}. Propose a smaller removal.`,
      );
    }
    if (resulting < target.reserved) {
      throw new MinkToolInputError(
        `This would reduce ${target.sku} below its ${target.reserved} reserved units at ${target.locationName}. Resolve reservations in the manual inventory workflow first.`,
      );
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "inventory_adjustment",
        title: `Adjust ${target.sku} at ${target.locationName}`,
        destinationType: "inventory",
        destinationId: target.productId,
        destinationLocationId: target.locationId,
        destinationVariantId: target.variantId,
        destinationLabel: `${target.productName}${target.variantName ? ` · ${target.variantName}` : ""} (${target.sku}) at ${target.locationName}`,
        destinationPath: `/dashboard/inventory?location=${encodeURIComponent(target.locationId)}`,
        content: {
          quantity_change: String(quantityChange),
          reason,
          note,
        },
      }),
    );
  },
};

const bulkLookupLineSchema = {
  type: "object",
  properties: {
    product_sku: { type: "string", minLength: 1, maxLength: 100 },
    location_name: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["product_sku", "location_name"],
  additionalProperties: false,
};

export const getInventoryItemsForBulkAdjustmentTool: MinkTool = {
  declaration: {
    name: "get_inventory_items_for_bulk_adjustment",
    description:
      "Read 1-20 exact tracked SKU/location pairs in one bounded request before a bulk inventory proposal. Returns each line as ready with an opaque inventory_snapshot, or a line-specific validation error. Never use IDs and never silently replace a missing line.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MINK_BULK_INVENTORY_LINES,
          items: bulkLookupLineSchema,
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  permission: { section: "inventory", action: "view" },
  available: draftingAvailable,
  timeoutMs: 10_000,
  async execute(actor, args) {
    const inputs = readBulkLookupLines(args.lines);
    const resolved = await withActor(actor, (db) =>
      resolveMinkBulkInventoryTargets(db, actor, inputs),
    );
    return {
      status: resolved.every((line) => !line.error)
        ? "ready"
        : "needs_correction",
      max_lines: MAX_MINK_BULK_INVENTORY_LINES,
      lines: await Promise.all(
        resolved.map(async (line) =>
          line.error
            ? {
                line: line.line,
                sku: line.input.sku,
                location: line.input.locationName,
                status: "error",
                error_code: line.error.code,
                error: line.error.message,
              }
            : {
                line: line.line,
                product: line.target.productName,
                variant: line.target.variantName,
                sku: line.target.sku,
                location: line.target.locationName,
                on_hand: line.target.onHand,
                reserved: line.target.reserved,
                available: line.target.onHand - line.target.reserved,
                status: "ready",
                inventory_snapshot: await bulkInventorySnapshot(
                  actor,
                  line.target,
                ),
              },
        ),
      ),
      dataAsOf: new Date().toISOString(),
    };
  },
};

const bulkProposalLineSchema = {
  type: "object",
  properties: {
    ...bulkLookupLineSchema.properties,
    inventory_snapshot: { type: "string", minLength: 64, maxLength: 64 },
    quantity_change: {
      type: "integer",
      minimum: -1_000_000,
      maximum: 1_000_000,
    },
    target_quantity: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    reason: { type: "string", enum: [...INVENTORY_ADJUSTMENT_REASONS] },
    note: { type: "string", maxLength: 200 },
  },
  required: ["product_sku", "location_name", "inventory_snapshot", "reason"],
  additionalProperties: false,
};

export const proposeBulkInventoryAdjustmentTool: MinkTool = {
  declaration: {
    name: "propose_bulk_inventory_adjustment",
    description:
      "Create a charged private proposal for 1-20 exact SKU/location inventory adjustments. First call get_inventory_items_for_bulk_adjustment and pass every returned snapshot unchanged. Each line supplies exactly one signed quantity_change or absolute target_quantity plus its reason. Invalid lines are reported individually and no proposal is created until every line is valid. This never changes stock; a human must save, review and approve the whole atomic batch.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MINK_BULK_INVENTORY_LINES,
          items: bulkProposalLineSchema,
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  permission: { section: "inventory", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 10_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const lines = readBulkProposalLines(args.lines);
    const inputs = lines.map((line) => ({
      sku: line.sku,
      locationName: line.location,
    }));
    const resolved = await withActor(actor, (db) =>
      resolveMinkBulkInventoryTargets(db, actor, inputs),
    );
    const errors: Array<Record<string, unknown>> = [];
    const contentLines: Array<Record<string, unknown>> = [];
    for (const result of resolved) {
      const input = lines[result.line - 1];
      if (!input) throw new MinkToolInputError("A bulk line is unavailable.");
      if (result.error) {
        errors.push({
          line: result.line,
          sku: input.sku,
          location: input.location,
          code: result.error.code,
          message: result.error.message,
        });
        continue;
      }
      if (
        input.snapshot !== (await bulkInventorySnapshot(actor, result.target))
      ) {
        errors.push({
          line: result.line,
          sku: input.sku,
          location: input.location,
          code: "snapshot_conflict",
          message:
            "The SKU, location or stock checkpoint changed. Read this line again.",
        });
        continue;
      }
      let quantityChange: number;
      try {
        quantityChange = resolveInventoryQuantityChange(
          input.quantityChange,
          input.targetQuantity,
          result.target.onHand,
        );
      } catch (error) {
        errors.push({
          line: result.line,
          sku: input.sku,
          location: input.location,
          code: "quantity_invalid",
          message: error instanceof Error ? error.message : "Invalid quantity.",
        });
        continue;
      }
      const resulting = result.target.onHand + quantityChange;
      if (
        resulting < 0 ||
        resulting < result.target.reserved ||
        resulting > MAX_POSTGRES_INTEGER
      ) {
        errors.push({
          line: result.line,
          sku: input.sku,
          location: input.location,
          code: "stock_invariant",
          message:
            resulting < 0
              ? "The adjustment would reduce on-hand stock below zero."
              : resulting < result.target.reserved
                ? `The adjustment would reduce on-hand stock below ${result.target.reserved} reserved units.`
                : "The resulting stock is outside the supported range.",
        });
        continue;
      }
      contentLines.push({
        sku: result.target.sku,
        location: result.target.locationName,
        quantity_change: quantityChange,
        reason: input.reason,
        note: input.note,
      });
    }
    if (errors.length) {
      return {
        status: "needs_correction",
        proposal_created: false,
        valid_lines: contentLines.length,
        invalid_lines: errors.length,
        line_errors: errors,
      };
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "bulk_inventory_adjustment",
        title: `Bulk inventory adjustment · ${contentLines.length} lines`,
        destinationType: "inventory_bulk",
        destinationLabel: `${contentLines.length} inventory adjustments`,
        destinationPath: "/dashboard/inventory",
        content: { lines_json: JSON.stringify(contentLines) },
      }),
    );
  },
};

const bulkPriceLookupLineSchema = {
  type: "object",
  properties: {
    product_sku: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["product_sku"],
  additionalProperties: false,
};

export const getProductsForBulkPriceUpdateTool: MinkTool = {
  declaration: {
    name: "get_products_for_bulk_price_update",
    description:
      "Read 1-20 exact sellable product or variant SKUs before a bulk price proposal. Returns authoritative MRP, selling, special and effective prices plus an opaque price_snapshot. A parent product with variants is rejected; use every exact variant SKU. This never changes prices.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MINK_BULK_PRICE_LINES,
          items: bulkPriceLookupLineSchema,
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "view" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  async execute(actor, args) {
    const inputs = readBulkPriceLookupLines(args.lines);
    const resolved = await withActor(actor, (db) =>
      resolveMinkBulkPriceTargets(db, actor, inputs),
    );
    return {
      status: resolved.every((line) => !line.error)
        ? "ready"
        : "needs_correction",
      currency: actor.currency,
      max_lines: MAX_MINK_BULK_PRICE_LINES,
      lines: await Promise.all(
        resolved.map(async (line) =>
          line.error
            ? {
                line: line.line,
                sku: line.input.sku,
                status: "error",
                error_code: line.error.code,
                error: line.error.message,
              }
            : {
                line: line.line,
                product: line.target.productName,
                variant: line.target.variantName,
                sku: line.target.sku,
                publication_status: line.target.publicationStatus,
                base_price: line.target.basePrice,
                selling_price: line.target.sellingPrice,
                special_price: line.target.specialPrice,
                special_price_supported: line.target.supportsSpecialPrice,
                effective_price: line.target.effectivePrice,
                status: "ready",
                price_snapshot: await bulkPriceSnapshot(actor, line.target),
              },
        ),
      ),
      dataAsOf: new Date().toISOString(),
    };
  },
};

const bulkPriceProposalLineSchema = {
  type: "object",
  properties: {
    ...bulkPriceLookupLineSchema.properties,
    price_snapshot: { type: "string", minLength: 64, maxLength: 64 },
    base_price: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
    },
    selling_price: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
    },
    special_price_mode: {
      type: "string",
      enum: ["keep", "clear", "set"],
      description:
        "Keep the current special price, clear it, or set an explicit special_price.",
    },
    special_price: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
    },
  },
  required: [
    "product_sku",
    "price_snapshot",
    "base_price",
    "selling_price",
    "special_price_mode",
  ],
  additionalProperties: false,
};

export const proposeBulkPriceUpdateTool: MinkTool = {
  declaration: {
    name: "propose_bulk_price_update",
    description:
      "Create a charged private proposal for 1-20 exact sellable SKU price changes. First call get_products_for_bulk_price_update and pass every price_snapshot unchanged. Each line must supply the complete final MRP and selling price, and explicitly keep, clear or set its special price. The server enforces MRP >= selling >= special and reports every invalid line; it creates no proposal until all lines are valid. This never changes a live price. A human must save, review the unit-basket impact summary and approve the whole atomic batch.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MINK_BULK_PRICE_LINES,
          items: bulkPriceProposalLineSchema,
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 10_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const lines = readBulkPriceProposalLines(args.lines);
    const resolved = await withActor(actor, (db) =>
      resolveMinkBulkPriceTargets(
        db,
        actor,
        lines.map((line) => ({ sku: line.sku })),
      ),
    );
    const errors: Array<Record<string, unknown>> = [];
    const contentLines: Array<Record<string, string>> = [];
    for (const result of resolved) {
      const input = lines[result.line - 1];
      if (!input) throw new MinkToolInputError("A bulk price line is missing.");
      if (result.error) {
        errors.push({
          line: result.line,
          sku: input.sku,
          code: result.error.code,
          message: result.error.message,
        });
        continue;
      }
      if (input.snapshot !== (await bulkPriceSnapshot(actor, result.target))) {
        errors.push({
          line: result.line,
          sku: input.sku,
          code: "snapshot_conflict",
          message: "The SKU or current price changed. Read this line again.",
        });
        continue;
      }
      if (input.specialMode !== "set" && input.specialPrice !== undefined) {
        errors.push({
          line: result.line,
          sku: input.sku,
          code: "special_price_invalid",
          message:
            "special_price may be supplied only when special_price_mode is set.",
        });
        continue;
      }
      const special =
        input.specialMode === "keep"
          ? result.target.specialPrice
          : input.specialMode === "clear"
            ? null
            : input.specialPrice;
      try {
        const prices = normalizeMinkPriceSet(
          input.basePrice,
          input.sellingPrice,
          special,
          `Line ${result.line} (${input.sku})`,
        );
        assertMinkSpecialPriceSupported(
          prices.specialPrice,
          result.target.supportsSpecialPrice,
          `Line ${result.line} (${input.sku})`,
        );
        if (
          prices.basePrice === result.target.basePrice &&
          prices.sellingPrice === result.target.sellingPrice &&
          prices.specialPrice === result.target.specialPrice
        ) {
          errors.push({
            line: result.line,
            sku: input.sku,
            code: "no_price_change",
            message: "The proposed prices are identical to the current prices.",
          });
          continue;
        }
        contentLines.push({
          sku: result.target.sku,
          base_price: prices.basePrice,
          selling_price: prices.sellingPrice,
          special_price: prices.specialPrice ?? "",
        });
      } catch (error) {
        errors.push({
          line: result.line,
          sku: input.sku,
          code: "price_invalid",
          message: error instanceof Error ? error.message : "Invalid price.",
        });
      }
    }
    if (errors.length) {
      return {
        status: "needs_correction",
        proposal_created: false,
        valid_lines: contentLines.length,
        invalid_lines: errors.length,
        line_errors: errors,
      };
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "bulk_price_update",
        title: `Bulk price update · ${contentLines.length} SKUs`,
        destinationType: "price_bulk",
        destinationLabel: `${contentLines.length} SKU price changes`,
        destinationPath: "/dashboard/products",
        content: { lines_json: JSON.stringify(contentLines) },
      }),
    );
  },
};

export const getOrderForStatusTransitionTool: MinkTool = {
  declaration: {
    name: "get_order_for_status_transition",
    description:
      "Read one exact visible order reference before proposing a guarded forward status transition. Returns the only supported next status and an opaque order_snapshot. It never changes an order and never accepts an internal order ID.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        order_ref: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description:
            "Exact visible StoreMink order reference from the user or a trusted order tool.",
        },
      },
      required: ["order_ref"],
      additionalProperties: false,
    },
  },
  permission: { section: "orders", action: "view" },
  available: draftingAvailable,
  timeoutMs: 7_000,
  async execute(actor, args) {
    const reference = normalizeMinkOrderReference(args.order_ref);
    const order = await readOrderStatusTargetForTool(actor, reference);
    const nextStatus = nextMinkOrderStatus(order.status);
    const decision = nextStatus
      ? evaluateMinkOrderTransition(order, nextStatus)
      : evaluateMinkOrderTransition(order, "unsupported");
    return {
      order_ref: order.reference,
      current_status: order.status,
      next_status: decision.allowed ? decision.targetStatus : null,
      eligible: decision.allowed,
      blocked_reason: decision.allowed ? null : decision.message,
      payment_status: order.paymentStatus,
      payment_method: order.paymentMethod,
      sales_channel: order.salesChannel,
      fulfilment_type: order.fulfilmentType,
      location: order.locationName ?? "Unassigned",
      latest_shipment_status: order.shipmentStatus,
      order_snapshot: await minkOrderStatusSnapshot(actor, order),
      dataAsOf: new Date().toISOString(),
    };
  },
};

export const proposeOrderStatusTransitionTool: MinkTool = {
  declaration: {
    name: "propose_order_status_transition",
    description:
      "Create a charged private proposal for one exact eligible delivery order to move exactly one forward step: pending to processing, processing to shipped, or shipped to delivered. First call get_order_for_status_transition and pass order_snapshot unchanged. This does not change the order, payment, shipment, cancellation, inventory or customer communications; a human must save, review and approve separately.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        order_ref: { type: "string", minLength: 1, maxLength: 80 },
        order_snapshot: { type: "string", minLength: 64, maxLength: 64 },
        target_status: {
          type: "string",
          enum: [...MINK_ORDER_STATUS_TARGETS],
        },
        note: {
          type: "string",
          maxLength: 200,
          description:
            "Optional internal audit note. Never include credentials, payment data or customer secrets.",
        },
      },
      required: ["order_ref", "order_snapshot", "target_status"],
      additionalProperties: false,
    },
  },
  permission: { section: "orders", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const reference = normalizeMinkOrderReference(args.order_ref);
    const order = await readOrderStatusTargetForTool(actor, reference);
    const snapshot = readString(args.order_snapshot, "order_snapshot", 64);
    if (snapshot !== (await minkOrderStatusSnapshot(actor, order))) {
      throw new MinkToolInputError(
        "The order checkpoint changed or was not checked. Read the exact order again before proposing a status transition.",
      );
    }
    const targetStatus = readString(args.target_status, "target_status", 20);
    const decision = evaluateMinkOrderTransition(order, targetStatus);
    if (!decision.allowed) throw new MinkToolInputError(decision.message);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "order_status_transition",
        title: `Advance ${order.reference} to ${decision.targetStatus}`,
        destinationType: "order",
        destinationId: order.id,
        destinationLabel: order.reference,
        destinationPath: `/dashboard/orders?q=${encodeURIComponent(order.reference)}`,
        before: { target_status: order.status, note: "" },
        content: {
          target_status: decision.targetStatus,
          note: readOptionalString(args.note, "note", 200),
        },
      }),
    );
  },
};

export const minkDraftTools = [
  proposeCurrentProductDescriptionTool,
  proposeCurrentProductSeoTool,
  proposeBlogDraftTool,
  getCouponForDraftTool,
  proposeCouponEmailTool,
  proposeCustomerMessageTool,
  proposeProductCreateTool,
  proposeCouponCreateTool,
  proposeCouponUpdateTool,
  getCustomerGroupForDraftTool,
  proposeCustomerGroupCreateTool,
  proposeCustomerGroupUpdateTool,
  getInventoryItemForAdjustmentTool,
  proposeInventoryAdjustmentTool,
  getInventoryItemsForBulkAdjustmentTool,
  proposeBulkInventoryAdjustmentTool,
  getProductsForBulkPriceUpdateTool,
  proposeBulkPriceUpdateTool,
  getOrderForStatusTransitionTool,
  proposeOrderStatusTransitionTool,
];

async function readOrderStatusTargetForTool(
  actor: MinkActorContext,
  reference: string,
) {
  try {
    return await withActor(actor, (db) =>
      readMinkOrderStatusTarget(db, actor, { orderRef: reference }),
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      throw new MinkToolInputError(error.message);
    }
    throw error;
  }
}

type BulkProposalInput = {
  sku: string;
  location: string;
  snapshot: string;
  quantityChange: unknown;
  targetQuantity: unknown;
  reason: string;
  note: string;
};

type BulkPriceProposalInput = {
  sku: string;
  snapshot: string;
  basePrice: unknown;
  sellingPrice: unknown;
  specialMode: "keep" | "clear" | "set";
  specialPrice: unknown;
};

function readBulkPriceLookupLines(value: unknown): MinkBulkPriceLookupInput[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MINK_BULK_PRICE_LINES
  ) {
    throw new MinkToolInputError(
      `lines must contain 1-${MAX_MINK_BULK_PRICE_LINES} items.`,
    );
  }
  return value.map((item, index) => {
    const row = readBulkObject(item, index, ["product_sku"]);
    return {
      sku: readString(row.product_sku, `lines[${index}].product_sku`, 100),
    };
  });
}

function readBulkPriceProposalLines(value: unknown): BulkPriceProposalInput[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MINK_BULK_PRICE_LINES
  ) {
    throw new MinkToolInputError(
      `lines must contain 1-${MAX_MINK_BULK_PRICE_LINES} items.`,
    );
  }
  return value.map((item, index) => {
    const row = readBulkObject(item, index, [
      "product_sku",
      "price_snapshot",
      "base_price",
      "selling_price",
      "special_price_mode",
      "special_price",
    ]);
    if (
      row.special_price_mode !== "keep" &&
      row.special_price_mode !== "clear" &&
      row.special_price_mode !== "set"
    ) {
      throw new MinkToolInputError(
        `lines[${index}].special_price_mode must be keep, clear or set.`,
      );
    }
    if (row.special_price_mode === "set" && row.special_price === undefined) {
      throw new MinkToolInputError(
        `lines[${index}].special_price is required when special_price_mode is set.`,
      );
    }
    return {
      sku: readString(row.product_sku, `lines[${index}].product_sku`, 100),
      snapshot: readString(
        row.price_snapshot,
        `lines[${index}].price_snapshot`,
        64,
      ),
      basePrice: row.base_price,
      sellingPrice: row.selling_price,
      specialMode: row.special_price_mode,
      specialPrice: row.special_price,
    };
  });
}

function readBulkLookupLines(value: unknown): MinkBulkInventoryLookupInput[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MINK_BULK_INVENTORY_LINES
  ) {
    throw new MinkToolInputError(
      `lines must contain 1-${MAX_MINK_BULK_INVENTORY_LINES} items.`,
    );
  }
  return value.map((item, index) => {
    const row = readBulkObject(item, index, ["product_sku", "location_name"]);
    return {
      sku: readString(row.product_sku, `lines[${index}].product_sku`, 100),
      locationName: readString(
        row.location_name,
        `lines[${index}].location_name`,
        100,
      ),
    };
  });
}

function readBulkProposalLines(value: unknown): BulkProposalInput[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MINK_BULK_INVENTORY_LINES
  ) {
    throw new MinkToolInputError(
      `lines must contain 1-${MAX_MINK_BULK_INVENTORY_LINES} items.`,
    );
  }
  return value.map((item, index) => {
    const row = readBulkObject(item, index, [
      "product_sku",
      "location_name",
      "inventory_snapshot",
      "quantity_change",
      "target_quantity",
      "reason",
      "note",
    ]);
    const reason = readString(row.reason, `lines[${index}].reason`, 20);
    if (!INVENTORY_ADJUSTMENT_REASONS.includes(reason as never)) {
      throw new MinkToolInputError(
        `lines[${index}].reason must be one of: ${INVENTORY_ADJUSTMENT_REASONS.join(", ")}.`,
      );
    }
    const note = readOptionalString(row.note, `lines[${index}].note`, 200);
    if (reason === "other" && !note) {
      throw new MinkToolInputError(
        `lines[${index}].note is required when reason is other.`,
      );
    }
    return {
      sku: readString(row.product_sku, `lines[${index}].product_sku`, 100),
      location: readString(
        row.location_name,
        `lines[${index}].location_name`,
        100,
      ),
      snapshot: readString(
        row.inventory_snapshot,
        `lines[${index}].inventory_snapshot`,
        64,
      ),
      quantityChange: row.quantity_change,
      targetQuantity: row.target_quantity,
      reason,
      note,
    };
  });
}

function readBulkObject(
  value: unknown,
  index: number,
  allowed: string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MinkToolInputError(`lines[${index}] must be an object.`);
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new MinkToolInputError(
      `lines[${index}] contains unsupported fields.`,
    );
  }
  return row;
}

function bulkInventorySnapshot(
  actor: MinkActorContext,
  target: {
    productId: string;
    variantId: string | null;
    locationId: string;
    sku: string;
    onHand: number;
    reserved: number;
    version: string | null;
  },
) {
  return sha256([
    actor.storeId,
    actor.adminId,
    target.productId,
    target.variantId,
    target.locationId,
    target.sku,
    target.onHand,
    target.reserved,
    target.version,
  ]);
}

function bulkPriceSnapshot(
  actor: MinkActorContext,
  target: MinkBulkPriceTarget,
) {
  return sha256([
    actor.storeId,
    actor.adminId,
    target.productId,
    target.variantId,
    target.sku,
    target.productVersion,
    target.basePrice,
    target.sellingPrice,
    target.specialPrice,
  ]);
}

async function readInventoryAdjustmentTarget(
  actor: MinkActorContext,
  sku: string,
  locationValue: unknown,
) {
  const location = await resolveMinkLocation(actor, locationValue);
  if (!location.selectedId) {
    throw new MinkToolInputError(
      "An exact accessible location_name is required for an inventory adjustment.",
    );
  }
  const locationId = location.selectedId;
  return withActor(actor, async (db) => {
    const variantRows = await db
      .select({
        productId: products.id,
        productName: products.name,
        productTracked: products.trackInventory,
        variantId: productVariants.id,
        variantName: productVariants.name,
        sku: productVariants.sku,
        variantTracked: productVariants.trackInventory,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.storeId, actor.storeId),
          eq(products.storeId, actor.storeId),
          eq(productVariants.sku, sku),
        ),
      )
      .limit(1);
    const productRows = await db
      .select({
        productId: products.id,
        productName: products.name,
        sku: products.sku,
        productTracked: products.trackInventory,
        hasVariants: sql<boolean>`exists (
          select 1 from public.product_variants pv
          where pv.product_id = ${products.id} and pv.store_id = ${actor.storeId}::uuid
        )`,
      })
      .from(products)
      .where(and(eq(products.storeId, actor.storeId), eq(products.sku, sku)))
      .limit(1);
    if (variantRows[0] && productRows[0]) {
      throw new MinkToolInputError(
        "That SKU is ambiguous between a product and a variant. Fix the duplicate SKU before using Mink inventory actions.",
      );
    }
    const variant = variantRows[0];
    const product = productRows[0];
    if (!variant && !product) {
      throw new MinkToolInputError(
        "That exact SKU was not found in the current store. Search products first and use the returned SKU.",
      );
    }
    if (product?.hasVariants) {
      throw new MinkToolInputError(
        "That product has variants. Choose one exact variant SKU for the inventory adjustment.",
      );
    }
    if (
      (variant && (!variant.productTracked || !variant.variantTracked)) ||
      (product && !product.productTracked)
    ) {
      throw new MinkToolInputError(
        "That SKU is not inventory-tracked, so Mink cannot adjust its stock.",
      );
    }
    const productId = variant?.productId ?? product!.productId;
    const variantId = variant?.variantId ?? null;
    const levels = await db
      .select({
        onHand: inventoryLevels.onHand,
        reserved: inventoryLevels.reserved,
        updatedAt: inventoryLevels.updatedAt,
      })
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.storeId, actor.storeId),
          eq(inventoryLevels.locationId, locationId),
          eq(inventoryLevels.productId, productId),
          variantId
            ? eq(inventoryLevels.variantId, variantId)
            : sql`${inventoryLevels.variantId} is null`,
        ),
      )
      .limit(1);
    return {
      productId,
      variantId,
      productName: variant?.productName ?? product!.productName,
      variantName: variant?.variantName ?? null,
      sku: variant?.sku ?? product!.sku!,
      locationId,
      locationName: location.label,
      onHand: levels[0]?.onHand ?? 0,
      reserved: levels[0]?.reserved ?? 0,
      updatedAt: levels[0]?.updatedAt ?? null,
    };
  });
}

function inventorySnapshot(
  actor: MinkActorContext,
  target: Awaited<ReturnType<typeof readInventoryAdjustmentTarget>>,
) {
  return sha256([
    actor.storeId,
    actor.adminId,
    target.productId,
    target.variantId,
    target.locationId,
    target.sku,
    target.onHand,
    target.reserved,
    target.updatedAt,
  ]);
}

function resolveInventoryQuantityChange(
  quantityChangeValue: unknown,
  targetQuantityValue: unknown,
  currentOnHand: number,
) {
  const hasChange = quantityChangeValue !== undefined;
  const hasTarget = targetQuantityValue !== undefined;
  if (hasChange === hasTarget) {
    throw new MinkToolInputError(
      "Supply exactly one of quantity_change or target_quantity.",
    );
  }
  const quantity = hasTarget
    ? Number(targetQuantityValue) - currentOnHand
    : Number(quantityChangeValue);
  if (
    hasTarget &&
    (!Number.isInteger(Number(targetQuantityValue)) ||
      Number(targetQuantityValue) < 0 ||
      Number(targetQuantityValue) > 2_147_483_647)
  ) {
    throw new MinkToolInputError(
      "target_quantity must be a non-negative whole number in the supported range.",
    );
  }
  if (
    !Number.isInteger(quantity) ||
    quantity === 0 ||
    Math.abs(quantity) > 1_000_000
  ) {
    throw new MinkToolInputError(
      "The resulting quantity change must be a non-zero whole number between -1,000,000 and 1,000,000.",
    );
  }
  return quantity;
}

async function readCoupon(actor: MinkActorContext, code: string) {
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: coupons.id,
        code: coupons.code,
        description: coupons.description,
        status: coupons.status,
        discountType: coupons.discountType,
        discountValue: coupons.discountValue,
        minOrderAmount: coupons.minOrderAmount,
        maxUses: coupons.maxUses,
        validFrom: coupons.validFrom,
        validUntil: coupons.validUntil,
        showOnStorefront: coupons.showOnStorefront,
        updatedAt: coupons.updatedAt,
      })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, actor.storeId),
          eq(coupons.code, normalizeCouponCode(code)),
        ),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "That coupon code was not found in the current store.",
    );
  }
  return rows[0];
}

async function couponSnapshot(
  actor: MinkActorContext,
  coupon: Awaited<ReturnType<typeof readCoupon>>,
) {
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      actor.storeId,
      coupon.id,
      coupon.code,
      coupon.description,
      coupon.status,
      coupon.discountType,
      coupon.discountValue,
      coupon.minOrderAmount,
      coupon.maxUses,
      coupon.validFrom,
      coupon.validUntil,
      coupon.showOnStorefront,
      coupon.updatedAt,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readCustomerGroup(actor: MinkActorContext, name: string) {
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        description: userGroups.description,
        color: userGroups.color,
        updatedAt: userGroups.updatedAt,
      })
      .from(userGroups)
      .where(
        and(eq(userGroups.storeId, actor.storeId), eq(userGroups.name, name)),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "That customer-group name was not found in the current store.",
    );
  }
  return rows[0];
}

async function customerGroupSnapshot(
  actor: MinkActorContext,
  group: Awaited<ReturnType<typeof readCustomerGroup>>,
) {
  return sha256([
    actor.storeId,
    group.id,
    group.name,
    group.description,
    group.color,
    group.updatedAt,
  ]);
}

async function readCurrentProduct(actor: MinkActorContext) {
  if (actor.selectedResource?.type !== "product") {
    throw new MinkToolInputError(
      "Open a product before requesting this draft.",
    );
  }
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
      })
      .from(products)
      .where(
        and(
          eq(products.id, actor.selectedResource!.id),
          eq(products.storeId, actor.storeId),
        ),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "The selected product is not available in this store.",
    );
  }
  return rows[0];
}

function withActor<T>(
  actor: MinkActorContext,
  fn: Parameters<typeof withUser<T>>[1],
): Promise<T> {
  return withUser({ uid: actor.adminId, email: actor.email }, fn);
}

function proposalOutput(proposal: MinkArtifact): Record<string, unknown> {
  return { proposal };
}

function proposalArtifact(output: Record<string, unknown>) {
  const proposal = output.proposal as MinkArtifact | undefined;
  return proposal?.type === "proposal" ? proposal : undefined;
}

function readString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new MinkToolInputError(`${field} must be text.`);
  }
  const result = value.normalize("NFKC").trim();
  if (!result || result.length > maxLength) {
    throw new MinkToolInputError(
      `${field} must be between 1 and ${maxLength.toLocaleString("en-IN")} characters.`,
    );
  }
  return result;
}

function readOptionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new MinkToolInputError(
      `${field} must be at most ${maxLength.toLocaleString("en-IN")} characters.`,
    );
  }
  return value.normalize("NFKC").trim();
}

function readNumberString(value: unknown, field: string) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new MinkToolInputError(`${field} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 99_999_999.99) {
    throw new MinkToolInputError(`${field} is outside the supported range.`);
  }
  return String(Math.round(number * 100) / 100);
}

function readIntegerString(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw new MinkToolInputError(
      `${field} must be a non-negative whole number.`,
    );
  }
  return String(number);
}

function couponActionSchema(updating: boolean) {
  const properties: Record<string, unknown> = {
    code: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: "string", maxLength: 500 },
    discount_type: { type: "string", enum: ["percentage", "fixed"] },
    discount_value: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
    },
    min_order_amount: { type: "number", minimum: 0, maximum: 99_999_999.99 },
    max_uses: { type: "integer", minimum: 0, maximum: 1_000_000_000 },
    valid_from: { type: "string", maxLength: 40 },
    valid_until: { type: "string", maxLength: 40 },
  };
  const required = [
    "code",
    "discount_type",
    "discount_value",
    "min_order_amount",
    "max_uses",
  ];
  if (updating) {
    properties.current_coupon_code = {
      type: "string",
      minLength: 1,
      maxLength: 100,
    };
    properties.coupon_snapshot = {
      type: "string",
      minLength: 64,
      maxLength: 64,
    };
    required.push("current_coupon_code", "coupon_snapshot");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function couponProposalContent(args: Record<string, unknown>) {
  const type = readString(args.discount_type, "discount_type", 10);
  if (type !== "percentage" && type !== "fixed") {
    throw new MinkToolInputError("discount_type must be percentage or fixed.");
  }
  return {
    code: normalizeCouponCode(readString(args.code, "code", 100)),
    description: readOptionalString(args.description, "description", 500),
    discount_type: type,
    discount_value: readNumberString(args.discount_value, "discount_value"),
    min_order_amount: readNumberString(
      args.min_order_amount,
      "min_order_amount",
    ),
    max_uses: readIntegerString(args.max_uses, "max_uses"),
    valid_from: readOptionalString(args.valid_from, "valid_from", 40),
    valid_until: readOptionalString(args.valid_until, "valid_until", 40),
  };
}

function couponDraftValues(coupon: Awaited<ReturnType<typeof readCoupon>>) {
  return {
    code: coupon.code,
    description: coupon.description ?? "",
    discount_type: coupon.discountType,
    discount_value: String(coupon.discountValue),
    min_order_amount: String(coupon.minOrderAmount),
    max_uses: String(coupon.maxUses),
    valid_from: coupon.validFrom ?? "",
    valid_until: coupon.validUntil ?? "",
  };
}

function customerGroupSchema(updating: boolean) {
  const properties: Record<string, unknown> = {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 500 },
    color: {
      type: "string",
      enum: ["blue", "green", "amber", "violet", "grey"],
    },
  };
  const required = ["name", "color"];
  if (updating) {
    properties.current_group_name = {
      type: "string",
      minLength: 1,
      maxLength: 120,
    };
    properties.group_snapshot = {
      type: "string",
      minLength: 64,
      maxLength: 64,
    };
    required.push("current_group_name", "group_snapshot");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function customerGroupProposalContent(args: Record<string, unknown>) {
  return {
    name: readString(args.name, "name", 120),
    description: readOptionalString(args.description, "description", 500),
    color: readString(args.color, "color", 20),
  };
}

function customerGroupDraftValues(
  group: Awaited<ReturnType<typeof readCustomerGroup>>,
) {
  return {
    name: group.name,
    description: group.description ?? "",
    color: group.color,
  };
}

function normalizeCouponCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

async function assertProductProposalCapacity(actor: MinkActorContext) {
  const limit = limitsFor(actor.effectivePlan).maxProducts;
  if (limit === null) return;
  const rows = await withActor(actor, (db) =>
    db
      .select({ n: count() })
      .from(products)
      .where(eq(products.storeId, actor.storeId)),
  );
  if ((rows[0]?.n ?? 0) >= limit) {
    throw new MinkToolInputError(
      "This store has reached its current product limit. Upgrade before creating a product proposal so no draft credits are charged for an action that cannot run.",
    );
  }
}

async function sha256(value: unknown[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
