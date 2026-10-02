"use server";

import { and, eq } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { withService, withUser, type Db } from "@/lib/db/client";
import { blogComments, blogLikes, users } from "@/drizzle/schema";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { demoStoreRefusal } from "@/lib/store/demo-guard";
import { revalidatePath } from "next/cache";
import {
  BLOG_REACTIONS,
  type BlogReaction,
  type ReactionCounts,
} from "@/lib/blog-reactions";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

function emptyCounts(): ReactionCounts {
  return { like: 0, love: 0, haha: 0, wow: 0, celebrate: 0 };
}

// Tally reaction rows for a blog into per-type counts. We read the (small) set
// of reaction strings and count in JS. Reuses an existing db handle when passed
// (so the tally shares the caller's transaction), else opens its own.
async function tallyReactions(db: Db, blogId: string): Promise<ReactionCounts> {
  const counts = emptyCounts();
  const rows = await db
    .select({ reaction: blogLikes.reaction })
    .from(blogLikes)
    .where(eq(blogLikes.blogId, blogId));
  for (const row of rows as { reaction: BlogReaction }[]) {
    if (row.reaction in counts) counts[row.reaction] += 1;
  }
  return counts;
}

/**
 * Toggle ONE emoji reaction for a blog on/off. No login required — the browser
 * passes a random `visitorId` (localStorage). A visitor may hold several
 * different reactions at once (one row per emoji); `active` is the desired
 * state for THIS emoji (true = add, false = remove). Runs in the service scope,
 * so there are no public write policies on blog_likes to abuse. Returns the
 * fresh per-reaction counts.
 */
export async function toggleBlogReaction(
  blogId: string,
  visitorId: string,
  reaction: BlogReaction,
  active: boolean,
): Promise<{ counts: ReactionCounts; error?: string }> {
  if (!blogId || !visitorId) {
    return { counts: emptyCounts(), error: "Missing reaction context." };
  }
  if (!BLOG_REACTIONS.includes(reaction)) {
    return { counts: emptyCounts(), error: "Unknown reaction." };
  }
  const demoRefusal = await demoStoreRefusal();
  if (demoRefusal) return { counts: emptyCounts(), error: demoRefusal };

  const storeId = active ? await getCurrentStoreId() : "";
  try {
    return await withService(async (db) => {
      if (active) {
        // ignoreDuplicates: a repeat reaction is a no-op (nothing to change).
        await db
          .insert(blogLikes)
          .values({ blogId, visitorId, reaction, storeId })
          .onConflictDoNothing({
            target: [blogLikes.blogId, blogLikes.visitorId, blogLikes.reaction],
          });
      } else {
        await db
          .delete(blogLikes)
          .where(
            and(
              eq(blogLikes.blogId, blogId),
              eq(blogLikes.visitorId, visitorId),
              eq(blogLikes.reaction, reaction),
            ),
          );
      }
      return { counts: await tallyReactions(db, blogId) };
    });
  } catch (err) {
    console.error("toggleBlogReaction error:", err);
    return {
      counts: emptyCounts(),
      error: active
        ? "Couldn't save your reaction."
        : "Couldn't remove your reaction.",
    };
  }
}

/** Per-reaction counts for a blog (server-side initial render). */
export async function getBlogReactionCounts(
  blogId: string,
): Promise<ReactionCounts> {
  try {
    return await withService((db) => tallyReactions(db, blogId));
  } catch (err) {
    console.error("getBlogReactionCounts error:", err);
    return emptyCounts();
  }
}

/**
 * Post a comment on a blog. Requires a signed-in customer. The author's name is
 * snapshotted onto the row (users is own-row-only under RLS, so public readers
 * can't join to it).
 */
export async function submitBlogComment(form: {
  blog_id: string;
  slug: string;
  body: string;
}): Promise<ActionResult> {
  const demoRefusal = await demoStoreRefusal();
  if (demoRefusal) return { error: demoRefusal };
  const body = form.body.trim();
  if (!body) return { error: "Write something first." };
  if (body.length > 2000) {
    return { error: "Comment is too long (2000 characters max)." };
  }

  const user = await getServerUser();
  if (!user) return { error: "Please sign in to comment." };

  const storeId = await getCurrentStoreId();
  try {
    const result = await withUser(
      { uid: user.id, email: user.email },
      async (db) => {
        const customerRows = await db
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);
        const customer = customerRows[0];
        if (!customer) return { error: "PROFILE_MISSING" as const };

        const authorName = `${customer.firstName ?? ""}${
          customer.lastName ? " " + customer.lastName : ""
        }`.trim();

        await db.insert(blogComments).values({
          blogId: form.blog_id,
          userId: user.id,
          authorName: authorName || "Anonymous",
          body,
          storeId,
        });
        return { ok: true as const, authorName: authorName || "Anonymous" };
      },
    );

    if ("error" in result) {
      return { error: "Complete your profile before commenting." };
    }

    // In-app only by default (registry) — comment volume makes this a poor
    // thing to mail on, but a merchant can switch email on per store.
    emitEvent({
      type: "blog.comment_posted",
      storeId,
      actor: { type: "customer", id: user.id, label: result.authorName },
      subject: { type: "blog", id: form.blog_id, label: form.slug },
      payload: { author: result.authorName, url: `/blogs/${form.slug}` },
    });
  } catch (err) {
    console.error("submitBlogComment error:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to post comment.",
    };
  }

  revalidatePath(`/blogs/${form.slug}`);
  return { success: true };
}

/** Delete the signed-in customer's own comment (RLS enforces ownership). */
export async function deleteBlogComment(
  commentId: string,
  slug: string,
): Promise<ActionResult> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };

  try {
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db.delete(blogComments).where(eq(blogComments.id, commentId)),
    );
  } catch (err) {
    console.error("deleteBlogComment error:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to delete comment.",
    };
  }

  revalidatePath(`/blogs/${slug}`);
  return { success: true };
}
