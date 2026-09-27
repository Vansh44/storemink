import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, max, sql } from "drizzle-orm";
import {
  platformAdmins,
  themeStudioAssets,
  themeStudioCaptures,
  themeStudioProjects,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import type { ThemeStudioActor } from "./access";
import {
  applyCapturedImages,
  captureBlockers,
  captureShots,
  type CaptureShot,
} from "./capture-core";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import { openThemeStudioPreview } from "./preview";
import {
  CAPTURE_COOKIE,
  CAPTURE_TOKEN_TTL_SECONDS,
  signPreviewToken,
} from "./preview-token";
import {
  ThemeStudioError,
  digestThemeStudioJson,
  isUuid,
  recordThemeStudioEvent,
} from "./repository";
import { prepareSlotImage } from "./slot-images";
import type { SlotImageRow } from "./slot-images-core";

// ---------------------------------------------------------------------------
// Track 3.6: capturing a version's catalog card and screenshots.
//
// An operator queues a capture; the headless-Chromium job
// (scripts/theme-studio-capture-job.mjs, a separate Cloud Run job) claims it
// through /api/internal/theme-studio/captures/claim, photographs the version's
// private preview store, and posts the pictures back, and they become a new
// version. This module is the server half of that exchange.
//
// ★ A CAPTURE HOLDS THE PROJECT LIKE A RUN. It writes the project's next
// version, so the project is `generating` while it is queued or running, and
// only one capture exists per project at a time (a unique index). It captures
// the CURRENT version and refuses to finish if another version became current
// meanwhile: writing its pictures onto a version the operator has moved on
// from would quietly make an older version current again.
//
// ★ THE JOB IS UNTRUSTED FOR EVERYTHING BUT PIXELS. It learns nothing but a
// capture id, a lease token, an origin, a cookie and the shots to take; every
// picture it returns is re-decoded, cropped and compressed here exactly as an
// operator upload is, and bound to the lease it was issued.
//
// ★ A FAILED CAPTURE RETURNS THE PROJECT TO READY. Its current version is
// untouched; `generating → candidate` is not a transition, so a candidate's
// Checks must be run again, as after a failed image run.
// ---------------------------------------------------------------------------

/** How long one claim holds a capture. Three shots take well under two
 *  minutes; a lease that lapses is claimed again, up to max_attempts. */
export const CAPTURE_LEASE_SECONDS = 10 * 60;

/** The largest picture the job may post, before cropping. A 3× phone shot of
 *  a long page is the biggest and is a few megabytes as PNG. */
export const MAX_CAPTURE_BYTES = 15 * 1024 * 1024;

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,80}$/;
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const CAPTURE_STATES = ["ready", "candidate"] as const;

export interface ThemeStudioCaptureView {
  id: string;
  versionId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  resultVersionId: string | null;
  attemptCount: number;
  createdAt: string;
  finishedAt: string | null;
}

/** What the job needs for one capture, and nothing more. */
export interface ClaimedCapture {
  captureId: string;
  leaseToken: string;
  origin: string;
  cookie: { name: string; value: string };
  shots: Omit<CaptureShot, "target" | "byteLimit" | "alt">[];
}

// ── Queue ────────────────────────────────────────────────────────────────

export async function queueThemeStudioCapture(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    versionId: string;
    expectedRevision: number;
    expectedPackageDigest: string;
    idempotencyKey: string;
  },
): Promise<{ captureId: string; duplicate: boolean }> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  if (!IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    if (!project) {
      throw new ThemeStudioError("not_found", "That project no longer exists.");
    }
    const [prior] = await db
      .select({
        id: themeStudioCaptures.id,
        projectId: themeStudioCaptures.projectId,
      })
      .from(themeStudioCaptures)
      .where(eq(themeStudioCaptures.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (prior) {
      if (prior.projectId !== project.id) {
        throw new ThemeStudioError(
          "invalid_input",
          "The request is malformed. Reload and try again.",
        );
      }
      return { captureId: prior.id, duplicate: true };
    }
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (!(CAPTURE_STATES as readonly string[]).includes(project.status)) {
      throw new ThemeStudioError(
        "illegal_state",
        "Catalog pictures can be captured only while the project is ready or a candidate.",
      );
    }
    if (project.currentVersionId !== input.versionId) {
      throw new ThemeStudioError(
        "illegal_state",
        "Only the current version can be captured. Make this version current first.",
      );
    }
    const [version] = await db
      .select({
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!version?.packageJson || !version.packageDigest) {
      throw new ThemeStudioError("not_found", "That version has no theme.");
    }
    if (version.packageDigest !== input.expectedPackageDigest) {
      throw new ThemeStudioError(
        "stale",
        "That version is not the one on your screen. Reload to see it.",
      );
    }
    const pkg = validateThemePackageV2(version.packageJson);
    if (!pkg.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version can no longer be read. Revise it or restore another.",
      );
    }
    const blockers = captureBlockers(pkg.value);
    if (blockers.length > 0) {
      throw new ThemeStudioError("illegal_state", blockers[0]);
    }
    const [capture] = await db
      .insert(themeStudioCaptures)
      .values({
        projectId: project.id,
        versionId: input.versionId,
        packageDigest: version.packageDigest,
        previousStatus: project.status,
        idempotencyKey: input.idempotencyKey,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioCaptures.id });
    await db
      .update(themeStudioProjects)
      .set({ status: "generating", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "capture_requested",
      detail: { captureId: capture.id, versionId: input.versionId },
    });
    return { captureId: capture.id, duplicate: false };
  });
}

