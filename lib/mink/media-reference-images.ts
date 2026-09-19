import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import { GCS_BUCKET_NAME, gcsPathFromUrl } from "@/lib/storage/gcs";
import { MinkToolInputError } from "./errors";
import type { MinkActorContext } from "./types";

export type MinkMediaReferenceSource = "product" | "category" | "media";

export interface MinkMediaReferenceImage {
  url: string;
  fileUri: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  source: MinkMediaReferenceSource;
}

type ReferenceRow = {
  url: string;
  source: MinkMediaReferenceSource;
  content_type: string | null;
};

/**
 * Resolve model-selected reference URLs back to current-store records.
 *
 * The model may repeat only exact URLs returned by a permission-filtered read
 * tool. This lookup is the real authority boundary: it rechecks the tenant and
 * the actor's permission for the source collection, then converts only objects
 * in StoreMink's configured GCS bucket to Vertex-readable `gs://` references.
 * No arbitrary URL is fetched by StoreMink or handed to the image model.
 */
export async function resolveMinkMediaReferenceImages(
  actor: MinkActorContext,
  urls: readonly string[],
): Promise<MinkMediaReferenceImage[]> {
  if (urls.length === 0) return [];

  const mediaAllowed = can(
    actor.permissions,
    "media",
    "view",
    actor.isSuperadmin,
  );
  const productsAllowed = can(
    actor.permissions,
    "products",
    "view",
    actor.isSuperadmin,
  );
  const categoriesAllowed = can(
    actor.permissions,
    "categories",
    "view",
    actor.isSuperadmin,
  );

  const result = await withService((db) =>
    db.execute(sql`
      select distinct on (reference.url)
        reference.url,
        reference.source,
        reference.content_type
      from (
        select
          media.url,
          'media'::text as source,
          media.content_type,
          3 as source_rank
        from media_assets media
        where ${mediaAllowed}
          and media.store_id = ${actor.storeId}
          and media.url = any(${sql.param(urls)}::text[])

        union all

        select
          product.image_url as url,
          'product'::text as source,
          null::text as content_type,
          1 as source_rank
        from products product
        where ${productsAllowed}
          and product.store_id = ${actor.storeId}
          and product.image_url = any(${sql.param(urls)}::text[])

        union all

        select
          product_image.url,
          'product'::text as source,
          null::text as content_type,
          1 as source_rank
        from products product
        cross join lateral unnest(product.images) as product_image(url)
        where ${productsAllowed}
          and product.store_id = ${actor.storeId}
          and product_image.url = any(${sql.param(urls)}::text[])

        union all

        select
          category.image_url as url,
          'category'::text as source,
          null::text as content_type,
          2 as source_rank
        from categories category
        where ${categoriesAllowed}
          and category.store_id = ${actor.storeId}
          and category.image_url = any(${sql.param(urls)}::text[])
      ) reference
      order by reference.url, reference.source_rank
    `),
  );
  const byUrl = new Map(
    (result.rows as ReferenceRow[]).map((row) => [row.url, row]),
  );

  return urls.map((url) => {
    const row = byUrl.get(url);
    if (!row) {
      throw new MinkToolInputError(
        "Every reference image must be an exact, accessible URL returned by the current store's product, category, or Media Library tools.",
      );
    }
    const path = gcsPathFromUrl(url);
    const mimeType = referenceMimeType(row.content_type, url);
    if (!path || !GCS_BUCKET_NAME || !mimeType) {
      throw new MinkToolInputError(
        "A selected reference image is not a supported StoreMink PNG, JPEG, or WebP object. Choose another current-store image.",
      );
    }
    return {
      url,
      fileUri: `gs://${GCS_BUCKET_NAME}/${path}`,
      mimeType,
      source: row.source,
    };
  });
}

function referenceMimeType(
  contentType: string | null,
  url: string,
): MinkMediaReferenceImage["mimeType"] | null {
  if (
    contentType === "image/jpeg" ||
    contentType === "image/png" ||
    contentType === "image/webp"
  ) {
    return contentType;
  }
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.jpe?g$/.test(pathname)) return "image/jpeg";
  if (/\.png$/.test(pathname)) return "image/png";
  if (/\.webp$/.test(pathname)) return "image/webp";
  return null;
}
