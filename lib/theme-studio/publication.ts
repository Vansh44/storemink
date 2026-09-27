import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import {
  stores,
  themeCatalogAudit,
  themeCatalogEntries,
  themeReleases,
  themeStudioAcceptanceRuns,
  themeStudioAssets,
  themeStudioEvents,
  themeStudioProjects,
  themeStudioPublications,
  themeStudioReviews,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import {
  gcsConfigured,
  gcsPathFromUrl,
  gcsPublicUrl,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { STORE_TAG } from "@/lib/store/resolve";
import { subdomainOrigin } from "@/lib/store/host";
import { TAGS } from "@/lib/storefront/tags";
import { applyThemeDefinition } from "@/lib/themes/apply";
import {
  THEME_REGISTRY_TAG,
  insertThemeReleaseWithDb,
  loadExactReleaseWithDb,
  type RuntimeThemeRelease,
} from "@/lib/themes/runtime-registry";
import type { ThemeCatalogVisibility } from "@/lib/themes/meta";
import type { ThemeStudioActor } from "./access";
import { renderedWithTheme } from "./acceptance-gates";
import { verifyCandidateEvidenceWithDb } from "./acceptance";
import { fetchInternalPageWithRetry } from "./acceptance-http";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import {
  AUTHORING_EVENTS,
  SCORECARD_DIMENSIONS,
  approvalReadiness,
  buildPublishedPackage,
  nextReleaseVersion,
  publicationBlockers,
  releaseDate,
  validateCatalogChange,
  validateScorecard,
  type ReviewFacts,
  type ReviewerRole,
  type Scores,
} from "./publication-core";
import { isUuid, recordThemeStudioEvent, ThemeStudioError } from "./repository";

// ---------------------------------------------------------------------------
// Mink AI Theme Studio — Phase 6: approval, publication and rollback.
//
// Order of publication (docs/mink-ai-theme-studio-plan.md §8):
//   1. lock the project and re-read the approved version;
//   2. re-verify the evidence and the two reviews by digest;
//   3. allocate a release version without overwriting (or resume the one a
//      failed attempt allocated) and write the attempt row;
//   4. copy every slot image to the immutable public release prefix;
//   5. write the immutable theme_releases row;
//   6. seed demo-{theme} and render its surfaces — zero errors;
//   7. only then point the catalog at the release, public, and mark the
//      project published, with an audit row, in one transaction;
//   8. invalidate the registry, store and storefront caches.
//
// ★ EXPOSURE IS THE LAST STEP. A release row nobody points at is invisible to
// signup and the public catalog, so a failed demo leaves nothing a merchant
// can see, and a retry resumes the same release instead of allocating a new
// one.
//
// ★ ROLLBACK NEVER TOUCHES AN INSTALLED STORE. Hiding or re-pointing changes
// only what NEW stores may install; every store pins its own theme id and
// version, and an exact pin keeps resolving while the release is published.
// ---------------------------------------------------------------------------

export interface PublicationDeps {
  /** Copy one image to public storage. Must be idempotent for a path. */
  storeObject(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  publicUrl(objectPath: string): string;
  /** Render the demo's surfaces; returns what was wrong, empty when clean. */
  checkDemo(input: { host: string; paths: string[] }): Promise<string[]>;
  now(): Date;
}

const DEMO_PAGE_TIMEOUT_MS = 60_000;

async function defaultCheckDemo(input: {
  host: string;
  paths: string[];
}): Promise<string[]> {
  const problems: string[] = [];
  for (const path of input.paths) {
    const page = await fetchInternalPageWithRetry({
      host: input.host,
      path,
      cookies: {},
      timeoutMs: DEMO_PAGE_TIMEOUT_MS,
    });
    if (page.status !== 200) {
      problems.push(
        `${path} answered ${page.status ?? page.error ?? "nothing"}.`,
      );
    } else if (!renderedWithTheme(page.body)) {
      problems.push(`${path} did not render with the theme.`);
    }
  }
  return problems;
}

const defaultDeps: PublicationDeps = {
  async storeObject(objectPath, bytes, contentType) {
    // The path names the release and the image's digest, so its bytes can
    // never change: the cache may keep it for a year.
    await gcsUploadObject(
      objectPath,
      bytes,
      contentType,
      "public, max-age=31536000, immutable",
    );
  },
  publicUrl: gcsPublicUrl,
  checkDemo: defaultCheckDemo,
  now: () => new Date(),
};

/** An attempt still `publishing` this long after its last write was
 * abandoned (the instance was recycled mid-publication) and may be retried. */
const ABANDONED_ATTEMPT_MINUTES = 15;

// ------------------------------------------------------------------ helpers

async function lockProject(db: Db, projectId: string) {
  const rows = await db
    .select()
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .for("update")
    .limit(1);
  const project = rows[0];
  if (!project) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  return project;
}

async function lockThemeId(db: Db, themeId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`theme-publication:${themeId}`}))`,
  );
}

/** Everyone who shaped this theme (publication-core AUTHORING_EVENTS). */
async function authorEmails(db: Db, projectId: string, creator: string) {
  const rows = await db
    .selectDistinct({ email: themeStudioEvents.actorEmail })
    .from(themeStudioEvents)
    .where(
      and(
        eq(themeStudioEvents.projectId, projectId),
        inArray(themeStudioEvents.eventType, [...AUTHORING_EVENTS]),
      ),
    );
  const emails = new Set([creator.toLowerCase()]);
  for (const row of rows) if (row.email) emails.add(row.email.toLowerCase());
  return emails;
}

type ReviewRow = typeof themeStudioReviews.$inferSelect;

function reviewFacts(rows: readonly ReviewRow[]): ReviewFacts[] {
  return rows.map((row) => ({
    role: row.reviewerRole as ReviewerRole,
    verdict: row.verdict as "approve" | "reject",
    reviewerIsAuthor: row.reviewerIsAuthor,
    reviewerEmail: row.createdByEmail,
  }));
}

async function reviewsForRun(db: Db, runId: string) {
  return db
    .select()
    .from(themeStudioReviews)
    .where(eq(themeStudioReviews.acceptanceRunId, runId))
    .orderBy(themeStudioReviews.createdAt);
}

function scoresOf(row: ReviewRow): Scores {
  return {
    artDirection: row.artDirection,
    distinctness: row.distinctness,
    commerceClarity: row.commerceClarity,
    typography: row.typography,
    imagery: row.imagery,
    responsiveComposition: row.responsiveComposition,
    detailQuality: row.detailQuality,
    brandAdaptability: row.brandAdaptability,
  };
}

/** The violated constraint's name, from a pg error or Drizzle's wrapper. */
function constraintOf(error: unknown): string {
  const direct = (error as { constraint?: unknown })?.constraint;
  const nested = (error as { cause?: { constraint?: unknown } })?.cause
    ?.constraint;
  return String(direct ?? nested ?? "");
}

function expireCaches() {
  // Immediate expiry, not stale-while-revalidate: publication reads its own
  // writes (the demo check renders the release it just stored), and an
  // operator who hides a theme expects the next signup to stop offering it.
  for (const tag of [
    THEME_REGISTRY_TAG,
    STORE_TAG,
    TAGS.pages,
    TAGS.products,
    TAGS.categories,
    TAGS.chrome,
  ]) {
    revalidateTag(tag, { expire: 0 });
  }
}

// ------------------------------------------------------------------ reviews

export async function submitThemeStudioReview(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    versionId: string;
    expectedPackageDigest: string;
    scorecard: unknown;
  },
): Promise<{ reviewId: string }> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  const parsed = validateScorecard(input.scorecard);
  if (!parsed.ok) throw new ThemeStudioError("invalid_input", parsed.error);
  const card = parsed.value;
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    if (project.status !== "candidate") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only a candidate can be reviewed. Pass the acceptance checks first.",
      );
    }
    if (project.currentVersionId !== input.versionId) {
      throw new ThemeStudioError(
        "stale",
        "The current version changed. Reload before reviewing.",
      );
    }
    const evidence = await verifyCandidateEvidenceWithDb(db, project);
    if (!evidence.ok) throw new ThemeStudioError("stale", evidence.reason);
    const [version] = await db
      .select({ packageDigest: themeStudioVersions.packageDigest })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.id, input.versionId))
      .limit(1);
    if (
      !version?.packageDigest ||
      version.packageDigest !== input.expectedPackageDigest
    ) {
      throw new ThemeStudioError(
        "stale",
        "You reviewed a different version. Reload to review the current one.",
      );
    }
    const authors = await authorEmails(db, project.id, project.createdByEmail);
    const reviewerIsAuthor = authors.has(actor.email.toLowerCase());
    try {
      const [row] = await db
        .insert(themeStudioReviews)
        .values({
          projectId: project.id,
          versionId: input.versionId,
          acceptanceRunId: evidence.runId,
          packageDigest: version.packageDigest,
          evidenceDigest: evidence.evidenceDigest,
          reviewerRole: card.role,
          reviewerIsAuthor,
          artDirection: card.scores.artDirection,
          distinctness: card.scores.distinctness,
          commerceClarity: card.scores.commerceClarity,
          typography: card.scores.typography,
          imagery: card.scores.imagery,
          responsiveComposition: card.scores.responsiveComposition,
          detailQuality: card.scores.detailQuality,
          brandAdaptability: card.scores.brandAdaptability,
          rejections: card.rejections,
          verdict: card.verdict,
          notes: card.notes,
          createdBy: actor.id,
          createdByEmail: actor.email,
        })
        .returning({ id: themeStudioReviews.id });
      await recordThemeStudioEvent(db, {
        projectId: project.id,
        actor,
        eventType: "review_submitted",
        detail: {
          versionId: input.versionId,
          reviewId: row.id,
          role: card.role,
          verdict: card.verdict,
          reviewerIsAuthor,
        },
      });
      return { reviewId: row.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const constraint = constraintOf(error);
        throw new ThemeStudioError(
          "illegal_state",
          constraint.includes("reviewer")
            ? "You have already reviewed this version. The other review needs a second reviewer."
            : "That review has already been given for this version.",
        );
      }
      throw error;
    }
  });
}

export async function approveThemeStudioCandidate(
  actor: ThemeStudioActor,
  input: { projectId: string; expectedRevision: number },
): Promise<void> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  await withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (project.status !== "candidate") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only a candidate can be approved.",
      );
    }
    const evidence = await verifyCandidateEvidenceWithDb(db, project);
    if (!evidence.ok) throw new ThemeStudioError("stale", evidence.reason);
    const reviews = await reviewsForRun(db, evidence.runId);
    const readiness = approvalReadiness(reviewFacts(reviews));
    if (!readiness.ok) {
      throw new ThemeStudioError("illegal_state", readiness.reasons[0]);
    }
    // Approving means "publish this"; a version the publisher would refuse
    // is not approvable.
    const [version] = await db
      .select({ packageJson: themeStudioVersions.packageJson })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.id, project.currentVersionId!))
      .limit(1);
    const parsed = validateThemePackageV2(version?.packageJson);
    const blockers = parsed.ok
      ? publicationBlockers(parsed.value)
      : ["The version no longer passes its contract."];
    if (blockers.length > 0) {
      throw new ThemeStudioError("illegal_state", blockers[0]);
    }
    await db
      .update(themeStudioProjects)
      .set({ status: "approved", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "project_approved",
      detail: {
        versionId: project.currentVersionId,
        acceptanceRunId: evidence.runId,
        reviewIds: reviews.map((r) => r.id),
      },
    });
  });
}

// -------------------------------------------------------------- publication

interface BegunAttempt {
  attemptId: string;
  themeId: string;
  releaseVersion: string;
  versionId: string;
  versionNumber: number;
  draft: ThemePackageV2;
  resumedReleaseId: string | null;
}

async function beginAttempt(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
    confirmThemeId: string;
  },
): Promise<BegunAttempt> {
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (project.status !== "approved") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only an approved project can be published.",
      );
    }
    if (input.confirmThemeId.trim() !== project.themeId) {
      throw new ThemeStudioError(
        "invalid_input",
        `Type the theme id, ${project.themeId}, to confirm.`,
      );
    }
    await lockThemeId(db, project.themeId);

    const evidence = await verifyCandidateEvidenceWithDb(db, project, {
      status: "approved",
      requireCurrentBuild: false,
    });
    if (!evidence.ok) throw new ThemeStudioError("stale", evidence.reason);
    const readiness = approvalReadiness(
      reviewFacts(await reviewsForRun(db, evidence.runId)),
    );
    if (!readiness.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "The approval no longer covers the current evidence.",
      );
    }
    const [version] = await db
      .select()
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.id, project.currentVersionId!))
      .limit(1);
    const parsed = validateThemePackageV2(version?.packageJson);
    if (!version || !parsed.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "The approved version no longer passes its contract.",
      );
    }
    const blockers = publicationBlockers(parsed.value);
    if (blockers.length > 0) {
      throw new ThemeStudioError("illegal_state", blockers[0]);
    }

    const attempts = await db
      .select()
      .from(themeStudioPublications)
      .where(eq(themeStudioPublications.projectId, project.id))
      .orderBy(desc(themeStudioPublications.createdAt));
    if (attempts.some((a) => a.status === "published")) {
      throw new ThemeStudioError(
        "illegal_state",
        "This project is already published.",
      );
    }
    const active = attempts.find((a) => a.status === "publishing");
    if (active) {
      const age = Date.now() - Date.parse(active.updatedAt);
      if (age < ABANDONED_ATTEMPT_MINUTES * 60_000) {
        throw new ThemeStudioError(
          "illegal_state",
          "A publication is already in progress.",
        );
      }
      await db
        .update(themeStudioPublications)
        .set({
          status: "failed",
          completedAt: sql`now()`,
          failure: ["The attempt was abandoned before it finished."],
        })
        .where(eq(themeStudioPublications.id, active.id));
    }

    // Resume the release an earlier attempt of THIS version already stored:
    // the row is immutable, and rebuilding it on another day would change its
    // release date — and so its digest — and collide with itself.
    const resumable = attempts.find(
      (a) => a.versionId === version.id && a.releaseId,
    );
    let releaseVersion: string;
    if (resumable) {
      releaseVersion = resumable.releaseVersion;
    } else {
      const existing = await db
        .select({ version: themeReleases.version })
        .from(themeReleases)
        .where(eq(themeReleases.themeId, project.themeId));
      releaseVersion = nextReleaseVersion(existing.map((r) => r.version));
    }

    const [attempt] = await db
      .insert(themeStudioPublications)
      .values({
        projectId: project.id,
        versionId: version.id,
        acceptanceRunId: evidence.runId,
        themeId: project.themeId,
        releaseVersion,
        releaseId: resumable?.releaseId ?? null,
        manifestDigest: resumable?.manifestDigest ?? null,
        createdBy: actor.id,
        createdByEmail: actor.email,
      })
      .returning({ id: themeStudioPublications.id });
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "publication_started",
      detail: {
        publicationId: attempt.id,
        versionId: version.id,
        releaseVersion,
        resumed: Boolean(resumable),
      },
    });
    return {
      attemptId: attempt.id,
      themeId: project.themeId,
      releaseVersion,
      versionId: version.id,
      versionNumber: version.versionNumber,
      draft: parsed.value,
      resumedReleaseId: resumable?.releaseId ?? null,
    };
  });
}

class PublicationFailure extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "Publication failed.");
    this.name = "PublicationFailure";
  }
}

async function failAttempt(
  actor: ThemeStudioActor,
  attempt: BegunAttempt,
  projectId: string,
  problems: string[],
): Promise<void> {
  const failure = problems.slice(0, 20).map((p) => p.slice(0, 500));
  await withService(async (db) => {
    await db
      .update(themeStudioPublications)
      .set({ status: "failed", completedAt: sql`now()`, failure })
      .where(
        and(
          eq(themeStudioPublications.id, attempt.attemptId),
          eq(themeStudioPublications.status, "publishing"),
        ),
      );
    await recordThemeStudioEvent(db, {
      projectId,
      actor,
      eventType: "publication_failed",
      detail: { publicationId: attempt.attemptId, problems: failure },
    });
  });
}

/** Copy every image the release names to its public object, checking the
 * stored bytes against the digest the package declares. */
async function promoteImages(
  deps: PublicationDeps,
  projectId: string,
  pkg: ThemePackageV2,
): Promise<void> {
  const wanted = pkg.assets.map((asset) => ({
    asset,
    objectPath: gcsPathFromUrl(asset.path) ?? objectPathFromUrl(asset.path),
  }));
  const digests = pkg.assets
    .map((a) => a.sha256)
    .filter((s): s is string => Boolean(s));
  const rows = await withService((db) =>
    db
      .select({
        sha256: themeStudioAssets.sha256,
        mediaType: themeStudioAssets.mediaType,
        bytes: themeStudioAssets.bytes,
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "image"),
          inArray(themeStudioAssets.sha256, digests),
        ),
      ),
  );
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const problems: string[] = [];
  for (const { asset, objectPath } of wanted) {
    const row = asset.sha256 ? bySha.get(asset.sha256) : undefined;
    if (!objectPath) {
      problems.push(`Image ${asset.id} has no release address.`);
      continue;
    }
    if (!row) {
      problems.push(`Image ${asset.id} has no stored operator image.`);
      continue;
    }
    const actual = createHash("sha256").update(row.bytes).digest("hex");
    if (actual !== asset.sha256) {
      problems.push(`Image ${asset.id}'s stored bytes do not match it.`);
      continue;
    }
    if (row.mediaType !== "image/webp") {
      problems.push(`Image ${asset.id} is not WebP.`);
      continue;
    }
    try {
      await deps.storeObject(objectPath, row.bytes, row.mediaType);
    } catch (error) {
      logError("theme studio: publishing an image failed", error, {
        assetId: asset.id,
      });
      problems.push(`Image ${asset.id} could not be copied to storage.`);
    }
  }
  if (problems.length > 0) throw new PublicationFailure(problems);
}

