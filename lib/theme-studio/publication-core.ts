// ---------------------------------------------------------------------------
// Mink AI Theme Studio — Phase 6 rules, with no I/O.
//
// Everything that decides whether a theme may be approved or published, and
// what the published package looks like, lives here so it can be tested
// without a database, and so the review screen and the server agree on the
// rules by importing the same constants.
//
// The database repeats the load-bearing half (migration 0134): an approving
// scorecard below the bar cannot be stored, a project cannot enter `approved`
// without two qualifying reviews, nor `published` without a publication.
// These functions exist to explain a refusal in a sentence before the
// database refuses it with a constraint name.
// ---------------------------------------------------------------------------

import {
  validateThemePackageV2,
  publishedAssetObjectPath,
  type ThemePackageV2,
} from "./contracts";
import { THEME_ASSET_PREFIX } from "./compiler";
import { isPlaceholderAsset } from "./acceptance-gates";
import { validateThemeDefinition } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import {
  MIN_ROW_SCORE,
  REJECT_NOTE_MIN,
  REJECTION_CONDITIONS,
  REVIEWER_ROLES,
  REVIEW_NOTE_MAX,
  SCORECARD_DIMENSIONS,
  scorecardClearsBar,
  type Parsed,
  type RejectionCondition,
  type ReviewerRole,
  type Scorecard,
  type Scores,
} from "./scorecard";

export {
  MIN_ROW_SCORE,
  MIN_TOTAL_SCORE,
  REJECT_NOTE_MIN,
  REJECTION_CONDITIONS,
  REVIEWER_ROLES,
  REVIEW_NOTE_MAX,
  SCORECARD_DIMENSIONS,
  scorecardAverage,
  scorecardClearsBar,
} from "./scorecard";
export type {
  Parsed,
  RejectionCondition,
  ReviewerRole,
  Scorecard,
  ScorecardKey,
  Scores,
} from "./scorecard";

/** Validate a submitted scorecard. Strict: an unknown role, a score outside
 * 1–5, an unknown rejection condition or an approving verdict below the bar
 * is refused rather than corrected. */
export function validateScorecard(input: unknown): Parsed<Scorecard> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const role = REVIEWER_ROLES.find((r) => r.key === raw.role)?.key;
  if (!role) return { ok: false, error: "Choose which review you are giving." };
  const rawScores = (
    raw.scores && typeof raw.scores === "object" ? raw.scores : {}
  ) as Record<string, unknown>;
  const scores = {} as Scores;
  for (const dimension of SCORECARD_DIMENSIONS) {
    const value = rawScores[dimension.key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 5
    ) {
      return {
        ok: false,
        error: `Score "${dimension.label}" from 1 to 5.`,
      };
    }
    scores[dimension.key] = value;
  }
  const rawRejections = Array.isArray(raw.rejections) ? raw.rejections : [];
  const rejections: RejectionCondition[] = [];
  for (const entry of rawRejections) {
    const condition = REJECTION_CONDITIONS.find((c) => c.key === entry)?.key;
    if (!condition) {
      return { ok: false, error: "Unknown rejection condition." };
    }
    if (!rejections.includes(condition)) rejections.push(condition);
  }
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (notes.length > REVIEW_NOTE_MAX) {
    return {
      ok: false,
      error: `Keep the notes under ${REVIEW_NOTE_MAX} characters.`,
    };
  }
  const verdict =
    raw.verdict === "approve" || raw.verdict === "reject" ? raw.verdict : null;
  if (!verdict) return { ok: false, error: "Choose approve or reject." };
  if (verdict === "approve" && !scorecardClearsBar(scores, rejections)) {
    return {
      ok: false,
      error:
        rejections.length > 0
          ? "An automatic-rejection condition is ticked, so this review cannot approve."
          : `Approval needs every row at ${MIN_ROW_SCORE} or more and an average of at least 4.2.`,
    };
  }
  if (verdict === "reject" && notes.length < REJECT_NOTE_MIN) {
    return {
      ok: false,
      error: "Say what must change — the operator revising it needs to know.",
    };
  }
  return { ok: true, value: { role, scores, rejections, verdict, notes } };
}

