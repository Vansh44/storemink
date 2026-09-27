import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { DEFAULT_CHROME, sanitizeChromeForSave } from "@/lib/chrome/types";
import { withService } from "@/lib/db/client";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { createMinkDraftProposal } from "./drafts";
import { MinkToolInputError } from "./errors";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import {
  MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
  digestMinkStorefrontDesign,
  summarizeDesignChange,
  validateMinkStorefrontDesignPatch,
  type MinkStorefrontDesignPatch,
} from "./storefront-design-contract";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
import type { ThemeDesign } from "@/lib/themes/types";
import type { MinkDraftContent } from "./draft-types";
import type { MinkActorContext, MinkArtifact } from "./types";

const EXPLANATION_MAX_CHARS = 1_000;

export interface StorefrontDesignTarget {
  design: StorefrontDesignOverrides;
  designDigest: string;
  theme: ThemeDesign | null;
  themeName: string | null;
  /**
   * Whether a `store_chrome` row exists at all.
   *
   * ★ A STORE WITH NO ROW IS NOT AN ERROR, and refusing one would withhold the
   * feature from exactly the stores that have never opened the Brand panel --
   * which is the commonest state, and the one where "make my shop look like
   * this" is most likely to be asked. `DEFAULT_CHROME` is what the storefront
   * already renders for them, so proposing against it proposes against what
   * they can actually see; the execute path creates the row.
   */
  chromeRowExists: boolean;
}

/** The store's current design overrides, and the theme underneath them. */
export async function readStorefrontDesignTarget(
  actor: MinkActorContext,
): Promise<StorefrontDesignTarget> {
  assertBuilderManage(actor);
  return withService(async (db) => {
    const result = await db.execute(sql`
      select store.settings, chrome.store_id as chrome_store_id, chrome.draft
      from stores as store
      left join store_chrome as chrome on chrome.store_id = store.id
      where store.id = ${actor.storeId}
      limit 1
    `);
    const row = result.rows[0] as
      | { settings: unknown; chrome_store_id: string | null; draft: unknown }
      | undefined;
    if (!row) throw new Error("Store not found");
    const settings =
      row.settings && typeof row.settings === "object"
        ? (row.settings as Record<string, unknown>)
        : {};
    const selection = readThemeSelection(settings);
    const definition = await resolveInstalledThemeDefinitionWithDb(
      db,
      selection,
    );
    const chrome = row.chrome_store_id
      ? sanitizeChromeForSave(row.draft)
      : DEFAULT_CHROME;
    const design = chrome.design ?? EMPTY_DESIGN_OVERRIDES;
    return {
      design,
      designDigest: digestMinkStorefrontDesign(design),
      theme: definition?.preset.design ?? null,
      themeName: definition?.name ?? null,
      chromeRowExists: Boolean(row.chrome_store_id),
    };
  });
}

/**
 * Store one immutable private design proposal, charged once.
 *
 * Nothing here writes `store_chrome`. The proposal is a private artifact until
 * a human creates a separate short-lived approval for it.
 */