/** The in-bucket path of a published image URL, for any bucket host the
 * injected storage uses (the real parser only knows the configured bucket). */
function objectPathFromUrl(url: string): string | null {
  const match = /\/(theme-releases\/[^?#]+)$/.exec(url);
  return match && !match[1].split("/").includes("..") ? match[1] : null;
}

async function storeRelease(
  actor: ThemeStudioActor,
  deps: PublicationDeps,
  projectId: string,
  attempt: BegunAttempt,
): Promise<RuntimeThemeRelease> {
  if (attempt.resumedReleaseId) {
    const release = await withService((db) =>
      loadExactReleaseWithDb(db, attempt.themeId, attempt.releaseVersion),
    );
    if (!release || release.id !== attempt.resumedReleaseId) {
      throw new PublicationFailure([
        "The release an earlier attempt stored no longer validates.",
      ]);
    }
    await promoteImages(deps, projectId, release.package);
    return release;
  }
  const built = buildPublishedPackage(attempt.draft, {
    version: attempt.releaseVersion,
    releasedAt: releaseDate(deps.now()),
    sourceVersionNumber: attempt.versionNumber,
    publicUrl: deps.publicUrl,
  });
  if (!built.ok) throw new PublicationFailure([built.error]);
  await promoteImages(deps, projectId, built.value.pkg);
  return withService(async (db) => {
    const { release } = await insertThemeReleaseWithDb(db, {
      package: built.value.pkg,
      source: "theme-studio",
      actorId: actor.id,
    });
    await db
      .update(themeStudioPublications)
      .set({ releaseId: release.id, manifestDigest: release.manifestDigest })
      .where(eq(themeStudioPublications.id, attempt.attemptId));
    return release;
  });
}

/** Create or reset demo-{theme} and seed it from the exact release. */
async function seedDemo(
  release: RuntimeThemeRelease,
): Promise<{ storeId: string; slug: string }> {
  const definition = release.definition;
  const slug = definition.demo.slug;
  const storeId = await withService(async (db) => {
    const [existing] = await db
      .select({ id: stores.id, settings: stores.settings })
      .from(stores)
      .where(eq(stores.slug, slug))
      .limit(1);
    if (existing) {
      const settings = (existing.settings ?? {}) as Record<string, unknown>;
      if (settings.demo !== true) {
        throw new PublicationFailure([
          `The store ${slug} exists and is not a demo store.`,
        ]);
      }
      return existing.id;
    }
    const [created] = await db
      .insert(stores)
      .values({
        slug,
        name: `${definition.name} Demo`,
        status: "active",
        plan: "free",
        settings: {
          demo: true,
          template: definition.id,
          brand: { name: `${definition.name} Demo` },
        },
      })
      .returning({ id: stores.id });
    return created.id;
  });
  const seeded = await applyThemeDefinition(storeId, definition, {
    publish: true,
    reset: true,
    publishSampleProducts: true,
  });
  if (!seeded.success) {
    throw new PublicationFailure(
      seeded.errors.map((e) => `Demo seeding: ${e}`),
    );
  }
  return { storeId, slug };
}

function demoPaths(release: RuntimeThemeRelease): string[] {
  const product = release.definition.preset.sampleData?.products[0];
  return ["/", "/shop", ...(product ? [`/shop/${product.slug}`] : []), "/cart"];
}

async function exposeRelease(
  actor: ThemeStudioActor,
  input: { projectId: string },
  attempt: BegunAttempt,
  release: RuntimeThemeRelease,
  demoStoreId: string,
): Promise<void> {
  await withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    await lockThemeId(db, attempt.themeId);
    if (
      project.status !== "approved" ||
      project.currentVersionId !== attempt.versionId
    ) {
      throw new PublicationFailure([
        "The project changed while it was being published.",
      ]);
    }
    const [previous] = await db
      .select()
      .from(themeCatalogEntries)
      .where(eq(themeCatalogEntries.themeId, attempt.themeId))
      .limit(1);
    await db
      .insert(themeCatalogEntries)
      .values({
        themeId: attempt.themeId,
        currentReleaseId: release.id,
        visibility: "public",
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: themeCatalogEntries.themeId,
        set: {
          currentReleaseId: release.id,
          visibility: "public",
          updatedBy: actor.id,
        },
      });
    await db.insert(themeCatalogAudit).values({
      themeId: attempt.themeId,
      action: "publish",
      releaseId: release.id,
      visibility: "public",
      previousReleaseId: previous?.currentReleaseId ?? null,
      previousVisibility: previous?.visibility ?? null,
      projectId: project.id,
      reason: `Published ${attempt.themeId}@${attempt.releaseVersion} from Theme Studio version ${attempt.versionNumber}.`,
      createdBy: actor.id,
      createdByEmail: actor.email,
    });
    await db
      .update(themeStudioPublications)
      .set({
        status: "published",
        completedAt: sql`now()`,
        demoStoreId,
        releaseId: release.id,
        manifestDigest: release.manifestDigest,
      })
      .where(eq(themeStudioPublications.id, attempt.attemptId));
    await db
      .update(themeStudioProjects)
      .set({ status: "published", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "theme_published",
      detail: {
        publicationId: attempt.attemptId,
        releaseId: release.id,
        themeId: attempt.themeId,
        releaseVersion: attempt.releaseVersion,
        manifestDigest: release.manifestDigest,
      },
    });
  });
}