export interface ReviewFacts {
  role: ReviewerRole;
  verdict: "approve" | "reject";
  reviewerIsAuthor: boolean;
  reviewerEmail: string;
}

export type ApprovalReadiness = { ok: true } | { ok: false; reasons: string[] };

/**
 * Two approving reviews — one from each chair, at least one by a reviewer
 * who did not author the theme — and no rejection, all on the SAME evidence.
 * The caller passes only the reviews bound to the current evidence.
 */
export function approvalReadiness(
  reviews: readonly ReviewFacts[],
): ApprovalReadiness {
  const reasons: string[] = [];
  const rejected = reviews.filter((r) => r.verdict === "reject");
  if (rejected.length > 0) {
    reasons.push(
      "A reviewer rejected this version. Revise it; the next version is reviewed afresh.",
    );
  }
  const approving = reviews.filter((r) => r.verdict === "approve");
  for (const role of REVIEWER_ROLES) {
    if (!approving.some((r) => r.role === role.key)) {
      reasons.push(`It needs an approving ${role.label} review.`);
    }
  }
  if (approving.length > 0 && approving.every((r) => r.reviewerIsAuthor)) {
    reasons.push(
      "At least one approving reviewer must not have authored this theme.",
    );
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * The people who shaped a theme: whoever created the project, asked for a
 * revision, answered its questions or replaced its images. Reviewing your own
 * work is allowed — it is the second chair that must be independent.
 */
export const AUTHORING_EVENTS = [
  "project_created",
  "run_queued",
  "details_added",
  "revision_requested",
  "slot_images_replaced",
] as const;

// ------------------------------------------------------------------ release

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 1.0.0 for a theme's first release; otherwise the next minor above the
 * highest version already stored. Never reuses or overwrites a version. */
export function nextReleaseVersion(existing: readonly string[]): string {
  const parsed = existing
    .map((v) => SEMVER.exec(v))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  if (parsed.length === 0) return "1.0.0";
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor] = parsed[parsed.length - 1];
  // Nothing at 1.0.0 or above exists when the highest is a 0.x draft.
  return major === 0 ? "1.0.0" : `${major}.${minor + 1}.0`;
}

/** Why a version cannot be published as it stands, in the operator's words. */
export function publicationBlockers(pkg: ThemePackageV2): string[] {
  const out: string[] = [];
  const placeholders = pkg.assets.filter(isPlaceholderAsset);
  if (placeholders.length > 0) {
    out.push(
      `${placeholders.length} image slot${placeholders.length === 1 ? " still has a" : "s still have a"} placeholder. Replace ${placeholders.length === 1 ? "it" : "them"} under Images.`,
    );
  }
  if (pkg.provenance.origin !== "generated") {
    out.push("Only a Theme Studio package can be published from here.");
  }
  for (const asset of pkg.assets) {
    if (!asset.path.startsWith(THEME_ASSET_PREFIX)) {
      out.push(`Image ${asset.id} is not a Studio slot.`);
    } else if (!asset.sha256) {
      out.push(`Image ${asset.id} has no stored bytes.`);
    }
  }
  // The same production validator every bundled theme passes (TA-2.1–2.5).
  // Checked here, before anyone reviews, so a theme that could never be
  // published is not approved first and refused at the last step.
  for (const finding of validateThemeDefinition(pkg.definition, {
    bundledAssets: false,
  })) {
    out.push(finding.message);
  }
  return out;
}

/** The public URL of each promoted slot image, by asset id. */
export type PublishedUrlFor = (objectPath: string) => string;

export interface BuildPublishedInput {
  version: string;
  /** YYYY-MM-DD */
  releasedAt: string;
  sourceVersionNumber: number;
  publicUrl: PublishedUrlFor;
}

export interface BuiltRelease {
  pkg: ThemePackageV2;
  /** asset id -> in-bucket object path the bytes must be copied to. */
  objects: { assetId: string; sha256: string; objectPath: string }[];
}

/**
 * The approved draft, as the release a merchant installs: every slot pointed
 * at its immutable public object, the release numbered and published, the
 * catalog entry public and the demo declared healthy.
 *
 * ★ `visibility: public` and `demo: healthy` are written into the immutable
 * package BEFORE the demo is seeded. That is safe because exposure is decided
 * by the catalog POINTER, which publication writes only after the demo
 * renders; a release nobody points at is installable only by an exact pin.
 */
export function buildPublishedPackage(
  draft: ThemePackageV2,
  input: BuildPublishedInput,
): Parsed<BuiltRelease> {
  const blockers = publicationBlockers(draft);
  if (blockers.length > 0) return { ok: false, error: blockers[0] };
  if (!SEMVER.test(input.version)) {
    return { ok: false, error: "The release version must be semver." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.releasedAt)) {
    return { ok: false, error: "The release date must be YYYY-MM-DD." };
  }
  const themeId = draft.definition.id;
  const objects = draft.assets.map((asset) => ({
    assetId: asset.id,
    sha256: asset.sha256 as string,
    objectPath: publishedAssetObjectPath({
      themeId,
      version: input.version,
      assetId: asset.id,
      sha256: asset.sha256 as string,
    }),
  }));
  const urlForSlot = new Map(
    objects.map((o) => [o.assetId, input.publicUrl(o.objectPath)]),
  );
  const pathForDraft = new Map(
    draft.assets.map((asset) => [asset.path, urlForSlot.get(asset.id)!]),
  );
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return pathForDraft.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return value;
  };
  const definition = walk(structuredClone(draft.definition)) as ThemeDefinition;
  definition.release = {
    version: input.version,
    status: "published",
    releasedAt: input.releasedAt,
    notes: [
      `Published from Theme Studio version ${input.sourceVersionNumber}.`,
    ],
  };
  definition.catalog = { ...definition.catalog, visibility: "public" };
  definition.demo = { slug: `demo-${themeId}`, status: "healthy" };
  const candidate: ThemePackageV2 = {
    ...draft,
    definition,
    assets: draft.assets.map((asset) => ({
      ...asset,
      path: urlForSlot.get(asset.id)!,
    })),
  };
  const parsed = validateThemePackageV2(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `The published package failed its contract: ${parsed.issues[0]}`,
    };
  }
  const findings = validateThemeDefinition(parsed.value.definition, {
    bundledAssets: false,
  });
  if (findings.length > 0) {
    return {
      ok: false,
      error: `The published theme failed validation: ${findings[0].message}`,
    };
  }
  return { ok: true, value: { pkg: parsed.value, objects } };
}

/** The date a release is dated with. India first, like the rest of the
 * operator console — a release published at 01:00 IST is dated that day. */
export function releaseDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// ------------------------------------------------------------------ catalog

export const CATALOG_REASON_MAX = 500;

export type CatalogChange =
  | { action: "hide"; reason: string }
  | { action: "show"; reason: string }
  | { action: "select_release"; version: string; reason: string };

export function validateCatalogChange(input: unknown): Parsed<CatalogChange> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length < 3) {
    return { ok: false, error: "Give a short reason; it goes in the audit." };
  }
  if (reason.length > CATALOG_REASON_MAX) {
    return {
      ok: false,
      error: `Keep the reason under ${CATALOG_REASON_MAX} characters.`,
    };
  }
  if (raw.action === "hide" || raw.action === "show") {
    return { ok: true, value: { action: raw.action, reason } };
  }
  if (raw.action === "select_release") {
    if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
      return { ok: false, error: "Choose a release." };
    }
    return {
      ok: true,
      value: { action: "select_release", version: raw.version, reason },
    };
  }
  return { ok: false, error: "Unknown catalog change." };
}