export async function createMinkStorefrontDesignProposal(input: {
  actor: MinkActorContext;
  patch: unknown;
  explanation: unknown;
}): Promise<Extract<MinkArtifact, { type: "storefront_design_proposal" }>> {
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

  const target = await readStorefrontDesignTarget(input.actor);
  const validation = validateMinkStorefrontDesignPatch(
    input.patch,
    target.theme,
  );
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The proposed design is invalid: ${validation.issues.join(" ")}`,
    );
  }
  const patch = validation.value;

  // The optimistic lock, checked at PROPOSAL time as well as at approval:
  // charging credits for a proposal already known to be stale is a bill for
  // nothing.
  if (target.designDigest !== patch.target.expectedDesignDigest) {
    throw new MinkToolInputError(
      "The storefront design changed. Read the current design again before proposing a new one.",
    );
  }
  if (digestMinkStorefrontDesign(patch.design) === target.designDigest) {
    throw new MinkToolInputError(
      "The proposed design is identical to the store's current design.",
    );
  }

  const summary = summarizeDesignChange(
    patch.design,
    target.design,
    target.theme,
  );
  const patchDigest = digestMinkStorefrontValue(patch);
  const destinationPath = "/dashboard/builder";
  const stored = await createMinkDraftProposal({
    actor: input.actor,
    kind: "storefront_design",
    title: "Storefront design",
    // The chrome row is the write target and the Brand row in the builder
    // inspector is where a merchant edits it by hand, so the destination names
    // the chrome rather than a page.
    destinationType: "storefront_chrome",
    destinationLabel: target.themeName
      ? `Storefront design · ${target.themeName}`
      : "Storefront design",
    destinationPath,
    before: draftContent({
      expectedDesignDigest: target.designDigest,
      patchDigest: target.designDigest,
      design: target.design,
      explanation: "Current storefront design before this proposal.",
    }),
    content: draftContent({
      expectedDesignDigest: patch.target.expectedDesignDigest,
      patchDigest,
      design: patch.design,
      explanation,
    }),
  });
  if (stored.type !== "proposal") {
    throw new Error("Storefront design persistence returned no proposal");
  }

  return {
    type: "storefront_design_proposal",
    draftId: stored.draftId,
    title: stored.title,
    destinationLabel: stored.destinationLabel,
    destinationPath,
    explanation,
    target: patch.target,
    patchDigest,
    summary,
    status: "private_preview",
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}

/**
 * Re-read a stored proposal, refusing anything the contract would not accept.
 *
 * ★ THE CONTRACT RUNS AGAIN ON THE WAY OUT, not only on the way in -- 9B's
 * rule, and here it has a second job. Between creation and approval the
 * merchant may have SWITCHED THEME, and contrast is judged against the
 * resolved pair: a palette that read perfectly over the old preset's page
 * colour can be illegible over the new one. Re-validating against today's
 * theme is what stops an approval shipping that.
 */
export function validateStoredDesignProposal(
  content: MinkDraftContent,
  theme: ThemeDesign | null,
): {
  target: MinkStorefrontDesignPatch["target"];
  design: StorefrontDesignOverrides;
  patchDigest: string;
} {
  let design: unknown;
  try {
    design = JSON.parse(content.design_json ?? "");
  } catch {
    throw new MinkToolInputError("The stored design proposal is unreadable.");
  }
  const validation = validateMinkStorefrontDesignPatch(
    {
      schemaVersion: MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
      operation: "replace_design_overrides",
      target: { expectedDesignDigest: content.expected_design_digest },
      design,
    },
    theme,
  );
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The stored design proposal is no longer valid: ${validation.issues.join(" ")}`,
    );
  }
  // Recomputed from the re-validated patch rather than trusted from the row: a
  // stored digest that disagrees with its own content is exactly the tampering
  // the approval hash exists to refuse.
  const patchDigest = digestMinkStorefrontValue(validation.value);
  if (content.patch_digest && content.patch_digest !== patchDigest) {
    throw new MinkToolInputError(
      "The stored design proposal failed integrity validation.",
    );
  }
  return {
    target: validation.value.target,
    design: validation.value.design,
    patchDigest,
  };
}

/**
 * The design stored on one side of a design draft.
 *
 * ★ THE `before` SIDE IS READ LENIENTLY, the proposal strictly -- 9B's
 * asymmetry, for 9B's reason. `before` is a copy of what the merchant already
 * had, which may legitimately be a palette 9A's publish gate would refuse
 * (that gate arrived after stores existed, and it governs publishing, not
 * saving). Holding the snapshot to the publish bar would make an approval
 * impossible for exactly the stores that most need a design fixed.
 */
export function readStoredDesign(value: unknown): StorefrontDesignOverrides {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).design_json
      : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : "");
  } catch {
    throw new MinkToolInputError("The stored design snapshot is unreadable.");
  }
  return sanitizeChromeForSave({ design: parsed }).design;
}

function draftContent(input: {
  expectedDesignDigest: string;
  patchDigest: string;
  design: StorefrontDesignOverrides;
  explanation: string;
}): MinkDraftContent {
  return {
    expected_design_digest: input.expectedDesignDigest,
    patch_digest: input.patchDigest,
    design_json: JSON.stringify(input.design),
    explanation: input.explanation,
  };
}

function assertBuilderManage(actor: MinkActorContext): void {
  if (actor.draftingEnabled !== true) {
    throw new MinkToolInputError("Mink AI drafting is not enabled.");
  }
  if (!can(actor.permissions, "builder", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(
      "You need Website Builder manage permission to propose a design.",
    );
  }
}
