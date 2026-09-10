import { describe, expect, test } from "vitest";
import {
  GRANDFATHERED,
  GRANDFATHERED_VERIFY,
  HELP_LINT_RULES,
  lintHelpSql,
  lintManifest,
  lintVerifyContract,
  parseAllowMarkers,
  publishedText,
  touchesHelpContent,
} from "./help-content-lint.mjs";

const HELP = (content) =>
  `UPDATE public.help_articles SET body = $guide$${content}$guide$ WHERE slug = 'x';`;

const rules = (findings) => findings.map((f) => f.rule).sort();

describe("help content lint", () => {
  test("only inspects migrations that write Help content", () => {
    expect(touchesHelpContent("alter table orders add column x int;")).toBe(
      false,
    );
    expect(touchesHelpContent(HELP("<p>hi</p>"))).toBe(true);
    // A migration full of banned words that never touches Help is not our business.
    expect(
      lintHelpSql(
        "-- Phase 6A worker lease\nalter table mink_workflow_runs add column x int;",
      ),
    ).toEqual([]);
  });

  test("catches every category of content a merchant cannot act on", () => {
    const cases = {
      "operator-only": "Platform superadmins use the store management page.",
      "env-flag": "Check the global MINK_AI_ENABLED runtime switch.",
      infrastructure: "Run gcloud auth application-default login and restart.",
      internals: "The card survives Cloud Run restarts using idempotency keys.",
      "phase-label": "Phase 5C is deliberately narrow.",
      "changelog-voice":
        "Older instructions below are superseded by this control.",
    };
    for (const [rule, sentence] of Object.entries(cases)) {
      const found = rules(lintHelpSql(HELP(`<p>${sentence}</p>`)));
      expect(found, `${rule} should be caught in: ${sentence}`).toContain(rule);
    }
  });

  test("the exact paragraph that prompted this linter is rejected", () => {
    // Verbatim from 20260909_0091, which published it to merchants.
    const shipped =
      "<p>Platform superadmins now use one <strong>Enable Mink AI</strong> or " +
      "<strong>Disable Mink AI</strong> button on the store management page.</p>" +
      "<p>The global MINK_AI_ENABLED runtime switch remains an emergency shutdown. " +
      "MINK_BETA_REQUIRE_INVITE no longer bypasses store enablement.</p>";
    expect(rules(lintHelpSql(HELP(shipped)))).toEqual(
      expect.arrayContaining(["env-flag", "operator-only"]),
    );
  });

  test("ordinary merchant guidance is not flagged", () => {
    // A linter that flags normal work is a linter somebody disables. These are
    // real sentences from published guides, including the domain vocabulary
    // (GST, COD, SMS, DLT, AWB, NDR/RTO) that must never look like an env var.
    const ok = [
      "<p>Choose <strong>Refund</strong>, enter the amount, and confirm.</p>",
      "<p>GST is charged at the rate of the product's tax class. COD orders are collected by the courier.</p>",
      "<p>Send an SMS only after your DLT templates are approved. Check the AWB, and handle NDR or RTO in Shiprocket.</p>",
      "<p>Only the store owner can give a discount at the till. Ask your manager for a PIN.</p>",
      "<p>Your plan includes 2 locations. Extra locations are billed monthly.</p>",
      "<p>Pressing Refund twice cannot send the money twice.</p>",
      "<p>StoreMink support must separately enable this for your store.</p>",
      "<p>Set your store timezone in Settings so reports use local dates.</p>",
    ];
    for (const sentence of ok) {
      expect(lintHelpSql(HELP(sentence)), sentence).toEqual([]);
    }
  });

  test("text being DELETED is skipped, so a cleanup migration passes", () => {
    const cleanup =
      "UPDATE public.help_articles SET body = replace(body,\n" +
      "  $old$<p>Platform superadmins use MINK_AI_ENABLED.</p>$old$,\n" +
      "  $new$<p>Ask StoreMink support to switch this on for your store.</p>$new$);";
    expect(lintHelpSql(cleanup)).toEqual([]);
    // ...but the replacement text is still linted.
    const bad = cleanup.replace(
      "$new$<p>Ask StoreMink support to switch this on for your store.</p>$new$",
      "$new$<p>Set MINK_AI_ENABLED on Cloud Run.</p>$new$",
    );
    expect(rules(lintHelpSql(bad))).toEqual(
      expect.arrayContaining(["env-flag", "infrastructure"]),
    );
  });

  test("SQL comments are free, so internals can be explained to the next reader", () => {
    const sql =
      "-- Phase 6A: the worker lease and idempotency keys live in Cloud Run.\n" +
      HELP("<p>Your report keeps running if you close the tab.</p>");
    expect(lintHelpSql(sql)).toEqual([]);
    expect(publishedText(sql)).not.toContain("Phase 6A");
  });

  test("short literals like slugs and statuses are not prose", () => {
    // 'published' and a slug must not be searched for prose defects.
    expect(
      publishedText(
        "update help_articles set status='published' where slug='a-b-c';",
      ),
    ).toBe("");
  });

  test("an allow marker suppresses one rule and requires a reason", () => {
    const marked =
      "-- help-lint: allow phase-label — the merchant-facing rollout is named Phase 2 in the contract\n" +
      HELP("<p>Phase 2 pricing applies.</p>");
    expect(lintHelpSql(marked)).toEqual([]);
    expect(parseAllowMarkers(marked).get("phase-label")).toMatch(/contract/);
    // A marker with no reason is not a marker.
    expect(parseAllowMarkers("-- help-lint: allow phase-label\n").size).toBe(0);
    // It suppresses only the rule it names.
    const partial =
      "-- help-lint: allow phase-label — reason\n" +
      HELP("<p>Phase 2 uses MINK_AI_ENABLED.</p>");
    expect(rules(lintHelpSql(partial))).toEqual(["env-flag"]);
  });

  describe("durable verify may not assert published wording", () => {
    const copyQuery = {
      name: "guide published",
      sql: "select count(*)::text from public.help_articles where slug='g' and body like '%<h2>Do a thing</h2>%'",
      equals: "1",
    };

    test("rejects a copy assertion in the durable block", () => {
      const findings = lintVerifyContract({
        id: "20260911_0094_example",
        verify: { queries: [copyQuery] },
      });
      expect(rules(findings)).toEqual(["durable-verify-copy"]);
      expect(findings[0].message).toMatch(/applyVerify/);
    });

    test("accepts the same assertion in applyVerify, and structure in verify", () => {
      expect(
        lintVerifyContract({
          id: "20260911_0094_example",
          verify: { tables: ["help_articles"] },
          applyVerify: { queries: [copyQuery] },
        }),
      ).toEqual([]);
    });

    test("the seven migrations that froze copy before the rule are recorded", () => {
      expect(GRANDFATHERED_VERIFY.size).toBe(7);
      // 0077 is why "Phase 7B ..." is still in a merchant guide.
      expect(GRANDFATHERED_VERIFY).toContain(
        "20260904_0077_mink_phase_7b_storefront_code_preview",
      );
      expect(
        lintVerifyContract({
          id: "20260904_0077_mink_phase_7b_storefront_code_preview",
          verify: { queries: [copyQuery] },
        }),
      ).toEqual([]);
    });
  });

  test("every rule has a name and an actionable message", () => {
    for (const rule of HELP_LINT_RULES) {
      expect(rule.name).toMatch(/^[a-z][a-z-]*$/);
      expect(rule.message.length).toBeGreaterThan(40);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("the enrolled manifest passes, and grandfathering is not open-ended", () => {
    // Every grandfathered key names a migration and a rule that exists, so a
    // renamed rule cannot silently keep excusing history.
    const names = new Set(HELP_LINT_RULES.map((r) => r.name));
    for (const key of GRANDFATHERED.keys()) {
      const rule = key.slice(key.lastIndexOf(":") + 1);
      expect(names, key).toContain(rule);
    }
  });

  test("the whole manifest is clean today", async () => {
    const { failures, checked } = await lintManifest();
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(80);
  });
});
