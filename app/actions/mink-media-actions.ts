"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { minkDrafts } from "@/drizzle/schema";
import { getActingStoreId, getManagerUserId } from "@/app/dashboard/lib/access";
import { withService } from "@/lib/db/client";
import {
  MinkMediaContentError,
  readStoredGeneratedImage,
} from "@/lib/mink/media-generation-contract";

// ---------------------------------------------------------------------------
// Phase 9E - saving a generated image into the Media Library.
//
// ★★ A BUTTON, NOT AN APPROVAL, following 9D's own save in the same feature
// area: a `media_assets` row changes nothing a shopper can see, and 9D's
// ownership guard means the only route from that table to a live storefront is
// a layout proposal the merchant separately approves. A second five-minute
// approval here would guard a boundary that is already guarded.
//
// ★ THE ONLY THING THE BROWSER SENDS IS A DRAFT ID. Filename, URL, alt text
// and content type all come from the stored proposal, so nothing about the row
// this writes can be chosen by the caller -- which matters more than usual,
// because `media_assets.url` is exactly what 9D's `selectOwnedMediaUrls`
// treats as proof that an image belongs to the store.
// ---------------------------------------------------------------------------

export interface SaveGeneratedImageResult {
  url?: string;
  alt?: string;
  error?: string;
}

export async function saveMinkGeneratedImage(
  draftId: string,
): Promise<SaveGeneratedImageResult> {
  const userId = await getManagerUserId("media");
  if (!userId) return { error: "You don't have access to the media library." };
  if (typeof draftId !== "string" || !/^[0-9a-f-]{36}$/i.test(draftId)) {
    return { error: "That image could not be found." };
  }
  const storeId = await getActingStoreId();

  try {
    const outcome = await withService(async (db) => {
      const [draft] = await db
        .select({ kind: minkDrafts.kind, content: minkDrafts.contentJson })
        .from(minkDrafts)
        .where(
          and(
            eq(minkDrafts.id, draftId),
            eq(minkDrafts.storeId, storeId),
            // ★ THE PROPOSAL IS PRIVATE TO THE ADMIN WHO ASKED FOR IT, the
            //   rule every other Mink draft read follows. A colleague with
            //   Media manage may generate their own image; they may not reach
            //   into someone else's unsaved proposals.
            eq(minkDrafts.adminId, userId),
          ),
        )
        .limit(1);
      if (!draft || draft.kind !== "media_image") {
        return { error: "That image could not be found." };
      }

      const image = readStoredGeneratedImage(
        storeId,
        (draft.content ?? {}) as Record<string, string | undefined>,
      );

      // ★ CONDITIONAL ON THE OBJECT NOT ALREADY BEING IN THE LIBRARY, so a
      //   second click adds no second row. ⚠ Two simultaneous clicks could
      //   still both pass under READ COMMITTED; the bounded cost is one
      //   duplicate library row the merchant can delete, which is why this is
      //   not worth a unique index over a column that has never had one.
      const inserted = await db.execute(sql`
        insert into media_assets
          (store_id, url, path, filename, content_type, size_bytes, created_by)
        select ${storeId}::uuid, ${image.url}, ${image.path}, ${image.filename},
               ${image.contentType}, ${image.sizeBytes}, ${userId}
        where not exists (
          select 1 from media_assets
          where store_id = ${storeId}::uuid and path = ${image.path}
        )
        returning url
      `);
      return {
        url: image.url,
        alt: image.alt,
        added: inserted.rows.length > 0,
      };
    });
    // ★ AFTER THE COMMIT, not inside it. Busting the cache while the insert is
    //   still uncommitted invites a concurrent render to repopulate it from
    //   the state this call is about to change.
    if ("added" in outcome && outcome.added) revalidatePath("/dashboard/media");
    return "added" in outcome
      ? { url: outcome.url, alt: outcome.alt }
      : outcome;
  } catch (error) {
    if (error instanceof MinkMediaContentError) return { error: error.message };
    console.error(
      "saveMinkGeneratedImage:",
      error instanceof Error ? error.message : error,
    );
    return { error: "Could not save this image. Please try again." };
  }
}
