import type { MinkToolDeclaration } from "./types";

export type MinkThinkingLevel = "low" | "high";

const STOREFRONT_CODE_TOOL = "propose_storefront_custom_code";
// ⚠ HIGH reasoning costs latency, thinking tokens and shadow-cost accuracy on
// EVERY turn it fires, so the surface nouns have to be specific to storefront
// code. `page`, `section` and a bare `code` are deliberately absent: they also
// occur in "product page", "the section" and "coupon code", which paired with
// an everyday verb like "update" or "fix" sent ordinary read and draft
// requests down the expensive path.
const CREATION_WORDS =
  "create|build|redesign|generate|write|edit|update|replace|improve|fix|restyle|animate";
const STOREFRONT_WORDS =
  "storefront|website|home ?page|landing page|page section|hero|banner|carousel|custom code|html|css|javascript";
// Co-occurrence across a long message is coincidence, not intent.
const NEAR = 80;
const STOREFRONT_CODE_REQUEST = new RegExp(
  [
    // `design` is leading-only: "explain the current homepage design" is a read.
    `(?:\\bdesign\\b[\\s\\S]{0,${NEAR}}\\b(?:${STOREFRONT_WORDS})\\b)`,
    `(?:\\b(?:${CREATION_WORDS})\\b[\\s\\S]{0,${NEAR}}\\b(?:${STOREFRONT_WORDS})\\b)`,
    `(?:\\b(?:${STOREFRONT_WORDS})\\b[\\s\\S]{0,${NEAR}}\\b(?:${CREATION_WORDS})\\b)`,
  ].join("|"),
  "i",
);

/**
 * Select expensive reasoning only for an explicit code-generation request and
 * only when the trusted registry has exposed the Phase 7B proposal tool. The
 * user's text can request effort, but it cannot grant itself a capability.
 */
export function selectMinkThinkingLevel(
  message: string,
  declarations: Pick<MinkToolDeclaration, "name">[],
): MinkThinkingLevel {
  const canProposeStorefrontCode = declarations.some(
    (declaration) => declaration.name === STOREFRONT_CODE_TOOL,
  );
  return canProposeStorefrontCode && STOREFRONT_CODE_REQUEST.test(message)
    ? "high"
    : "low";
}