export type PublicationResult =
  | {
      ok: true;
      publicationId: string;
      themeId: string;
      releaseVersion: string;
      demoSlug: string;
    }
  | { ok: false; publicationId: string; problems: string[] };

/**
 * Publish an approved project. A refusal before anything is written throws a
 * ThemeStudioError; a failure after the attempt row exists is recorded on it
 * and returned, and the project stays approved so the operator can retry.
 */
export async function publishThemeStudioProject(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
    confirmThemeId: string;
  },
  deps: PublicationDeps = defaultDeps,
): Promise<PublicationResult> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  if (deps === defaultDeps && !gcsConfigured) {
    throw new ThemeStudioError(
      "illegal_state",
      "Media storage is not configured, so the theme's images cannot be published.",
    );
  }
  const attempt = await beginAttempt(actor, {
    projectId: input.projectId,
    expectedRevision: Number(input.expectedRevision),
    confirmThemeId: String(input.confirmThemeId ?? ""),
  });
  try {
    const release = await storeRelease(actor, deps, input.projectId, attempt);
    // The demo store renders the release by its exact pin; expire the
    // registry so no earlier miss for that pin is served.
    expireCaches();
    const demo = await seedDemo(release);
    expireCaches();
    const problems = await deps.checkDemo({
      host: new URL(subdomainOrigin(demo.slug)).host,
      paths: demoPaths(release),
    });
    if (problems.length > 0) {
      throw new PublicationFailure(problems.map((p) => `Demo: ${p}`));
    }
    await exposeRelease(actor, input, attempt, release, demo.storeId);
    expireCaches();
    return {
      ok: true,
      publicationId: attempt.attemptId,
      themeId: attempt.themeId,
      releaseVersion: attempt.releaseVersion,
      demoSlug: demo.slug,
    };
  } catch (error) {
    const problems =
      error instanceof PublicationFailure
        ? error.problems
        : ["Something went wrong while publishing. Nothing was exposed."];
    if (!(error instanceof PublicationFailure)) {
      logError("theme studio: publication failed", error, {
        publicationId: attempt.attemptId,
      });
    }
    await failAttempt(actor, attempt, input.projectId, problems);
    return { ok: false, publicationId: attempt.attemptId, problems };
  }
}

