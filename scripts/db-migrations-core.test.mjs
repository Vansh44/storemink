import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  loadManifest,
  migrationPlan,
  parseCli,
  sha256,
  validateEnvironment,
} from "./db-migrations-core.mjs";

const manifest = {
  baseline: { id: "baseline:x", checksum: "base" },
  migrations: [
    { id: "001_first", checksum: "one" },
    { id: "002_second", checksum: "two" },
  ],
};

describe("database migration controls", () => {
  it("loads the repository manifest and checksums the enrolled SQL", async () => {
    const loaded = await loadManifest();
    expect(loaded.baseline.id).toBe("baseline:cloudsql-2026-08-14");
    expect(loaded.migrations).toHaveLength(81);
    expect(loaded.migrations.at(-1)).toMatchObject({
      id: "20260905_0081_mink_phase_8a_business_briefs",
      requires: ["20260905_0080_mink_builder_chat_help"],
      transaction: true,
    });
    expect(loaded.migrations[0]).toMatchObject({
      id: "20260814_0001_logistics_shiprocket",
      transaction: true,
    });
    expect(loaded.migrations[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[1]).toMatchObject({
      id: "20260814_0002_schema_drift_repair",
      transaction: true,
    });
    expect(loaded.migrations[2]).toMatchObject({
      id: "20260816_0003_pos_pickup_prepared_at",
      transaction: true,
    });
    expect(loaded.migrations[2].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[3]).toMatchObject({
      id: "20260816_0004_ai_credit_invoice_paid_repair",
      transaction: true,
    });
    expect(loaded.migrations[3].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[4]).toMatchObject({
      id: "20260818_0005_analytics_dashboard_layouts",
      transaction: true,
    });
    expect(loaded.migrations[4].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[5]).toMatchObject({
      id: "20260819_0006_search_metrics",
      transaction: true,
    });
    expect(loaded.migrations[5].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[6]).toMatchObject({
      id: "20260820_0007_platform_analytics_controls",
      transaction: true,
    });
    expect(loaded.migrations[6].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[7]).toMatchObject({
      id: "20260820_0008_analytics_help_documents",
      transaction: true,
    });
    expect(loaded.migrations[7].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[8]).toMatchObject({
      id: "20260820_0009_help_article_indexability",
      transaction: true,
    });
    expect(loaded.migrations[8].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[9]).toMatchObject({
      id: "20260820_0010_merchant_pixels",
      transaction: true,
    });
    expect(loaded.migrations[9].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[10]).toMatchObject({
      id: "20260820_0011_storefront_conversion",
      transaction: true,
    });
    expect(loaded.migrations[10].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[11]).toMatchObject({
      id: "20260820_0012_gross_margin",
      transaction: true,
    });
    expect(loaded.migrations[12]).toMatchObject({
      id: "20260822_0013_payment_shift_attribution",
      transaction: true,
    });
    expect(loaded.migrations[12].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[13]).toMatchObject({
      id: "20260823_0014_store_deletion_cascade",
      transaction: true,
    });
    expect(loaded.migrations[13].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[14]).toMatchObject({
      id: "20260825_0015_pos_help_documents",
      transaction: true,
    });
    expect(loaded.migrations[14].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[15]).toMatchObject({
      id: "20260825_0016_help_assistant_guide",
      transaction: true,
    });
    expect(loaded.migrations[15].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[15].sql).toMatch(
      /\$article\$,\s*'published',\s*'How to use Mink AI in the StoreMink Help Centre'/,
    );
    expect(loaded.migrations[16]).toMatchObject({
      id: "20260825_0017_help_article_embeddings",
      transaction: true,
      requires: ["20260825_0016_help_assistant_guide"],
      verify: {
        tables: ["help_article_chunks"],
        rlsTables: ["help_article_chunks"],
      },
      applyVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "Mink AI guide explains hybrid published-guide retrieval",
          }),
        ]),
      },
      adoptVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "Mink AI guide explains hybrid published-guide retrieval",
          }),
        ]),
      },
    });
    expect(loaded.migrations[16].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[16].sql).toMatch(
      /CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public/,
    );
    expect(loaded.migrations[16].sql).toMatch(
      /embedding\s+public\.vector\(768\) NOT NULL/,
    );
    expect(loaded.migrations[16].sql).toMatch(/heading_level BETWEEN 1 AND 6/);
    expect(loaded.migrations[16].sql).toMatch(/chunk_index >= 0/);
    expect(loaded.migrations[16].sql).not.toMatch(/chunk_count/);
    expect(loaded.migrations[16].sql).not.toMatch(/index_version/);
    expect(loaded.migrations[17]).toMatchObject({
      id: "20260826_0018_help_embedding_hardening",
      requires: ["20260825_0017_help_article_embeddings"],
      verify: {
        columns: [
          "help_article_chunks.chunk_count",
          "help_article_chunks.index_version",
        ],
      },
    });
    expect(loaded.migrations[17].sql).toMatch(
      /chunk_index >= 0 AND chunk_index < chunk_count/,
    );
    expect(loaded.migrations[17].sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_store_search_rate_slot\(text, integer\)[\s\S]*FROM app_user/,
    );
    expect(
      loaded.migrations.slice(18, 24).map((migration) => migration.id),
    ).toEqual([
      "20260826_0019_getting_started_account_help",
      "20260826_0020_storefront_domains_help",
      "20260826_0021_products_customers_help",
      "20260826_0022_payments_tax_help",
      "20260826_0023_orders_shipping_help",
      "20260826_0024_marketing_communications_help",
    ]);
    expect(
      loaded.migrations.slice(18, 24).map((migration) => migration.requires),
    ).toEqual([
      ["20260826_0018_help_embedding_hardening"],
      ["20260826_0019_getting_started_account_help"],
      ["20260826_0020_storefront_domains_help"],
      ["20260826_0021_products_customers_help"],
      ["20260826_0022_payments_tax_help"],
      ["20260826_0023_orders_shipping_help"],
    ]);
    for (const migration of loaded.migrations.slice(18, 24)) {
      expect(migration.transaction).toBe(true);
      expect(migration.verify).toEqual({});
      expect(migration.applyVerify?.queries).toEqual(expect.any(Array));
      expect(migration.adoptVerify?.queries).toEqual(expect.any(Array));
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);

      for (const contract of [migration.applyVerify, migration.adoptVerify]) {
        const articleCheck = contract.queries.find((query) =>
          query.name.includes("guides are complete and published"),
        );
        expect(articleCheck?.sql).toContain("length(trim(a.title)) > 0");
      }
    }
    expect(loaded.migrations[24]).toMatchObject({
      id: "20260826_0025_mink_ai_fullscreen_help",
      transaction: true,
      requires: ["20260826_0024_marketing_communications_help"],
      verify: {},
      applyVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("clarification guidance"),
            equals: "1",
          }),
        ],
      },
      adoptVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("clarification guidance"),
            equals: "1",
          }),
        ],
      },
    });
    expect(loaded.migrations[24].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[24].sql).toContain(
      "at the beginning of the new answer",
    );
    expect(loaded.migrations[24].sql).toContain(
      "non-clickable examples of details you can add",
    );
    expect(loaded.migrations[25]).toMatchObject({
      id: "20260826_0026_plan_entitlements_help",
      transaction: true,
      requires: ["20260826_0025_mink_ai_fullscreen_help"],
      verify: {},
    });
    expect(loaded.migrations[25].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[25].sql).toContain(
      "does not delete store data because a plan becomes lower",
    );
    expect(loaded.migrations[26]).toMatchObject({
      id: "20260827_0027_plan_review_followups_help",
      transaction: true,
      requires: ["20260826_0026_plan_entitlements_help"],
      verify: {},
    });
    expect(loaded.migrations[26].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[26].sql).toContain(
      "shoppers receive the retained manual or free shipping option",
    );
    expect(loaded.migrations[27]).toMatchObject({
      id: "20260827_0028_inventory_location_workflow_help",
      transaction: true,
      requires: ["20260827_0027_plan_review_followups_help"],
      verify: {},
    });
    expect(loaded.migrations[27].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[27].sql).toContain("All locations (view only)");
    expect(loaded.migrations[27].sql).toContain(
      "drawer is filtered to that location",
    );
    expect(loaded.migrations[28]).toMatchObject({
      id: "20260827_0029_locations_fulfilment_navigation_help",
      transaction: true,
      requires: ["20260827_0028_inventory_location_workflow_help"],
      verify: {},
    });
    expect(loaded.migrations[28].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[28].sql).toContain(
      "select <strong>Online fulfilment &amp; pickup</strong> in the left Locations panel",
    );
    expect(loaded.migrations[29]).toMatchObject({
      id: "20260827_0030_locations_sidebar_visibility_help",
      transaction: true,
      requires: ["20260827_0029_locations_fulfilment_navigation_help"],
      verify: {},
    });
    expect(loaded.migrations[29].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[29].sql).toContain(
      "full destination name wraps onto another line instead of being hidden",
    );
    expect(loaded.migrations[30]).toMatchObject({
      id: "20260827_0031_pos_checkout_clarity_help",
      transaction: true,
      requires: ["20260827_0030_locations_sidebar_visibility_help"],
      verify: {},
      applyVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("POS checkout guides"),
            equals: "3",
          }),
        ],
      },
      adoptVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("POS checkout guides"),
            equals: "3",
          }),
        ],
      },
    });
    expect(loaded.migrations[30].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[30].sql).toContain(
      "The Payment screen shows one plain list of methods",
    );
    expect(loaded.migrations[31]).toMatchObject({
      id: "20260828_0032_pos_phone_checkout_and_verification_help",
      transaction: true,
      requires: ["20260827_0031_pos_checkout_clarity_help"],
      verify: {},
      applyVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("phone-first checkout"),
            equals: "4",
          }),
        ],
      },
      adoptVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("phone-first checkout"),
            equals: "4",
          }),
        ],
      },
    });
    expect(loaded.migrations[31].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[31].sql).toContain(
      "StoreMink does not search while you type",
    );
    expect(loaded.migrations[31].sql).toContain(
      "Verify the customer before hand-over",
    );
    expect(loaded.migrations[32]).toMatchObject({
      id: "20260829_0033_pos_customer_sales_returns_help",
      transaction: true,
      requires: ["20260828_0032_pos_phone_checkout_and_verification_help"],
      verify: {},
      applyVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("policy-driven returns"),
            equals: "4",
          }),
        ],
      },
      adoptVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("policy-driven returns"),
            equals: "4",
          }),
        ],
      },
    });
    expect(loaded.migrations[32].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[32].sql).toContain(
      "split payment is refunded across its original tenders",
    );
    expect(loaded.migrations[32].sql).toContain(
      "Understand collected pickups in Sales",
    );
    expect(loaded.migrations[34]).toMatchObject({
      id: "20260829_0035_mink_dashboard_alpha",
      transaction: true,
      requires: ["20260829_0034_pos_sales_refund_state_help"],
      verify: {
        tables: expect.arrayContaining([
          "mink_conversations",
          "mink_runs",
          "mink_messages",
          "mink_tool_calls",
          "mink_usage_ledger",
        ]),
        rlsTables: expect.arrayContaining([
          "mink_conversations",
          "mink_runs",
          "mink_messages",
          "mink_tool_calls",
          "mink_usage_ledger",
        ]),
      },
    });
    expect(loaded.migrations[34].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[34].sql).toContain(
      "REVOKE ALL ON TABLE public.mink_conversations FROM PUBLIC, app_user",
    );
    expect(loaded.migrations[34].sql).toContain(
      "use-mink-ai-in-your-dashboard",
    );
    expect(loaded.migrations[35]).toMatchObject({
      id: "20260829_0036_mink_conversation_ux",
      transaction: true,
      requires: ["20260829_0035_mink_dashboard_alpha"],
      verify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "app_service can enforce the Mink conversation cap",
            equals: "true",
          }),
          expect.objectContaining({
            name: "no actor and store retain more than ten Mink conversations",
            equals: "0",
          }),
        ]),
      },
    });
    expect(loaded.migrations[35].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[35].sql).toContain(
      "GRANT DELETE ON TABLE public.mink_conversations TO app_service",
    );
    expect(loaded.migrations[35].sql).toContain("position > 10");
    expect(loaded.migrations[36]).toMatchObject({
      id: "20260829_0037_mink_sidebar_composer",
      transaction: true,
      requires: ["20260829_0036_mink_conversation_ux"],
      applyVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "the Mink dashboard guide documents the robot sidebar deletion and growing composer",
            equals: "1",
          }),
        ]),
      },
    });
    expect(loaded.migrations[36].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[36].sql).toContain(
      "purple robot mark in the dashboard header",
    );
    expect(loaded.migrations[36].sql).toContain("Delete conversation");
    expect(loaded.migrations[36].sql).toContain("Shift+Enter");
    expect(loaded.migrations[37]).toMatchObject({
      id: "20260829_0038_mink_phase_1b",
      transaction: true,
      requires: ["20260829_0037_mink_sidebar_composer"],
      verify: {
        columns: expect.arrayContaining([
          "mink_runs.retry_count",
          "mink_usage_ledger.estimated_cost_microusd",
        ]),
      },
    });
    expect(loaded.migrations[37].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[37].sql).toContain("mink_runs_started_idx");
    expect(loaded.migrations[37].sql).toContain("Analytics → View");
    expect(loaded.migrations[38]).toMatchObject({
      id: "20260829_0039_mink_phase_2",
      transaction: true,
      requires: ["20260829_0038_mink_phase_1b"],
      verify: {
        tables: expect.arrayContaining(["mink_store_access", "mink_feedback"]),
        columns: expect.arrayContaining([
          "mink_conversations.summary_json",
          "mink_usage_ledger.shadow_credits",
        ]),
      },
    });
    expect(loaded.migrations[38].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[38].sql).toContain("invited read-only beta");
    expect(loaded.migrations[38].sql).toContain("Shadow credits");
    expect(loaded.migrations[39]).toMatchObject({
      id: "20260830_0040_mink_phase_3",
      transaction: true,
      requires: ["20260829_0039_mink_phase_2"],
      verify: {
        tables: expect.arrayContaining([
          "mink_drafts",
          "mink_draft_versions",
          "mink_draft_credit_usage",
        ]),
        columns: [
          "mink_store_access.drafting_enabled",
          "mink_draft_credit_usage.period",
        ],
      },
    });
    expect(loaded.migrations[39].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[39].sql).toContain("consume_mink_draft_credits");
    expect(loaded.migrations[39].sql).toContain(
      "discard_failed_mink_run_drafts",
    );
    expect(loaded.migrations[39].sql).toContain(
      "Refund for unseen Mink draft after failed or cancelled run",
    );
    expect(loaded.migrations[39].sql).toContain("Private content drafts");
    expect(loaded.migrations[39].sql).toContain("draft_proposal");
    expect(loaded.migrations[39].sql).toContain(
      "cannot publish a product or blog",
    );
    expect(loaded.migrations[40]).toMatchObject({
      id: "20260830_0041_mink_location_alias_help",
      transaction: true,
      requires: ["20260830_0040_mink_phase_3"],
      applyVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringContaining("location name/type aliases"),
            equals: "1",
          }),
        ]),
      },
    });
    expect(loaded.migrations[40].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[40].sql).toContain("Delhi warehouse");
    expect(loaded.migrations[40].sql).toContain(
      "does not replace a failed named-location request with all-store results",
    );
    expect(loaded.migrations[41]).toMatchObject({
      id: "20260830_0042_mink_phase_4a_product_actions",
      transaction: true,
      requires: ["20260830_0041_mink_location_alias_help"],
      verify: {
        tables: [
          "mink_action_tool_access",
          "mink_action_approvals",
          "mink_action_audit",
        ],
        rlsTables: [
          "mink_action_tool_access",
          "mink_action_approvals",
          "mink_action_audit",
        ],
      },
    });
    expect(loaded.migrations[41].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[41].sql).toContain(
      "mink_action_approvals_idempotency_key",
    );
    expect(loaded.migrations[41].sql).toContain(
      "mink_action_approvals_product_store_fkey",
    );
    expect(loaded.migrations[41].sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.mink_action_audit",
    );
    expect(loaded.migrations[41].sql).toContain(
      "Approved product-text actions",
    );
    expect(loaded.migrations[41].sql).toContain("Approve and apply");
    expect(loaded.migrations[41].sql).toContain("Review safe rollback");
    expect(loaded.migrations[42]).toMatchObject({
      id: "20260830_0043_mink_phase_4b_4d_actions",
      transaction: true,
      requires: ["20260830_0042_mink_phase_4a_product_actions"],
      verify: {
        columns: expect.arrayContaining([
          "mink_action_approvals.resource_type",
          "mink_action_approvals.result_id",
          "mink_action_audit.resource_version_after",
        ]),
      },
    });
    expect(loaded.migrations[42].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[42].sql).toContain("create_customer_group");
    expect(loaded.migrations[42].sql).toContain("unpublished draft product");
    expect(loaded.migrations[42].sql).toContain("safe rollback preview");
    expect(loaded.migrations[43]).toMatchObject({
      id: "20260830_0044_mink_action_reliability_help",
      transaction: true,
      requires: ["20260830_0043_mink_phase_4b_4d_actions"],
    });
    expect(loaded.migrations[43].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[43].sql).toContain(
      "Proposal and approval reliability",
    );
    expect(loaded.migrations[43].sql).toContain(
      "does not enable drafting for every store",
    );
    expect(loaded.migrations[43].sql).toContain(
      "exact database checkpoint captured by the preview",
    );
    expect(loaded.migrations[44]).toMatchObject({
      id: "20260831_0045_pos_mobile_register_help",
      transaction: true,
      requires: ["20260830_0044_mink_action_reliability_help"],
    });
    expect(loaded.migrations[44].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[44].sql).toContain(
      "Use the register on a phone or portrait tablet",
    );
    expect(loaded.migrations[44].sql).toContain("separate full-width views");
    expect(loaded.migrations[45]).toMatchObject({
      id: "20260831_0046_mink_phase_5a_inventory_actions",
      transaction: true,
      requires: ["20260831_0045_pos_mobile_register_help"],
    });
    expect(loaded.migrations[45].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[45].sql).toContain("adjust_inventory");
    expect(loaded.migrations[45].sql).toContain(
      "mink_action_approvals_inventory_target_check",
    );
    expect(loaded.migrations[45].sql).toContain(
      "writes the inventory level and stock-movement ledger in one database transaction",
    );
    expect(loaded.migrations[46]).toMatchObject({
      id: "20260831_0047_mink_phase_5b_bulk_inventory",
      transaction: true,
      requires: ["20260831_0046_mink_phase_5a_inventory_actions"],
    });
    expect(loaded.migrations[46].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[46].sql).toContain("bulk_adjust_inventory");
    expect(loaded.migrations[46].sql).toContain(
      "mink_action_approvals_bulk_inventory_target_check",
    );
    expect(loaded.migrations[46].sql).toContain(
      "database rolls the whole batch back",
    );
    expect(loaded.migrations[47]).toMatchObject({
      id: "20260831_0048_mink_catalog_health_ui",
      transaction: true,
      requires: ["20260831_0047_mink_phase_5b_bulk_inventory"],
    });
    expect(loaded.migrations[47].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[47].sql).toContain(
      "Low-stock and out-of-stock counts are sellable-SKU counts",
    );
    expect(loaded.migrations[47].sql).toContain(
      "Model text is never treated as raw HTML",
    );
    expect(loaded.migrations[48]).toMatchObject({
      id: "20260831_0049_mink_inventory_scope_clarification",
      transaction: true,
      requires: ["20260831_0048_mink_catalog_health_ui"],
    });
    expect(loaded.migrations[48].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[48].sql).toContain(
      "does not silently assume an all-location total",
    );
    expect(loaded.migrations[48].sql).toContain(
      "missing inventory-level row counts as zero at that shelf",
    );
    expect(loaded.migrations[49]).toMatchObject({
      id: "20260901_0050_mink_full_view_takeover",
      transaction: true,
      requires: ["20260831_0049_mink_inventory_scope_clarification"],
    });
    expect(loaded.migrations[49].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[49].sql).toContain(
      "covering the dashboard topbar, left navigation and page content",
    );
    expect(loaded.migrations[50]).toMatchObject({
      id: "20260901_0051_mink_phase_5c_order_status",
      transaction: true,
      requires: ["20260901_0050_mink_full_view_takeover"],
    });
    expect(loaded.migrations[50].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[50].sql).toContain("transition_order_status");
    expect(loaded.migrations[50].sql).toContain(
      "mink_action_approvals_order_status_target_check",
    );
    expect(loaded.migrations[50].sql).toContain(
      "Pending or approved cancellation states and any refund activity block advancement",
    );
    expect(loaded.migrations[50].sql).toContain(
      "otherwise append the complete section",
    );
    expect(loaded.migrations[50].sql).toContain(
      "ON CONFLICT (slug) DO NOTHING",
    );
    expect(loaded.migrations[50].sql).toContain("status = 'published'");
    expect(loaded.migrations[50].sql).toContain(
      "DROP CONSTRAINT IF EXISTS mink_drafts_order_status_target_check",
    );
    expect(loaded.migrations[50].sql).toContain(
      "CREATE INDEX IF NOT EXISTS mink_action_approvals_order_status_idx",
    );
    expect(loaded.migrations[50].sql).toContain(
      "body LIKE '%do not offer automatic rollback%'",
    );
    expect(loaded.migrations[51]).toMatchObject({
      id: "20260901_0052_mink_phase_5d_blog_publication",
      transaction: true,
      requires: ["20260901_0051_mink_phase_5c_order_status"],
    });
    expect(loaded.migrations[51].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[51].sql).toContain("publish_blog");
    expect(loaded.migrations[51].sql).toContain(
      "mink_blog_publications_blog_store_fkey",
    );
    expect(loaded.migrations[51].sql).toContain(
      "outcome <> 'executed' AND result_id IS NULL",
    );
    expect(loaded.migrations[51].sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(loaded.migrations[51].sql).toContain("Publish or schedule one blog");
    expect(loaded.migrations[51].sql).toContain(
      "does not activate Markdown links",
    );
    expect(loaded.migrations[51].sql).toContain(
      "$phase5d$)\n)\nUPDATE public.help_articles AS article",
    );
    expect(loaded.migrations[52]).toMatchObject({
      id: "20260901_0053_mink_phase_5e_campaigns",
      transaction: true,
      requires: ["20260901_0052_mink_phase_5d_blog_publication"],
    });
    expect(loaded.migrations[52].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[52].sql).toContain("send_campaign");
    expect(loaded.migrations[52].sql).toContain(
      "email_campaigns_mink_approval_store_fkey",
    );
    expect(loaded.migrations[52].sql).toContain(
      "email_campaign_recipients_campaign_store_fkey",
    );
    expect(loaded.migrations[52].sql).toContain("brand_snapshot");
    expect(loaded.migrations[52].sql).toContain("WITH ready AS");
    expect(loaded.migrations[52].sql).toContain(
      "FOR UPDATE OF recipient SKIP LOCKED",
    );
    expect(loaded.migrations[52].sql).toContain(
      "Send or schedule one coupon-email campaign",
    );
    expect(loaded.migrations[53]).toMatchObject({
      id: "20260901_0054_mink_phase_5f_bulk_prices",
      transaction: true,
      requires: ["20260901_0053_mink_phase_5e_campaigns"],
    });
    expect(loaded.migrations[53].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[53].sql).toContain("bulk_update_prices");
    expect(loaded.migrations[53].sql).toContain(
      "mink_action_approvals_bulk_price_target_check",
    );
    expect(loaded.migrations[53].sql).toContain(
      "product_variants_touch_parent_price",
    );
    expect(loaded.migrations[53].sql).toContain(
      "Update prices for up to 20 exact SKUs",
    );
    expect(loaded.migrations[53].sql).toMatch(
      /\$phase5f\$\)\s*\)\s*UPDATE public\.help_articles/,
    );
    expect(loaded.migrations[53].sql).toContain(
      "not a sales or revenue forecast",
    );
    expect(loaded.migrations[54]).toMatchObject({
      id: "20260902_0055_pos_https_entry_help",
      transaction: true,
      requires: ["20260901_0054_mink_phase_5f_bulk_prices"],
      verify: {},
    });
    expect(loaded.migrations[54].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[54].sql).toContain(
      "StoreMink permanently upgrades a plain HTTP request",
    );
    expect(loaded.migrations[54].sql).toContain(
      "The address says this site cannot be reached",
    );
    expect(loaded.migrations[55]).toMatchObject({
      id: "20260902_0056_mink_mobile_workspace_help",
      transaction: true,
      requires: ["20260902_0055_pos_https_entry_help"],
      verify: {},
    });
    expect(loaded.migrations[55].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[55].sql).toContain(
      "recent conversations start closed behind the sidebar button",
    );
    expect(loaded.migrations[55].sql).toContain(
      "the dashboard underneath cannot scroll",
    );
    expect(loaded.migrations[55].sql).toContain("without zooming the page");
    expect(loaded.migrations[56]).toMatchObject({
      id: "20260902_0057_mobile_pos_notification_help",
      transaction: true,
      requires: ["20260902_0056_mink_mobile_workspace_help"],
      verify: {},
    });
    expect(loaded.migrations[56].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[56].sql).toContain(
      "the register opens the software keyboard only after you select an editable field",
    );
    expect(loaded.migrations[56].sql).toContain(
      "Read the dashboard notification bell on a phone",
    );
    const repairChecks = [
      loaded.migrations[22].applyVerify,
      loaded.migrations[22].adoptVerify,
    ].map((contract) =>
      contract.queries.find((query) =>
        query.name.includes("POS and Analytics Help statements"),
      ),
    );
    for (const repairCheck of repairChecks) {
      expect(repairCheck?.equals).toBe("6");
      expect(repairCheck?.sql).toContain("where status = 'published'");
      expect(repairCheck?.sql).toContain(
        "Their setup guides are available to eligible merchants",
      );
      expect(repairCheck?.sql).toContain("take-returns-at-the-counter");
      expect(repairCheck?.sql).toContain(
        "refunds-store-credit-exchanges-and-credit-notes",
      );
    }
    for (const contract of [
      loaded.migrations[22].applyVerify,
      loaded.migrations[22].adoptVerify,
    ]) {
      expect(
        contract.queries.find((query) =>
          query.name.includes("controlled-live warning"),
        ),
      ).toMatchObject({ equals: "5" });
      expect(
        contract.queries.find((query) =>
          query.name.includes("spent-credit cleanup"),
        ),
      ).toMatchObject({ equals: "2" });
    }
    expect(loaded.migrations[7]).toMatchObject({
      id: "20260820_0008_analytics_help_documents",
      verify: {},
      applyVerify: { queries: expect.any(Array) },
      adoptVerify: { queries: expect.any(Array) },
    });
  });

  it("canonicalizes objects before hashing", () => {
    expect(canonicalJson({ b: 2, a: [3, { z: true }] })).toBe(
      '{"a":[3,{"z":true}],"b":2}',
    );
    expect(sha256("same")).toBe(sha256("same"));
    expect(sha256("same")).not.toBe(sha256("changed"));
  });

  it("reports pending migrations only after a baseline", () => {
    expect(migrationPlan(manifest, [])).toMatchObject({
      baselineApplied: false,
      pending: [{ id: "001_first" }, { id: "002_second" }],
      drifted: [],
      unknown: [],
    });
  });

  it("fails closed on changed and unknown ledger entries", () => {
    const plan = migrationPlan(manifest, [
      { id: "baseline:x", checksum: "wrong" },
      { id: "001_first", checksum: "one" },
      { id: "hand_applied", checksum: "mystery" },
    ]);
    expect(plan.drifted).toEqual([
      { id: "baseline:x", expected: "base", actual: "wrong" },
    ]);
    expect(plan.unknown).toEqual([{ id: "hand_applied", checksum: "mystery" }]);
    expect(plan.pending.map((migration) => migration.id)).toEqual([
      "002_second",
    ]);
    expect(plan.outOfOrder).toEqual([]);
  });

  it("detects a valid later ledger row after a missing migration", () => {
    const plan = migrationPlan(manifest, [
      { id: "baseline:x", checksum: "base" },
      { id: "002_second", checksum: "two" },
    ]);

    expect(plan.pending.map((migration) => migration.id)).toEqual([
      "001_first",
    ]);
    expect(plan.outOfOrder).toEqual([{ id: "002_second" }]);
  });

  it("guards the physical database behind each environment name", () => {
    expect(validateEnvironment("staging", "storemink_staging")).toEqual({
      needsProductionConfirmation: false,
    });
    expect(() => validateEnvironment("staging", "storemink")).toThrow(
      "expected storemink_staging",
    );
    expect(validateEnvironment("production", "storemink", true)).toEqual({
      needsProductionConfirmation: true,
    });
  });

  it("requires explicit command and environment arguments", () => {
    expect(parseCli(["verify", "--environment", "staging"])).toEqual({
      command: "verify",
      environment: "staging",
    });
    expect(
      parseCli([
        "audit",
        "--environment",
        "staging",
        "--through",
        "002_second",
      ]),
    ).toEqual({
      command: "audit",
      environment: "staging",
      through: "002_second",
    });
    expect(
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
        "--confirm-adopt",
        "002_second",
        "--confirm-checksum",
        "a".repeat(64),
        "--confirm-database",
        "storemink_staging",
      ]),
    ).toEqual({
      command: "adopt",
      environment: "staging",
      migration: "002_second",
      "confirm-adopt": "002_second",
      "confirm-checksum": "a".repeat(64),
      "confirm-database": "storemink_staging",
    });
    expect(() => parseCli(["apply"])).toThrow("--environment is required");
    expect(() => parseCli(["adopt", "--environment", "staging"])).toThrow(
      "adopt requires --migration",
    );
    expect(() =>
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
      ]),
    ).toThrow("adopt requires --confirm-adopt");
    expect(() =>
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
        "--confirm-adopt",
        "001_first",
        "--confirm-checksum",
        "a".repeat(64),
        "--confirm-database",
        "storemink_staging",
      ]),
    ).toThrow("--confirm-adopt to match");
    expect(() =>
      parseCli([
        "verify",
        "--environment",
        "staging",
        "--environment",
        "production",
      ]),
    ).toThrow("Duplicate flag");
    expect(() =>
      parseCli(["verify", "--environment", "staging", "--typo", "yes"]),
    ).toThrow("Unknown flag");
    expect(() => parseCli(["destroy", "--environment", "local"])).toThrow(
      "Usage",
    );
  });

  it("fingerprints public aggregates without decompiling them as functions", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toMatch(
      /when p\.prokind in \('f', 'p'\) then pg_get_functiondef\(p\.oid\)/,
    );
    expect(runner).toContain("concat('kind=', p.prokind)");
    expect(runner).toContain("join pg_language l on l.oid = p.prolang");
  });

  it("never falls back from the migration administrator to the app login", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain("DB_ADMIN_USER is required");
    expect(runner).not.toContain(
      "process.env.DB_ADMIN_USER ?? process.env.DB_USER",
    );
    expect(runner).toContain(
      "revoke all on ${LEDGER} from public, app_user, app_service",
    );
  });

  it("adopts only verified schema in one serializable ledger transaction", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain(
      'client.query("begin isolation level serializable")',
    );
    expect(runner).toContain("const lockedRows = await appliedRows(client)");
    expect(runner).toContain(
      "const lockedPlan = migrationPlan(manifest, lockedRows)",
    );
    expect(runner).toMatch(/`adopt:\$\{migration\.file\}`/);
    expect(runner).toContain("`adoption ${migration.id}`");
    expect(runner).toContain('await client.query("rollback")');
  });

  it("runs adoption audits in a database-enforced read-only transaction", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain(
      'client.query("begin isolation level repeatable read read only")',
    );
    expect(runner).toContain(
      "ADOPTION AUDIT — migration SQL and ledger writes are disabled.",
    );
  });
});
