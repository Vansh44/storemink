import type { MinkToolDeclaration } from "./types";

export type MinkThinkingLevel = "low" | "high";

const STOREFRONT_CODE_TOOL = "propose_storefront_custom_code";
// ⚠ HIGH reasoning is paid on EVERY turn of the run it fires on, and the RUN is
// what pays: measured on the run ledger, every high-thinking run has failed
// (run_timeout, step_limit_reached, tool_limit_reached) at a mean 91.5s, while
// every low-thinking run finished at a mean 21.2s. So this trigger has to name
// CODE and nothing else.
//
// ★★ `storefront`, `website`, `home page`, `landing page`, `page section`,
// `hero`, `banner` and `carousel` were in this list and are GONE. They are the
// vocabulary of STRUCTURED sections (Phase 9B) and generated images (9E) — the
// commonest storefront request a merchant makes — and none of them implies
// generated code. "create a banner on the home page carousel for this buy 1
// get 1 offer" is an image call plus a layout proposal, and routing it through
// HIGH turned a ~20s run into one that hit the 180s ceiling before it could
// propose anything. A keyword regex cannot separate a layout request from a
// code request by its NOUNS, so it matches only words that can mean nothing
// else. A genuine code request still says so.
//
// `page`, `section` and a bare `code` stay absent for the original reason: they
// also occur in "product page", "the section" and "coupon code", which paired
// with an everyday verb like "update" or "fix" sent ordinary read and draft
// requests down the expensive path.
const CREATION_WORDS =
  "create|build|redesign|generate|write|edit|update|replace|improve|fix|restyle|animate";
const CODE_WORDS = "custom code|code section|custom html|html|css|javascript";
// Co-occurrence across a long message is coincidence, not intent.
const NEAR = 80;
const STOREFRONT_CODE_REQUEST = new RegExp(
  [
    // `design` is leading-only: "explain the current homepage design" is a read.
    `(?:\\bdesign\\b[\\s\\S]{0,${NEAR}}\\b(?:${CODE_WORDS})\\b)`,
    `(?:\\b(?:${CREATION_WORDS})\\b[\\s\\S]{0,${NEAR}}\\b(?:${CODE_WORDS})\\b)`,
    `(?:\\b(?:${CODE_WORDS})\\b[\\s\\S]{0,${NEAR}}\\b(?:${CREATION_WORDS})\\b)`,
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