// ------------------------------------------------------------------ catalog

/**
 * Hide a published Studio theme from new installs, show it again, or point
 * the catalog at another of its published releases. Stores that installed it
 * keep their exact pinned release in every case.
 */
export async function changeThemeStudioCatalog(
  actor: ThemeStudioActor,
  input: { projectId: string; change: unknown },
): Promise<{ changed: boolean }> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  const parsed = validateCatalogChange(input.change);
  if (!parsed.ok) throw new ThemeStudioError("invalid_input", parsed.error);
  const change = parsed.value;
  const result = await withService(async (db) => {
    const [publication] = await db
      .select()
      .from(themeStudioPublications)
      .where(
        and(
          eq(themeStudioPublications.projectId, input.projectId),
          eq(themeStudioPublications.status, "published"),
        ),
      )
      .limit(1);
    if (!publication) {
      throw new ThemeStudioError(
        "illegal_state",
        "This project has not published a theme.",
      );
    }
    const themeId = publication.themeId;
    await lockThemeId(db, themeId);
    const [entry] = await db
      .select()
      .from(themeCatalogEntries)
      .where(eq(themeCatalogEntries.themeId, themeId))
      .for("update")
      .limit(1);
    if (!entry) {
      throw new ThemeStudioError(
        "illegal_state",
        "The theme has no catalog entry.",
      );
    }
    let releaseId = entry.currentReleaseId;
    let visibility = entry.visibility as ThemeCatalogVisibility;
    if (change.action === "hide") visibility = "hidden";
    if (change.action === "show") visibility = "public";
    if (change.action === "select_release") {
      const release = await loadExactReleaseWithDb(db, themeId, change.version);
      if (!release || release.status !== "published") {
        throw new ThemeStudioError(
          "not_found",
          "That release does not exist or is not published.",
        );
      }
      releaseId = release.id;
    }
    if (
      releaseId === entry.currentReleaseId &&
      visibility === entry.visibility
    ) {
      return { changed: false };
    }
    if (visibility === "public") {
      const [current] = await db
        .select({ version: themeReleases.version })
        .from(themeReleases)
        .where(eq(themeReleases.id, releaseId))
        .limit(1);
      const release = current
        ? await loadExactReleaseWithDb(db, themeId, current.version)
        : null;
      if (!release || release.definition.demo.status !== "healthy") {
        throw new ThemeStudioError(
          "illegal_state",
          "Only a published release with a healthy demo can be public.",
        );
      }
    }
    await db
      .update(themeCatalogEntries)
      .set({ currentReleaseId: releaseId, visibility, updatedBy: actor.id })
      .where(eq(themeCatalogEntries.themeId, themeId));
    await db.insert(themeCatalogAudit).values({
      themeId,
      action: change.action,
      releaseId,
      visibility,
      previousReleaseId: entry.currentReleaseId,
      previousVisibility: entry.visibility,
      projectId: input.projectId,
      reason: change.reason,
      createdBy: actor.id,
      createdByEmail: actor.email,
    });
    await recordThemeStudioEvent(db, {
      projectId: input.projectId,
      actor,
      eventType:
        change.action === "select_release"
          ? "catalog_release_selected"
          : "catalog_visibility_changed",
      detail: {
        themeId,
        action: change.action,
        releaseId,
        visibility,
        previousVisibility: entry.visibility,
      },
    });
    return { changed: true };
  });
  if (result.changed) expireCaches();
  return result;
}

