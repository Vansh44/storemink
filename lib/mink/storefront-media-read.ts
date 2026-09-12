import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { withService, type Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// Phase 9D - the Media Library, finally visible to the model.
//
// ★★ BEFORE THIS, `grep -rn "media_assets" lib/mink/` RETURNED NOTHING. Mink
// had eighteen read tools and not one of them knew the store had a picture. So
// the whole structured-layout capability 9B shipped -- hero, gallery,
// media_text, testimonials, carousel -- could only ever be proposed with
// INVENTED image URLs, which `safeHref` happily accepts (see
// storefront-media-policy.ts). This read is the other half of that fix: the
// guard refuses what the store does not own, and this is how the model learns
// what it does.
//
// ★ IT IS A `media` READ, NOT A `builder` ONE, even though its only consumer
// today is a Builder proposal. The Media Library is its own dashboard section
// with its own permission, and an admin trusted to arrange a page is not
// automatically trusted to enumerate every file the store has uploaded --
// filenames alone can carry a supplier's name or an unreleased product's.
// ---------------------------------------------------------------------------

/** Bounded, like every other Mink read: a library can hold thousands. */
const MAX_MEDIA = 40;
const MAX_FILENAME_CHARS = 160;

type MediaRow = {
  id: string;
  url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

export async function readMinkStorefrontMedia(
  actor: MinkActorContext,
  input: { limit?: unknown } = {},
) {
  if (!can(actor.permissions, "media", "view", actor.isSuperadmin)) {
    throw new Error("Media view permission is required.");
  }
  const limit = readLimit(input.limit);
  const result = await withService((db) =>
    db.execute(sql`
      select id, url, filename, content_type, size_bytes, created_at
      from media_assets
      where store_id = ${actor.storeId}
      order by created_at desc, id desc
      limit ${limit + 1}
    `),
  );
  const rows = result.rows as MediaRow[];
  return {
    media: rows.slice(0, limit).map((row) => ({
      mediaId: row.id,
      /**
       * ★ THE EXACT STRING A PROPOSAL MUST ECHO BACK. The ownership guard
       * compares on this value, so it is returned verbatim -- not shortened,
       * not re-derived from the bucket path.
       */
      url: row.url,
      filename: boundedText(row.filename, MAX_FILENAME_CHARS),
      contentType: boundedText(row.content_type, 100),
      sizeBytes: Number(row.size_bytes ?? 0),
      createdAt: row.created_at,
    })),
    truncated: rows.length > limit,
    /**
     * The whole point of the tool, said in the payload as well as the
     * declaration: an image not on this list cannot go into a layout proposal.
     */
    usage:
      "A storefront layout proposal may cite only a url returned here or an image already on the page it targets.",
    contentTrust: "untrusted_storefront_data" as const,
    scope: "current_store" as const,
    dataAsOf: new Date().toISOString(),
    dashboardPath: "/dashboard/media",
  };
}

function readLimit(value: unknown): number {
  if (value === undefined || value === null) return MAX_MEDIA;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_MEDIA;
  return Math.min(parsed, MAX_MEDIA);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Which of these exact URLs the store's Media Library actually holds.
 *
 * ★ IT ASKS ABOUT THE CANDIDATES, IT DOES NOT LIST THE LIBRARY. A store may
 *   hold thousands of assets and a proposal cites at most a few dozen, so
 *   membership is the cheap question and "give me every URL you have" is the
 *   expensive one -- and the expensive one has to run INSIDE the execute
 *   transaction, where a long read is a lock held open.
 *
 * ★ `db` IS INJECTED so the write path can re-check under the SAME transaction
 *   that is about to save the layout. A second connection there would answer
 *   about a library state the write is not protected against.
 */
export async function selectOwnedMediaUrls(
  db: Db,
  storeId: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(candidates.map((url) => url.trim()))].filter(
    Boolean,
  );
  if (unique.length === 0) return new Set();
  const result = await db.execute(sql`
    select url from media_assets
    where store_id = ${storeId}
      and url = any(${sql.param(unique)}::text[])
  `);
  return new Set((result.rows as { url: string }[]).map((row) => row.url));
}

/** The same question outside a transaction, for the proposal path. */
export function readOwnedMediaUrls(
  storeId: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return Promise.resolve(new Set());
  return withService((db) => selectOwnedMediaUrls(db, storeId, candidates));
}
