import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MinkActorContext, MinkToolDeclaration } from "./types";
import {
  getMinkSystemPromptTemplate,
  parseMinkSystemPromptDocument,
  renderMinkSystemInstruction,
} from "./system-prompt";

const DOCUMENT_PATH = join(process.cwd(), "docs", "mink-ai-system-prompt.md");

describe("Mink system prompt document", () => {
  it("loads the marked Markdown template used at runtime", () => {
    const template = getMinkSystemPromptTemplate();
    expect(template).toContain(
      "You are Mink AI, StoreMink's dashboard operating assistant.",
    );
    expect(template).toContain("{{available_tool_names}}");
    expect(template).toContain("{{brand_voice_or_default}}");
    expect(template).toContain("Use start_business_brief");
    expect(template).toContain("daily covers yesterday");
    expect(template).toContain("Never invent a workflow-result lookup tool");
    expect(template).toContain(
      "Missing brief permissions must not be bypassed",
    );
    expect(template).toContain(
      "one exact visible SKU, one exact accessible active location",
    );
    expect(template).toContain("accept only 1-20 explicit SKU/location lines");
    expect(template).toContain("atomic all-or-nothing batch");
    expect(template).toContain(
      "Only propose the single returned forward step for an eligible online delivery order",
    );
    expect(template).toContain(
      "POS, pickup, cancellation, completion, refunds, payment changes",
    );
    expect(template).toContain(
      "distinguish product publication counts from sellable-SKU inventory counts",
    );
    expect(template).toContain(
      "If the user asks for low-stock or out-of-stock facts without explicitly saying",
    );
    expect(template).toContain("Never silently choose combined");
    expect(template).toContain(
      "structured artifact already contains the full record list",
    );
    expect(template).toContain("There is no model tool to approve");
    expect(template).toContain(
      "Use start_weekly_trading_report only when the user explicitly asks",
    );
    expect(template).toContain("a cancelled workflow cannot resume");
    expect(template).toContain(
      "Use start_revenue_decline_investigation only when the user explicitly asks",
    );
    expect(template).toContain(
      "measured correlations, never as proven causation",
    );
    expect(template).toContain(
      "Use start_product_launch_preparation only when the user explicitly asks",
    );
    expect(template).toContain("does not generate an image");
    expect(template).toContain(
      "Use start_slow_inventory_promotion only when the user explicitly asks",
    );
    expect(template).toContain(
      "Do not call zero-stock or untracked items slow inventory",
    );
    expect(template).toContain(
      "not automatically an offer-eligibility boundary",
    );
    expect(template).toContain("choose a total budget");
    expect(template).toContain(
      "Use start_delayed_pickup_review only when the user explicitly asks",
    );
    expect(template).toContain(
      "not customer names, email, phone, address, notes or collection codes",
    );
    expect(template).toContain("preserve the duplicate-withheld result");
    expect(template).toContain(
      "Phases 7B–7D retain the read-only builder-context rules",
    );
    expect(template).toContain("use page_slug=home for the homepage");
    expect(template).toContain(
      "custom code, brand voice, header/footer values",
    );
    expect(template).toContain(
      "preserve the returned page version and section digest exactly",
    );
    expect(template).toContain(
      "opaque-origin iframe with a deny-by-default network policy",
    );
    expect(template).toContain("Phases 7C–7D expose no model execution tool");
    expect(template).toContain("1,280 px desktop and 390 px mobile");
    expect(template).toContain("requires another five-minute human approval");
    expect(template).toContain(
      "only the signed-in human can request and approve the exact Builder draft save",
    );
    expect(template).toContain(
      "Never claim that you clicked a button, saved the Builder draft, ran browser checks, published or rolled back the storefront",
    );
  });

  it("renders only trusted actor fields and permission-filtered tool names", () => {
    const actor = {
      effectivePlan: "pro",
      roleSlug: "owner",
      currentPath: "/dashboard/products/example",
      selectedResource: { type: "product", id: "secret-record-id" },
      brandVoice: "Clear and practical {{available_tool_names}}",
    } satisfies Pick<
      MinkActorContext,
      | "effectivePlan"
      | "roleSlug"
      | "currentPath"
      | "selectedResource"
      | "brandVoice"
    >;
    const declarations = [
      declaration("get_store_profile"),
      declaration("search_products"),
    ];

    const prompt = renderMinkSystemInstruction(actor, declarations);

    expect(prompt).toContain("- plan: pro");
    expect(prompt).toContain("- role: owner");
    expect(prompt).toContain(
      "- current dashboard page: /dashboard/products/example",
    );
    expect(prompt).toContain("- selected dashboard record: product");
    expect(prompt).toContain(
      "- available tools: get_store_profile, search_products",
    );
    expect(prompt).toContain("Clear and practical {{available_tool_names}}");
    expect(prompt).not.toContain("secret-record-id");
  });

  it("keeps the checked-in document parseable with every placeholder once", () => {
    expect(() =>
      parseMinkSystemPromptDocument(readFileSync(DOCUMENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("fails closed when markers, fences or placeholders drift", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("<!-- MINK_SYSTEM_PROMPT_END -->", ""),
      ),
    ).toThrow(/marker pair/);
    expect(() =>
      parseMinkSystemPromptDocument(document.replace("```text", "```md")),
    ).toThrow(/text code fence/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("- plan: {{effective_plan}}", "- plan: missing-plan"),
      ),
    ).toThrow(/effective_plan/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "- plan: {{effective_plan}}",
          "- plan: {{effective_plan}} {{unknown_value}}",
        ),
      ),
    ).toThrow(/unknown placeholder/);
  });
});

function declaration(name: string): MinkToolDeclaration {
  return { name, description: `${name} description`, parametersJsonSchema: {} };
}