// ── Claim ────────────────────────────────────────────────────────────────

type CaptureRow = typeof themeStudioCaptures.$inferSelect;

/**
 * Settle a capture as failed and give the project back. The project returns
 * to `ready` only if the capture still holds it (generating, same current
 * version), so a failure can never undo work that happened after it.
 */
async function failCapture(
  db: Db,
  capture: Pick<CaptureRow, "id" | "projectId" | "versionId">,
  errorCode: string,
): Promise<void> {
  const code = CODE_RE.test(errorCode) ? errorCode : "capture_failed";
  await db
    .update(themeStudioCaptures)
    .set({
      status: "failed",
      errorCode: code,
      finishedAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(themeStudioCaptures.id, capture.id));
  await db
    .update(themeStudioProjects)
    .set({
      status: "ready",
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, capture.projectId),
        eq(themeStudioProjects.status, "generating"),
        eq(themeStudioProjects.currentVersionId, capture.versionId),
      ),
    );
  await recordThemeStudioEvent(db, {
    projectId: capture.projectId,
    actor: "worker",
    eventType: "capture_failed",
    detail: { captureId: capture.id, errorCode: code },
  });
}

/**
 * Claim the next capture for the job: one queued, or one whose lease lapsed
 * with attempts left. A lapsed capture out of attempts is failed first.
 * Returns null when there is nothing to do.
 */
export async function claimThemeStudioCapture(): Promise<ClaimedCapture | null> {
  const claimed = await withService(async (db) => {
    const exhausted = await db
      .select()
      .from(themeStudioCaptures)
      .where(
        sql`${themeStudioCaptures.status} = 'running'
            AND ${themeStudioCaptures.leaseExpiresAt} <= now()
            AND ${themeStudioCaptures.attemptCount} >= ${themeStudioCaptures.maxAttempts}`,
      )
      .for("update", { skipLocked: true });
    for (const capture of exhausted) {
      await failCapture(db, capture, "lease_expired");
    }
    const [next] = await db
      .select()
      .from(themeStudioCaptures)
      .where(
        sql`${themeStudioCaptures.status} = 'queued'
            OR (${themeStudioCaptures.status} = 'running'
                AND ${themeStudioCaptures.leaseExpiresAt} <= now()
                AND ${themeStudioCaptures.attemptCount} < ${themeStudioCaptures.maxAttempts})`,
      )
      .orderBy(themeStudioCaptures.createdAt)
      .for("update", { skipLocked: true })
      .limit(1);
    if (!next) return null;
    const leaseToken = randomUUID();
    await db
      .update(themeStudioCaptures)
      .set({
        status: "running",
        leaseOwner: leaseToken,
        leaseExpiresAt: sql`now() + (${CAPTURE_LEASE_SECONDS}::int * interval '1 second')`,
        attemptCount: next.attemptCount + 1,
        startedAt: sql`coalesce(${themeStudioCaptures.startedAt}, now())`,
      })
      .where(eq(themeStudioCaptures.id, next.id));
    const [version] = await db
      .select({
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.id, next.versionId))
      .limit(1);
    const [owner] = next.createdBy
      ? await db
          .select({ id: platformAdmins.id, email: platformAdmins.email })
          .from(platformAdmins)
          .where(eq(platformAdmins.id, next.createdBy))
          .limit(1)
      : [];
    return { capture: next, leaseToken, version, owner };
  });
  if (!claimed) return null;
  const { capture, leaseToken, version, owner } = claimed;
  const fail = (code: string) =>
    withService((db) => failCapture(db, capture, code));

  const pkg =
    version?.packageJson && version.packageDigest === capture.packageDigest
      ? validateThemePackageV2(version.packageJson)
      : null;
  if (!pkg?.ok) {
    await fail("base_changed");
    return null;
  }
  // The preview is opened as the operator who asked: the store is theirs to
  // see, and its events name them. An operator since removed cannot.
  if (!owner) {
    await fail("operator_removed");
    return null;
  }
  let opened;
  try {
    opened = await openThemeStudioPreview(
      { id: owner.id, email: owner.email },
      { projectId: capture.projectId, versionId: capture.versionId },
    );
  } catch (error) {
    logError("theme studio: capture preview failed", error, {
      captureId: capture.id,
    });
    await fail("preview_failed");
    return null;
  }
  return {
    captureId: capture.id,
    leaseToken,
    origin: opened.origin,
    cookie: {
      name: CAPTURE_COOKIE,
      value: signPreviewToken(
        "capture",
        {
          storeId: opened.storeId,
          versionId: capture.versionId,
          actorId: capture.id,
        },
        CAPTURE_TOKEN_TTL_SECONDS,
      ),
    },
    shots: captureShots(pkg.value).map((shot) => ({
      slotId: shot.slotId,
      path: shot.path,
      viewport: shot.viewport,
      deviceScaleFactor: shot.deviceScaleFactor,
      mobile: shot.mobile,
    })),
  };
}

