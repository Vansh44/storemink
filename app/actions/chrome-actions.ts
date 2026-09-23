"use server";

import { eq, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { storeChrome, stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { TAGS } from "@/lib/storefront/tags";
import { contrastIssuesFor } from "@/lib/chrome/design";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import {
  sanitizeChromeForSave,
  normalizeChrome,
  type StoreChrome,
} from "@/lib/chrome/types";

// ---------------------------------------------------------------------------
// Header + footer editing, from inside the website builder.
//
// Same trust boundary and same draft → publish contract as page-actions:
// gated on `getManagerUserId("builder")`, store-scoped from the HOST rather
// than anything the client sends, and written with the SERVICE scope because
// the `draft` column is revoked from anon/authenticated at the DB layer.
//
// Replaces saveStoreMenus (app/actions/menu-actions.ts), which wrote straight
// to live. Chrome appears on every page of the store, so it is the LAST thing
// that should have been editable without a draft.
// ---------------------------------------------------------------------------

interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** The row shape both writers upsert into. */
async function readRow(storeId: string) {
  const rows = await withService((db) =>
    db
      .select({
        draft: storeChrome.draft,
        published: storeChrome.published,
        updated_at: storeChrome.updatedAt,
      })
      .from(storeChrome)
      .where(eq(storeChrome.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  return rows[0] ?? null;
}

/**
 * Save the working copy. Called by the builder's autosave, so it must be cheap,
 * idempotent, and must never fail on incomplete input — a merchant halfway
 * through typing a link label has an invalid href, and refusing that save would
 * lose their work.
 *
 * Returns the new `updated_at` so the client can carry a fresh stale-tab token,
 * exactly as savePageDraft does.
 */
export async function saveChromeDraft(
  raw: unknown,
  expectedUpdatedAt?: string,
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const existing = await readRow(storeId);

  // Stale-tab guard: refuse to clobber a save made from another tab. `stale`
  // lets the autosave hook tell this apart from a transient failure — one is a
  // hard block, the other retries.
  if (
    expectedUpdatedAt &&
    existing &&
    existing.updated_at !== expectedUpdatedAt
  ) {
    return {
      error:
        "Your header or footer was changed somewhere else. Reload the builder to get the latest version before saving.",
      data: { stale: true },
    };
  }

  const draft = sanitizeChromeForSave(raw);

  try {
    const [row] = await withService((db) =>
      db
        .insert(storeChrome)
        .values({ storeId, draft })
        .onConflictDoUpdate({
          target: storeChrome.storeId,
          set: { draft, updatedAt: sql`now()` },
        })
        .returning({ updated_at: storeChrome.updatedAt }),
    );
    return { success: true, data: { updatedAt: row?.updated_at } };
  } catch (err) {
    console.error("saveChromeDraft error:", err);
    return { error: dbErrorMessage(err, "Could not save.") };
  }
}

/**
 * Publish: copy draft → published, the same "publish is a snapshot copy" move
 * store_pages makes. The storefront reads only `published`, so until this runs
 * a visitor sees the previous chrome no matter what the draft says.
 */
export async function publishChrome(
  expectedUpdatedAt?: string,
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const existing = await readRow(storeId);
  if (!existing) {
    return { error: "Nothing to publish yet — save a change first." };
  }
  if (expectedUpdatedAt && existing.updated_at !== expectedUpdatedAt) {
    return {
      error:
        "Your header or footer was changed somewhere else. Reload the builder before publishing.",
      data: { stale: true },
    };
  }

  // Re-sanitise on the way out rather than trusting whatever is sitting in
  // `draft`: it was written by an earlier version of the sanitiser, or by a
  // migration, and this is the value the public will actually render.
  const published = sanitizeChromeForSave(existing.draft);

  // ★★ LEGIBILITY IS ENFORCED HERE AND NOWHERE EARLIER. Saving a draft must
  // never fail mid-edit — a half-picked palette is a normal intermediate state
  // and the merchant can see it in the live preview — but PUBLISHING it puts
  // unreadable body text in front of shoppers, and the storefront has no other
  // defence. It matters more once a model can propose a palette from a
  // screenshot: that optimises for resemblance, not for readability.
  // The store's own theme is resolved first, because changing one token can
  // break text inherited from the preset that the merchant never touched.
  const [storeRow] = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const themeSelection = readThemeSelection(storeRow?.settings);
  const themeDesign =
    (await resolveInstalledThemeDefinition(themeSelection))?.preset.design ??
    null;
  const contrastIssues = contrastIssuesFor(published.design, themeDesign);
  if (contrastIssues.length > 0) {
    return {
      error: `This colour scheme is not readable, so it can't go live yet. ${contrastIssues.join(" ")}`,
      data: { contrastIssues },
    };
  }

  try {
    await withService((db) =>
      db
        .update(storeChrome)
        .set({ published, publishedAt: sql`now()` })
        .where(eq(storeChrome.storeId, storeId)),
    );
  } catch (err) {
    console.error("publishChrome error:", err);
    return { error: dbErrorMessage(err, "Could not publish.") };
  }

  // The storefront read is cached per store — without this the new header is
  // invisible for up to the revalidate window, which reads as "publish didn't
  // work" and gets pressed again.
  revalidateTag(TAGS.chrome, "max");

  emitEvent({
    type: "page.published",
    storeId,
    actor: { type: "admin", id: userId },
    subject: { type: "page", id: "chrome", label: "Header & footer" },
    payload: { page: "Header & footer" },
  });

  return { success: true };
}

/**
 * Discard the working copy and start again from what is live. The escape hatch
 * for "I've made a mess" — without it the only way back is undoing every edit
 * by hand, and undo history does not survive a reload.
 */
export async function revertChromeDraft(): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const existing = await readRow(storeId);
  if (!existing?.published) {
    return { error: "There is no published version to revert to yet." };
  }

  try {
    await withService((db) =>
      db
        .update(storeChrome)
        .set({ draft: existing.published as StoreChrome })
        .where(eq(storeChrome.storeId, storeId)),
    );
    return {
      success: true,
      data: { chrome: normalizeChrome(existing.published) },
    };
  } catch (err) {
    console.error("revertChromeDraft error:", err);
    return { error: dbErrorMessage(err, "Could not revert.") };
  }
}
