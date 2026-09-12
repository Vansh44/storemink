import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { createMinkDraftProposal } from "./drafts";
import { MinkToolInputError } from "./errors";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import {
  MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION,
  assertLayoutPreservesCustomCode,
  digestMinkStorefrontSections,
  summarizeLayoutChange,
  resolveKeptLayoutSections,
  validateMinkStorefrontLayoutPatch,
  type MinkStorefrontLayoutPatch,
} from "./storefront-layout-contract";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";
import { readOwnedMediaUrls } from "./storefront-media-read";
import type { MinkDraftContent } from "./draft-types";
import type { MinkActorContext, MinkArtifact } from "./types";

const EXPLANATION_MAX_CHARS = 1_000;

export interface StorefrontLayoutTarget {
  pageSlug: string;
  pageTitle: string;
  pageVersion: string;
  sections: PageSectionItem[];
  sectionsDigest: string;
}

/**
 * Read the exact page whose section list a proposal targets.
 *
 * NOT GATED ON `pages.customCode`, unlike the Phase 7B reader beside it, and
 * the difference is the point: that setting governs whether a merchant may run
 * their own HTML/CSS/JS on the storefront. A hero or a gallery is neither, so
 * requiring it here would withhold ordinary layout editing from every store
 * that has custom code switched off -- which is most of them, since it is a
 * Basic+ entitlement and defaults off.
 */
export async function readStorefrontLayoutTarget(
  actor: MinkActorContext,
  pageSlug: string,
): Promise<StorefrontLayoutTarget> {
  assertBuilderManage(actor);
  const storedSlug = pageSlug === "home" ? "" : pageSlug;
  const result = await withService((db) =>
    db.execute(sql`
      select page.title, page.slug, page.sections, page.updated_at
      from store_pages as page
      where page.store_id = ${actor.storeId}
        and page.slug = ${storedSlug}
      limit 1
    `),
  );
  const row = result.rows[0] as
    | { title: string; slug: string; sections: unknown; updated_at: string }
    | undefined;
  if (!row) {
    throw new MinkToolInputError(
      `No storefront page matches exact slug ${JSON.stringify(pageSlug)}.`,
    );
  }
  // "draft" mode to READ: an existing page may legitimately hold an
  // incomplete section a merchant is still working on, and refusing to look at
  // the page because of it would make the whole feature unavailable to exactly
  // the merchants mid-edit. The PROPOSAL is validated in publish mode.
  const validated = validateSections(row.sections, { mode: "draft" });
  if ("error" in validated) {
    throw new MinkToolInputError(
      `The draft sections for page ${JSON.stringify(pageSlug)} cannot be inspected safely. Repair the page in Website Builder first.`,
    );
  }
  return {
    pageSlug: row.slug === "" ? "home" : row.slug,
    pageTitle: boundedTitle(row.title, pageSlug),
    pageVersion: row.updated_at,
    sections: validated.sections,
    sectionsDigest: digestMinkStorefrontSections(validated.sections),
  };
}

/**
 * Store one immutable private layout proposal, charged once.
 *
 * Nothing here touches store_pages. The proposal is a private artifact until a
 * human creates a separate short-lived approval for it.
 */