// --------------------------------------------------------------- read model

export interface ThemeStudioReviewView {
  id: string;
  role: ReviewerRole;
  verdict: "approve" | "reject";
  reviewerEmail: string;
  reviewerIsAuthor: boolean;
  scores: Scores;
  average: number;
  rejections: string[];
  notes: string;
  createdAt: string;
  current: boolean;
}

export interface ThemeStudioPublicationView {
  id: string;
  status: "publishing" | "published" | "failed";
  releaseVersion: string;
  versionId: string;
  failure: string[];
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ThemeStudioCatalogAuditView {
  id: string;
  action: string;
  visibility: string;
  previousVisibility: string | null;
  releaseVersion: string | null;
  reason: string;
  createdByEmail: string;
  createdAt: string;
}

export interface ThemeStudioReleaseState {
  evidence:
    | { ok: true; runId: string; evidenceDigest: string }
    | { ok: false; reason: string };
  packageDigest: string | null;
  versionNumber: number | null;
  reviews: ThemeStudioReviewView[];
  readiness: { ok: boolean; reasons: string[] };
  authors: string[];
  blockers: string[];
  publications: ThemeStudioPublicationView[];
  catalog: {
    visibility: ThemeCatalogVisibility;
    releaseVersion: string | null;
  } | null;
  publishedReleases: { version: string; createdAt: string }[];
  audit: ThemeStudioCatalogAuditView[];
}

export async function getThemeStudioReleaseState(
  projectId: string,
): Promise<ThemeStudioReleaseState | null> {
  if (!isUuid(projectId)) return null;
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, projectId))
      .limit(1);
    if (!project) return null;
    const [version] = project.currentVersionId
      ? await db
          .select()
          .from(themeStudioVersions)
          .where(eq(themeStudioVersions.id, project.currentVersionId))
          .limit(1)
      : [];
    const approvedLike =
      project.status === "approved" || project.status === "published";
    const evidence = await verifyCandidateEvidenceWithDb(db, project, {
      status: approvedLike ? "approved" : "candidate",
      requireCurrentBuild: !approvedLike,
    });
    // A published project is no longer `approved`; its evidence is history.
    const shownEvidence =
      project.status === "published"
        ? await latestPassedRun(db, project.currentVersionId)
        : evidence;
    const reviewRows = await db
      .select()
      .from(themeStudioReviews)
      .where(eq(themeStudioReviews.projectId, project.id))
      .orderBy(desc(themeStudioReviews.createdAt));
    const currentRunId = shownEvidence.ok ? shownEvidence.runId : null;
    const reviews = reviewRows.map((row) => ({
      id: row.id,
      role: row.reviewerRole as ReviewerRole,
      verdict: row.verdict as "approve" | "reject",
      reviewerEmail: row.createdByEmail,
      reviewerIsAuthor: row.reviewerIsAuthor,
      scores: scoresOf(row),
      average:
        SCORECARD_DIMENSIONS.reduce((s, d) => s + scoresOf(row)[d.key], 0) /
        SCORECARD_DIMENSIONS.length,
      rejections: row.rejections,
      notes: row.notes,
      createdAt: row.createdAt,
      current: row.acceptanceRunId === currentRunId,
    }));
    const readiness = approvalReadiness(
      reviewFacts(
        reviewRows.filter((row) => row.acceptanceRunId === currentRunId),
      ),
    );
    const parsed = version ? validateThemePackageV2(version.packageJson) : null;
    const publicationRows = await db
      .select()
      .from(themeStudioPublications)
      .where(eq(themeStudioPublications.projectId, project.id))
      .orderBy(desc(themeStudioPublications.createdAt));
    const [entry] = await db
      .select({
        visibility: themeCatalogEntries.visibility,
        version: themeReleases.version,
      })
      .from(themeCatalogEntries)
      .leftJoin(
        themeReleases,
        eq(themeReleases.id, themeCatalogEntries.currentReleaseId),
      )
      .where(eq(themeCatalogEntries.themeId, project.themeId))
      .limit(1);
    const releases = await db
      .select({
        id: themeReleases.id,
        version: themeReleases.version,
        status: themeReleases.releaseStatus,
        createdAt: themeReleases.createdAt,
      })
      .from(themeReleases)
      .where(eq(themeReleases.themeId, project.themeId))
      .orderBy(desc(themeReleases.createdAt));
    const versionById = new Map(releases.map((r) => [r.id, r.version]));
    const auditRows = await db
      .select()
      .from(themeCatalogAudit)
      .where(eq(themeCatalogAudit.themeId, project.themeId))
      .orderBy(desc(themeCatalogAudit.createdAt))
      .limit(50);
    return {
      evidence: shownEvidence,
      packageDigest: version?.packageDigest ?? null,
      versionNumber: version?.versionNumber ?? null,
      reviews,
      readiness: readiness.ok
        ? { ok: true, reasons: [] }
        : { ok: false, reasons: readiness.reasons },
      authors: [
        ...(await authorEmails(db, project.id, project.createdByEmail)),
      ],
      blockers: parsed?.ok ? publicationBlockers(parsed.value) : [],
      publications: publicationRows.map((row) => ({
        id: row.id,
        status: row.status as ThemeStudioPublicationView["status"],
        releaseVersion: row.releaseVersion,
        versionId: row.versionId,
        failure: Array.isArray(row.failure) ? (row.failure as string[]) : [],
        createdByEmail: row.createdByEmail,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      })),
      catalog: entry
        ? {
            visibility: entry.visibility as ThemeCatalogVisibility,
            releaseVersion: entry.version ?? null,
          }
        : null,
      publishedReleases: releases
        .filter((r) => r.status === "published")
        .map((r) => ({ version: r.version, createdAt: r.createdAt })),
      audit: auditRows.map((row) => ({
        id: row.id,
        action: row.action,
        visibility: row.visibility,
        previousVisibility: row.previousVisibility,
        releaseVersion: versionById.get(row.releaseId) ?? null,
        reason: row.reason,
        createdByEmail: row.createdByEmail,
        createdAt: row.createdAt,
      })),
    };
  });
}

async function latestPassedRun(
  db: Db,
  versionId: string | null,
): Promise<ThemeStudioReleaseState["evidence"]> {
  if (!versionId) return { ok: false, reason: "No current version." };
  const [run] = await db
    .select({
      id: themeStudioAcceptanceRuns.id,
      evidenceDigest: themeStudioAcceptanceRuns.evidenceDigest,
    })
    .from(themeStudioAcceptanceRuns)
    .where(
      and(
        eq(themeStudioAcceptanceRuns.versionId, versionId),
        eq(themeStudioAcceptanceRuns.status, "passed"),
      ),
    )
    .orderBy(
      desc(themeStudioAcceptanceRuns.completedAt),
      desc(themeStudioAcceptanceRuns.createdAt),
    )
    .limit(1);
  return run?.evidenceDigest
    ? { ok: true, runId: run.id, evidenceDigest: run.evidenceDigest }
    : { ok: false, reason: "No passing acceptance run." };
}
