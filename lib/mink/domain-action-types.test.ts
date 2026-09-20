import { describe, expect, it } from "vitest";
import {
  domainActionFields,
  domainActionToolForDraftKind,
  draftValuesForDomainAction,
  resourceTypeForDomainTool,
} from "./domain-action-types";

describe("Mink Phase 4B-4D action contract", () => {
  it("maps only guarded Phase 4B-4D proposal kinds to live tools", () => {
    expect(domainActionToolForDraftKind("product_create")).toBe(
      "create_product",
    );
    expect(domainActionToolForDraftKind("coupon_create")).toBe("create_coupon");
    expect(domainActionToolForDraftKind("coupon_update")).toBe("update_coupon");
    expect(domainActionToolForDraftKind("customer_group_create")).toBe(
      "create_customer_group",
    );
    expect(domainActionToolForDraftKind("customer_group_update")).toBe(
      "update_customer_group",
    );
    expect(domainActionToolForDraftKind("blog")).toBeNull();
    expect(domainActionToolForDraftKind("coupon_email")).toBeNull();
  });

  it("forces safe product and coupon creation state into approval payloads", () => {
    const product = draftValuesForDomainAction("create_product", {
      name: "Tea",
      slug: "tea",
    });
    expect(product).toMatchObject({
      status: "draft",
      track_inventory: "disabled",
    });
    expect(domainActionFields("create_product")).toContain("image_url");
    expect(domainActionFields("create_product")).not.toContain("stock");
    expect(domainActionFields("create_product")).not.toContain("published_at");

    const coupon = draftValuesForDomainAction("create_coupon", {
      code: "SAVE10",
    });
    expect(coupon).toMatchObject({
      status: "disabled",
      show_on_storefront: "no",
      audience: "all customers (no group restriction)",
    });
    expect(domainActionFields("create_coupon")).not.toContain("used_count");
  });

  it("keeps customer groups metadata-only", () => {
    expect(resourceTypeForDomainTool("update_customer_group")).toBe(
      "customer_group",
    );
    expect(domainActionFields("update_customer_group")).toEqual([
      "name",
      "description",
      "color",
    ]);
  });
});
