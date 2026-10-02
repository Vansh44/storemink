"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { emitEvent } from "@/lib/notifications/record";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { demoStoreRefusal } from "@/lib/store/demo-guard";
import { withUser } from "@/lib/db/client";
import { productReviews, users } from "@/drizzle/schema";

export interface ReviewFormData {
  product_id: string;
  slug: string; // used to revalidate the product page
  rating: number; // 1–5
  comment: string;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
}

// Post or update the signed-in customer's review for a product. There's a
// unique (product_id, user_id) constraint, so this upserts: a second
// submission edits the existing review rather than creating a duplicate.
export async function submitReview(
  form: ReviewFormData,
): Promise<ActionResult> {
  const demoRefusal = await demoStoreRefusal();
  if (demoRefusal) return { error: demoRefusal };
  const user = await getServerUser();
  if (!user) {
    return { error: "Please sign in to write a review." };
  }

  const rating = Math.trunc(form.rating);
  if (!(rating >= 1 && rating <= 5)) {
    return { error: "Please choose a rating from 1 to 5 stars." };
  }

  // The reviewer's name is snapshotted onto the review (customers is own-row
  // only under RLS, so public readers can't join to it).
  const [customer] = await withUser({ uid: user.id, email: user.email }, (db) =>
    db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1),
  );

  if (!customer) {
    return { error: "Complete your profile before writing a review." };
  }

  const authorName = `${customer.firstName ?? ""}${
    customer.lastName ? " " + customer.lastName : ""
  }`.trim();

  const reviewFields = {
    authorName: authorName || "Anonymous",
    rating,
    comment: form.comment.trim() || null,
    updatedAt: new Date().toISOString(),
  };

  const storeId = await getCurrentStoreId();
  try {
    // RLS (own-row insert/update policies) enforces ownership at the DB layer.
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .insert(productReviews)
        .values({
          productId: form.product_id,
          userId: user.id,
          storeId,
          ...reviewFields,
        })
        .onConflictDoUpdate({
          target: [productReviews.productId, productReviews.userId],
          set: reviewFields,
        }),
    );
  } catch (err) {
    console.error("submitReview error:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to save review.",
    };
  }

  emitEvent({
    type: "customer.review_submitted",
    storeId,
    actor: { type: "customer", id: user.id, label: reviewFields.authorName },
    subject: { type: "product", id: form.product_id, label: form.slug },
    payload: { rating },
  });

  revalidatePath(`/shop/${form.slug}`);
  return { success: true };
}

// Delete the signed-in customer's own review (RLS enforces ownership).
export async function deleteReview(
  reviewId: string,
  slug: string,
): Promise<ActionResult> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };

  try {
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db.delete(productReviews).where(eq(productReviews.id, reviewId)),
    );
  } catch (err) {
    console.error("deleteReview error:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to delete review.",
    };
  }

  revalidatePath(`/shop/${slug}`);
  return { success: true };
}
