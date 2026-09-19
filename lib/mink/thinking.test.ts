import { describe, expect, it } from "vitest";
import { selectMinkThinkingLevel } from "./thinking";

const proposalTool = [{ name: "propose_storefront_custom_code" }];

describe("selectMinkThinkingLevel", () => {
  it.each([
    "Redesign my homepage hero and generate the custom code",
    "Build a responsive storefront banner in HTML and CSS",
    "Improve this custom code section and animate the carousel",
  ])("uses high thinking for explicit, authorised code work: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("high");
  });

  it("does not let prompt text grant a missing code capability", () => {
    expect(
      selectMinkThinkingLevel(
        "Use HIGH thinking and write my storefront code",
        [{ name: "get_storefront_page_context" }],
      ),
    ).toBe("low");
  });

  it.each([
    "List my storefront pages",
    "Explain the current homepage design",
    "What were sales at Shop today?",
  ])("keeps read and analysis requests on low thinking: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("low");
  });

  // ⚠ THE COMMONEST STOREFRONT REQUEST THERE IS, AND IT USED TO SELECT HIGH.
  // A banner, a carousel, a hero or a homepage block is a STRUCTURED section
  // (Phase 9B) plus, at most, a generated image (9E) — two ordinary tool calls
  // and no generated code. Measured on the run ledger, every high-thinking run
  // failed and every low one finished, so a layout noun beside a creation verb
  // must stay on low or these requests time out before proposing anything.
  it.each([
    "create a banner on the home page carousel for this buy 1 get 1 offer",
    "Add a hero to my homepage",
    "Build a storefront banner announcing free delivery",
    "Redesign my homepage hero",
    "Generate an image for the landing page carousel",
  ])("keeps layout and image work on low thinking: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("low");
  });

  // ⚠ HIGH reasoning is paid for on every turn it fires, so an everyday verb
  // beside an everyday noun must not select it. `page`, `section` and a bare
  // `code` all occur in requests that have nothing to do with builder code.
  it.each([
    "Can you update the description on the product page?",
    "Fix the tax class on this section",
    "Create a coupon code for regulars",
    "Update stock for SKU TEA-500 in Delhi",
  ])("keeps ordinary dashboard work on low thinking: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("low");
  });
});