export async function createMinkStorefrontLayoutProposal(input: {
  actor: MinkActorContext;
  patch: unknown;
  explanation: unknown;
}): Promise<Extract<MinkArtifact, { type: "storefront_layout_proposal" }>> {
  assertBuilderManage(input.actor);
  if (typeof input.explanation !== "string") {
    throw new MinkToolInputError("explanation must be text.");
  }
  const explanation = input.explanation.normalize("NFKC").trim();
  if (!explanation || explanation.length > EXPLANATION_MAX_CHARS) {
    throw new MinkToolInputError(
      `explanation must be between 1 and ${EXPLANATION_MAX_CHARS.toLocaleString("en-IN")} characters.`,
    );
  }

  // The target is read FIRST, because `keep` references resolve against the
  // exact list the freshness check below is about to assert.
  const requested = readRequestedTarget(input.patch);
  const target = await readStorefrontLayoutTarget(
    input.actor,
    requested.pageSlug,
  );
  const resolved = resolveKeptLayoutSections(
    isRecord(input.patch) ? input.patch.sections : undefined,
    target.sections,
  );
  if (!resolved.ok) {
    throw new MinkToolInputError(
      `The proposed layout is invalid: ${resolved.issues.join(" ")}`,
    );
  }
  const validation = validateMinkStorefrontLayoutPatch({
    ...(isRecord(input.patch) ? input.patch : {}),
    sections: resolved.sections,
  });
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The proposed layout is invalid: ${validation.issues.join(" ")}`,
    );
  }
  const patch = validation.value;
  // The optimistic lock, checked at PROPOSAL time as well as at approval:
  // charging credits for a proposal already known to be stale is a bill for
  // nothing.
  if (
    target.pageVersion !== patch.target.expectedPageVersion ||
    target.sectionsDigest !== patch.target.expectedSectionsDigest
  ) {
    throw new MinkToolInputError(
      "The Website Builder page changed. Read the exact page again before proposing a new layout.",
    );
  }

  const codeIssues = assertLayoutPreservesCustomCode(
    patch.sections,
    target.sections,
  );
  if (codeIssues.length > 0) {
    throw new MinkToolInputError(codeIssues.join(" "));
  }

  // ★★ AND EVERY IMAGE MUST BE ONE THE STORE HAS. `safeHref` accepts any
  //    http(s) string, so without this an invented URL validates, stores,
  //    reviews as "Added: Gallery" and saves as a broken image -- see
  //    storefront-media-policy.ts. Refused HERE as well as at the write,
  //    because charging for a proposal that cannot be approved is a bill for
  //    nothing (the same reason the freshness check runs at proposal time).
  const mediaIssues = await assertProposalMediaIsOwned(
    input.actor.storeId,
    patch.sections,
    target.sections,
  );
  if (mediaIssues.length > 0) {
    throw new MinkToolInputError(mediaIssues.join(" "));
  }

  if (digestMinkStorefrontSections(patch.sections) === target.sectionsDigest) {
    throw new MinkToolInputError(
      "The proposed layout is identical to the current page.",
    );
  }
  const summary = summarizeLayoutChange(patch.sections, target.sections);

  const patchDigest = digestMinkStorefrontValue(patch);
  const destinationPath = `/dashboard/builder?page=${encodeURIComponent(target.pageSlug)}`;
  const stored = await createMinkDraftProposal({
    actor: input.actor,
    kind: "storefront_layout",
    title: `Layout for ${target.pageTitle}`,
    destinationType: "storefront_page",
    destinationLabel: `${target.pageTitle} · layout`,
    destinationPath,
    before: draftContent({
      pageSlug: target.pageSlug,
      pageVersion: target.pageVersion,
      sectionsDigest: target.sectionsDigest,
      patchDigest: target.sectionsDigest,
      sections: target.sections,
      explanation: "Current Website Builder layout before this proposal.",
    }),
    content: draftContent({
      pageSlug: patch.target.pageSlug,
      pageVersion: patch.target.expectedPageVersion,
      sectionsDigest: patch.target.expectedSectionsDigest,
      patchDigest,
      sections: patch.sections,
      explanation,
    }),
  });
  if (stored.type !== "proposal") {
    throw new Error("Storefront layout persistence returned no proposal");
  }

  return {
    type: "storefront_layout_proposal",
    draftId: stored.draftId,
    title: stored.title,
    destinationLabel: stored.destinationLabel,
    destinationPath,
    explanation,
    target: patch.target,
    patchDigest,
    summary,
    sectionCount: patch.sections.length,
    status: "private_preview",
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}

/**
 * Re-read a stored proposal, refusing anything the contract would not accept.
 *
 * ★ THE CONTRACT RUNS AGAIN ON THE WAY OUT, not only on the way in. A proposal
 * is stored for as long as the merchant leaves the card open, and between
 * creation and approval the SECTION REGISTRY may have moved -- a field
 * tightened, a type retired. Re-validating means the only layout that can
 * reach `store_pages.sections` is one today's `validateSections(publish)`
 * accepts, which is the same bar the Builder's own Publish button clears.
 */
export function validateStoredLayoutProposal(content: MinkDraftContent): {
  target: MinkStorefrontLayoutPatch["target"];
  sections: PageSectionItem[];
  patchDigest: string;
} {
  let sections: unknown;
  try {
    sections = JSON.parse(content.sections_json ?? "");
  } catch {
    throw new MinkToolInputError("The stored layout proposal is unreadable.");
  }
  const validation = validateMinkStorefrontLayoutPatch({
    schemaVersion: MINK_STOREFRONT_LAYOUT_SCHEMA_VERSION,
    operation: "replace_page_sections",
    target: {
      pageSlug: content.page_slug,
      expectedPageVersion: content.expected_page_version,
      expectedSectionsDigest: content.expected_sections_digest,
    },
    sections,
  });
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The stored layout proposal is no longer valid: ${validation.issues.join(" ")}`,
    );
  }
  // The digest is recomputed from the re-validated patch rather than trusted
  // from the row: a stored digest that disagrees with its own content is
  // exactly the tampering the approval hash exists to refuse.
  const patchDigest = digestMinkStorefrontValue(validation.value);
  if (content.patch_digest && content.patch_digest !== patchDigest) {
    throw new MinkToolInputError(
      "The stored layout proposal failed integrity validation.",
    );
  }
  return {
    target: validation.value.target,
    sections: validation.value.sections,
    patchDigest,
  };
}