// ── Finish ───────────────────────────────────────────────────────────────

export type CaptureFinish =
  | { status: "succeeded"; versionId: string }
  | { status: "failed"; errorCode: string }
  | { status: "requeued" }
  | { status: "lost" };

/** Read a capture that this lease still holds, or null. */
async function heldCapture(
  db: Db,
  captureId: string,
  leaseToken: string,
  lock: boolean,
): Promise<CaptureRow | null> {
  const query = db
    .select()
    .from(themeStudioCaptures)
    .where(
      and(
        eq(themeStudioCaptures.id, captureId),
        eq(themeStudioCaptures.status, "running"),
        eq(themeStudioCaptures.leaseOwner, leaseToken),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/**
 * The job's answer for one capture: pictures, or an error code. A reported
 * error is retried while attempts remain (a navigation timeout on a cold
 * preview is ordinary); pictures that cannot be used fail the capture.
 */
export async function finishThemeStudioCapture(input: {
  captureId: string;
  leaseToken: string;
  images?: { slotId: string; bytes: Uint8Array }[];
  error?: string;
}): Promise<CaptureFinish> {
  if (!isUuid(input.captureId) || !isUuid(input.leaseToken)) {
    return { status: "lost" };
  }
  const capture = await withService((db) =>
    heldCapture(db, input.captureId, input.leaseToken, false),
  );
  if (!capture) return { status: "lost" };

  if (input.error !== undefined || !input.images) {
    const code = CODE_RE.test(input.error ?? "")
      ? input.error!
      : "capture_failed";
    return withService(async (db) => {
      const held = await heldCapture(db, capture.id, input.leaseToken, true);
      if (!held) return { status: "lost" } as const;
      if (held.attemptCount < held.maxAttempts) {
        await db
          .update(themeStudioCaptures)
          .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
          .where(eq(themeStudioCaptures.id, held.id));
        return { status: "requeued" } as const;
      }
      await failCapture(db, held, code);
      return { status: "failed", errorCode: code } as const;
    });
  }

  const [version] = await withService((db) =>
    db
      .select({
        packageJson: themeStudioVersions.packageJson,
        intentJson: themeStudioVersions.intentJson,
        intentDigest: themeStudioVersions.intentDigest,
      })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.id, capture.versionId))
      .limit(1),
  );
  const parsed = version ? validateThemePackageV2(version.packageJson) : null;
  const failNow = async (code: string): Promise<CaptureFinish> =>
    withService(async (db) => {
      const held = await heldCapture(db, capture.id, input.leaseToken, true);
      if (!held) return { status: "lost" } as const;
      await failCapture(db, held, code);
      return { status: "failed", errorCode: code } as const;
    });
  if (!parsed?.ok || !version) return failNow("base_invalid");
  const pkg: ThemePackageV2 = parsed.value;

  // Exactly the shots that were asked for, each re-processed like an upload.
  const shots = captureShots(pkg);
  const bySlot = new Map(input.images.map((i) => [i.slotId, i.bytes]));
  if (
    bySlot.size !== input.images.length ||
    shots.length !== bySlot.size ||
    shots.some((s) => !bySlot.has(s.slotId))
  ) {
    return failNow("capture_incomplete");
  }
  const prepared: {
    slotId: string;
    image: Awaited<ReturnType<typeof prepareSlotImage>>;
  }[] = [];
  for (const shot of shots) {
    const bytes = bySlot.get(shot.slotId)!;
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_BYTES) {
      return failNow("capture_too_large");
    }
    prepared.push({
      slotId: shot.slotId,
      image: await prepareSlotImage(bytes, shot.target, shot.byteLimit),
    });
  }
  if (prepared.some((p) => !p.image.ok)) return failNow("capture_unusable");

  return withService(async (db): Promise<CaptureFinish> => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, capture.projectId))
      .for("update")
      .limit(1);
    const held = await heldCapture(db, capture.id, input.leaseToken, true);
    if (!held || !project) return { status: "lost" };
    if (
      project.status !== "generating" ||
      project.currentVersionId !== held.versionId
    ) {
      await failCapture(db, held, "project_state_changed");
      return { status: "failed", errorCode: "project_state_changed" };
    }
    const rows: { slotId: string; row: SlotImageRow }[] = [];
    for (const { slotId, image } of prepared) {
      if (!image.ok) continue;
      const value = image.value;
      await db
        .insert(themeStudioAssets)
        .values({
          projectId: project.id,
          purpose: "image",
          mediaType: value.mediaType,
          bytes: Buffer.from(value.bytes),
          byteSize: value.bytes.byteLength,
          width: value.width,
          height: value.height,
          sha256: value.sha256,
          originalMediaType: value.originalMediaType,
          originalByteSize: value.originalByteSize,
          createdBy: held.createdBy,
        })
        .onConflictDoNothing({
          target: [themeStudioAssets.projectId, themeStudioAssets.sha256],
        });
      const [row] = await db
        .select({
          id: themeStudioAssets.id,
          purpose: themeStudioAssets.purpose,
          sha256: themeStudioAssets.sha256,
          width: themeStudioAssets.width,
          height: themeStudioAssets.height,
        })
        .from(themeStudioAssets)
        .where(
          and(
            eq(themeStudioAssets.projectId, project.id),
            eq(themeStudioAssets.sha256, value.sha256),
          ),
        )
        .limit(1);
      // The same bytes stored earlier under another purpose would be served
      // by the wrong rules; refuse rather than point a slot at them.
      if (!row || row.purpose !== "image") {
        await failCapture(db, held, "capture_asset_conflict");
        return { status: "failed", errorCode: "capture_asset_conflict" };
      }
      rows.push({ slotId, row });
    }
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, project.id));
    const versionNumber = (latest ?? 0) + 1;
    const applied = applyCapturedImages(pkg, rows, versionNumber);
    if (!applied.ok) {
      await failCapture(db, held, "capture_package_invalid");
      return { status: "failed", errorCode: "capture_package_invalid" };
    }
    const [created] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: project.id,
        runId: null,
        origin: "asset_edit",
        editDetail: {
          kind: "capture",
          captureId: held.id,
          fromVersionId: held.versionId,
          slots: rows.map((r) => r.slotId),
        },
        parentVersionId: held.versionId,
        versionNumber,
        intentJson: version.intentJson,
        intentDigest: version.intentDigest,
        packageJson: applied.value,
        packageDigest: digestThemeStudioJson(applied.value),
      })
      .returning({ id: themeStudioVersions.id });
    await db
      .update(themeStudioProjects)
      .set({
        status: "ready",
        currentVersionId: created.id,
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, project.id));
    await db
      .update(themeStudioCaptures)
      .set({
        status: "succeeded",
        resultVersionId: created.id,
        finishedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(themeStudioCaptures.id, held.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor: "worker",
      eventType: "capture_succeeded",
      detail: { captureId: held.id, versionId: created.id },
    });
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor: "worker",
      eventType: "version_created",
      detail: {
        versionId: created.id,
        versionNumber,
        captured: rows.map((r) => r.slotId),
      },
    });
    return { status: "succeeded", versionId: created.id };
  });
}

// ── Read ─────────────────────────────────────────────────────────────────

/** The project's recent captures, newest first. */
export async function listThemeStudioCaptures(
  projectId: string,
): Promise<ThemeStudioCaptureView[]> {
  if (!isUuid(projectId)) return [];
  const rows = await withService((db) =>
    db
      .select()
      .from(themeStudioCaptures)
      .where(eq(themeStudioCaptures.projectId, projectId))
      .orderBy(desc(themeStudioCaptures.createdAt))
      .limit(10),
  );
  return rows.map((r) => ({
    id: r.id,
    versionId: r.versionId,
    status: r.status as ThemeStudioCaptureView["status"],
    errorCode: r.errorCode,
    resultVersionId: r.resultVersionId,
    attemptCount: r.attemptCount,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));
}