/**
 * The section list stored on one side of a layout draft.
 *
 * ★ THE `before` SIDE IS READ IN DRAFT MODE, THE PROPOSAL IN PUBLISH MODE, and
 * the asymmetry is deliberate. `before` is a copy of what the merchant already
 * had, which may legitimately hold a half-finished section; holding it to the
 * publish bar would make the whole approval impossible for exactly the
 * merchants mid-edit. What we are about to WRITE is held to the publish bar.
 */
export function readStoredLayoutSections(
  value: unknown,
  mode: "draft" | "publish",
): PageSectionItem[] {
  const raw =
    isRecord(value) && typeof value.sections_json === "string"
      ? value.sections_json
      : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new MinkToolInputError("The stored layout snapshot is unreadable.");
  }
  const validated = validateSections(parsed, { mode });
  if ("error" in validated) {
    throw new MinkToolInputError(
      "The stored layout snapshot is no longer valid.",
    );
  }
  return validated.sections;
}

/**
 * The allowlist a layout proposal's images are checked against.
 *
 * ★ THE CURRENT PAGE COMES FIRST AND FOR FREE. A proposal that keeps or moves
 *   an existing block carries that block's images with it, and refusing those
 *   would make the commonest safe edit -- reordering -- impossible. Only URLs
 *   the page does NOT already have are worth a database round trip, so a
 *   pure reorder asks the Media Library nothing at all.
 */
export async function assertProposalMediaIsOwned(
  storeId: string,
  proposed: PageSectionItem[],
  current: PageSectionItem[],
): Promise<string[]> {
  const onPage = new Set(collectSectionMediaUrls(current));
  const candidates = [
    ...new Set(
      collectSectionMediaUrls(proposed).filter((url) => !onPage.has(url)),
    ),
  ];
  const owned = await readOwnedMediaUrls(storeId, candidates);
  return assertLayoutMediaIsOwned(proposed, [...onPage, ...owned]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The page a patch names, read before the patch itself is validated.
 *
 * ★ Only the slug, and only to decide which page to READ. Everything else --
 * including the two freshness values -- is validated by the contract against
 * the resolved list, so a malformed patch is still refused in full; this just
 * cannot wait for that, because resolving `keep` needs the page first.
 */
function readRequestedTarget(patch: unknown): { pageSlug: string } {
  const target = isRecord(patch) ? patch.target : undefined;
  const pageSlug = isRecord(target) ? target.pageSlug : undefined;
  if (typeof pageSlug !== "string" || !pageSlug) {
    throw new MinkToolInputError("target.pageSlug must name an exact page.");
  }
  return { pageSlug };
}

function draftContent(input: {
  pageSlug: string;
  pageVersion: string;
  sectionsDigest: string;
  patchDigest: string;
  sections: PageSectionItem[];
  explanation: string;
}): MinkDraftContent {
  return {
    page_slug: input.pageSlug,
    expected_page_version: input.pageVersion,
    expected_sections_digest: input.sectionsDigest,
    patch_digest: input.patchDigest,
    sections_json: JSON.stringify(input.sections),
    explanation: input.explanation,
  };
}

function assertBuilderManage(actor: MinkActorContext): void {
  if (actor.draftingEnabled !== true) {
    throw new MinkToolInputError("Mink AI drafting is not enabled.");
  }
  if (!can(actor.permissions, "builder", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(
      "You need Website Builder manage permission to propose a layout.",
    );
  }
}

function boundedTitle(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 120);
}
