import "server-only";

import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { revalidateTag } from "next/cache";
import {
  stores,
  themeStudioAssets,
  themeStudioPreviews,
  themeStudioProjects,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { STORE_TAG } from "@/lib/store/resolve";
import { subdomainOrigin } from "@/lib/store/host";
import { applyThemeDefinition } from "@/lib/themes/apply";
import type { ThemeDefinition } from "@/lib/themes/types";
import type { ThemeStudioActor } from "./access";
import { THEME_ASSET_PREFIX } from "./compiler";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import {
  PREVIEW_ENTER_TTL_SECONDS,
  previewTokensConfigured,
  signPreviewToken,
} from "./preview-token";
import { STUDIO_PREVIEW_SLUG_PREFIX } from "./preview-store";
import { isUuid, recordThemeStudioEvent, ThemeStudioError } from "./repository";

// ---------------------------------------------------------------------------
// Theme Studio previews: a candidate rendered by the REAL storefront.
//
// A preview is a hidden store materialized from one version: the version's
// pages, navigation and sample catalogue are seeded by the same applyTheme
// every signup and demo store uses, and its design is read from the version
// row at render time (lib/themes/runtime-registry.ts). So what an operator
// reviews is the storefront a merchant would get, not a second renderer.
//
// ★ IT IS A DEMO STORE, WHICH IS MOST OF ITS SAFETY. `settings.demo` already
// makes checkout refuse an order before any write, keeps the store noindex and
// out of sitemaps and search reconciliation, and admits applyTheme's reset.
// `settings.studioPreview` adds the one thing a demo store lacks: it resolves
// only for a request carrying a grant (preview-access.ts).
//
// ★ ONE STORE PER VERSION, and it is disposable. Deleting the store row
// cascades every row it seeded, including its theme_studio_previews row, so
// cleanup is a single statement. The DELETE carries both markers in its WHERE,
// so it can never remove a real merchant's store whatever id it is handed.
//
// ★ Images come from theme_studio_assets through a public, placeholder-only
// route, because next/image fetches local images without the request's
// cookies — a gated route would render every picture broken.
// ---------------------------------------------------------------------------

/** A preview lives this long after it was last opened. */
export const PREVIEW_IDLE_HOURS = 24;
/** A materialization that has not finished in this long is abandoned. */
const MATERIALIZE_STALE_MINUTES = 15;
/** Previews kept per project; opening another evicts the least recent. */
export const PREVIEWS_PER_PROJECT = 3;
/** A ceiling across the platform, so previews cannot grow the stores table. */
export const PREVIEWS_PLATFORM_MAX = 50;
/** The path a preview's "not found" view opens. No page can take it: it is
 * outside the slug grammar's ordinary vocabulary and nothing links to it. */
export const PREVIEW_MISSING_PATH = "/theme-studio-preview-missing-page";

export const PLACEHOLDER_ROUTE_PREFIX = "/api/theme-studio/placeholders/";

export type PreviewSurface =
  | "home"
  | "shop"
  | "product"
  | "cart"
  | "content"
  | "not_found";

export interface PreviewPage {
  surface: PreviewSurface;
  label: string;
  path: string;
}

/** The six review surfaces the plan fixes, resolved against this package. A
 * surface the package cannot show (no products, no content page) is omitted
 * rather than pointed at a page that would 404 for the wrong reason. */
export function previewPagesFor(pkg: ThemePackageV2): PreviewPage[] {
  const { preset } = pkg.definition;
  const product = preset.sampleData?.products[0];
  const content = preset.pages.find((page) => page.slug !== "");
  return [
    { surface: "home" as const, label: "Home", path: "/" },
    { surface: "shop" as const, label: "Shop", path: "/shop" },
    ...(product
      ? [
          {
            surface: "product" as const,
            label: "Product",
            path: `/shop/${encodeURIComponent(product.slug)}`,
          },
        ]
      : []),
    { surface: "cart" as const, label: "Cart", path: "/cart" },
    ...(content
      ? [
          {
            surface: "content" as const,
            label: content.title || "Content page",
            path: `/${encodeURIComponent(content.slug)}`,
          },
        ]
      : []),
    {
      surface: "not_found" as const,
      label: "Not found",
      path: PREVIEW_MISSING_PATH,
    },
  ];
}

/**
 * Replace every `theme-asset://<slot>` string in a definition with the URL of
 * that slot's stored placeholder. A slot with no stored image becomes "" — the
 * value every image field already accepts for "no image" — rather than a URL
 * that would 404 inside the page.
 */
export function rewriteThemeAssets(
  definition: ThemeDefinition,
  urlForSlot: ReadonlyMap<string, string>,
): ThemeDefinition {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.startsWith(THEME_ASSET_PREFIX)
        ? (urlForSlot.get(value.slice(THEME_ASSET_PREFIX.length)) ?? "")
        : value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return value;
  };
  return walk(definition) as ThemeDefinition;
}

function newPreviewSlug(): string {
  return `${STUDIO_PREVIEW_SLUG_PREFIX}${randomBytes(6).toString("hex")}`;
}

/** Remove a preview store and, by cascade, everything it seeded. Guarded on
 * both markers so it is inert against any store that is not a preview. */
async function deletePreviewStore(db: Db, storeId: string): Promise<number> {
  const rows = await db
    .delete(stores)
    .where(
      and(
        eq(stores.id, storeId),
        sql`${stores.settings} ->> 'demo' = 'true'`,
        sql`${stores.settings} ? 'studioPreview'`,
      ),
    )
    .returning({ id: stores.id });
  return rows.length;
}

async function slotUrls(
  db: Db,
  projectId: string,
  pkg: ThemePackageV2,
): Promise<Map<string, string>> {
  const digests = pkg.assets
    .map((asset) => asset.sha256)
    .filter((sha): sha is string => typeof sha === "string");
  const rows = digests.length
    ? await db
        .select({ id: themeStudioAssets.id, sha256: themeStudioAssets.sha256 })
        .from(themeStudioAssets)
        .where(
          and(
            eq(themeStudioAssets.projectId, projectId),
            eq(themeStudioAssets.purpose, "placeholder"),
            inArray(themeStudioAssets.sha256, digests),
          ),
        )
    : [];
  const bySha = new Map(rows.map((row) => [row.sha256, row.id]));
  const urls = new Map<string, string>();
  for (const asset of pkg.assets) {
    const id = asset.sha256 ? bySha.get(asset.sha256) : undefined;
    if (id) urls.set(asset.id, `${PLACEHOLDER_ROUTE_PREFIX}${id}`);
  }
  return urls;
}

export interface OpenedPreview {
  previewId: string;
  origin: string;
  enterToken: string;
  pages: PreviewPage[];
  expiresAt: string;
}

type Prepared =
  | { kind: "ready"; previewId: string; storeId: string; slug: string }
  | {
      kind: "create";
      previewId: string;
      storeId: string;
      slug: string;
      definition: ThemeDefinition;
      versionNumber: number;
    };

/**
 * Open (materializing if needed) the private preview of one version, and mint
 * a ten-minute token to enter it. The caller must have passed
 * getThemeStudioActor(); this module is not a "use server" file.
 */
export async function openThemeStudioPreview(
  actor: ThemeStudioActor,
  input: { projectId: string; versionId: string },
): Promise<OpenedPreview> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  if (!previewTokensConfigured()) {
    throw new ThemeStudioError(
      "provider_unavailable",
      "Previews need a signing key in this environment (THEME_STUDIO_PREVIEW_SECRET or CRON_SECRET).",
    );
  }
  const evicted: string[] = [];
  const prepared = await withService(async (db): Promise<Prepared> => {
    // The project row lock serialises two tabs opening the same preview.
    const [project] = await db
      .select({
        id: themeStudioProjects.id,
        status: themeStudioProjects.status,
      })
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    if (!project) {
      throw new ThemeStudioError("not_found", "That project no longer exists.");
    }
    if (project.status === "archived") {
      throw new ThemeStudioError(
        "illegal_state",
        "An archived project can't be previewed.",
      );
    }
    const [version] = await db
      .select({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
        packageJson: themeStudioVersions.packageJson,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!version?.packageJson) {
      throw new ThemeStudioError(
        "not_found",
        "That version has no theme to preview.",
      );
    }
    const parsed = validateThemePackageV2(version.packageJson);
    if (!parsed.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version's theme no longer passes validation, so it can't be previewed.",
      );
    }

    const [existing] = await db
      .select()
      .from(themeStudioPreviews)
      .where(eq(themeStudioPreviews.versionId, version.id))
      .limit(1);
    if (existing) {
      if (existing.status === "ready") {
        await db
          .update(themeStudioPreviews)
          .set({
            lastOpenedAt: sql`now()`,
            expiresAt: sql`now() + (${PREVIEW_IDLE_HOURS}::int * interval '1 hour')`,
            updatedAt: sql`now()`,
          })
          .where(eq(themeStudioPreviews.id, existing.id));
        const [store] = await db
          .select({ slug: stores.slug })
          .from(stores)
          .where(eq(stores.id, existing.storeId))
          .limit(1);
        if (store) {
          return {
            kind: "ready",
            previewId: existing.id,
            storeId: existing.storeId,
            slug: store.slug,
          };
        }
      }
      const stale =
        existing.status === "materializing" &&
        Date.parse(existing.updatedAt) <
          Date.now() - MATERIALIZE_STALE_MINUTES * 60_000;
      if (existing.status === "materializing" && !stale) {
        throw new ThemeStudioError(
          "illegal_state",
          "This preview is still being prepared. Try again in a moment.",
        );
      }
      // A failed or abandoned preview is rebuilt from scratch.
      await deletePreviewStore(db, existing.storeId);
    }

    const [{ n: total }] = await db
      .select({ n: count() })
      .from(themeStudioPreviews);
    if (Number(total) >= PREVIEWS_PLATFORM_MAX) {
      throw new ThemeStudioError(
        "limit",
        "Too many previews are open across the platform. Try again after older ones expire.",
      );
    }
    const siblings = await db
      .select({
        id: themeStudioPreviews.id,
        storeId: themeStudioPreviews.storeId,
      })
      .from(themeStudioPreviews)
      .where(eq(themeStudioPreviews.projectId, project.id))
      .orderBy(asc(themeStudioPreviews.lastOpenedAt));
    for (const sibling of siblings.slice(
      0,
      Math.max(0, siblings.length - (PREVIEWS_PER_PROJECT - 1)),
    )) {
      if (await deletePreviewStore(db, sibling.storeId)) {
        evicted.push(sibling.id);
      }
    }

    const definition = rewriteThemeAssets(
      parsed.value.definition,
      await slotUrls(db, project.id, parsed.value),
    );
    const slug = newPreviewSlug();
    const name = `${definition.name} · v${version.versionNumber} preview`;
    const [store] = await db
      .insert(stores)
      .values({
        slug,
        name,
        status: "active",
        plan: "free",
        settings: {
          demo: true,
          studioPreview: { projectId: project.id, versionId: version.id },
          brand: { name },
        },
      })
      .returning({ id: stores.id });
    const [preview] = await db
      .insert(themeStudioPreviews)
      .values({
        projectId: project.id,
        versionId: version.id,
        storeId: store.id,
        status: "materializing",
        createdBy: actor.id,
        expiresAt: sql`now() + (${PREVIEW_IDLE_HOURS}::int * interval '1 hour')`,
      })
      .returning({ id: themeStudioPreviews.id });
    return {
      kind: "create",
      previewId: preview.id,
      storeId: store.id,
      slug,
      definition,
      versionNumber: version.versionNumber,
    };
  });

  if (prepared.kind === "create") {
    // Outside the transaction: applyTheme runs many short writes of its own.
    const applied = await applyThemeDefinition(
      prepared.storeId,
      prepared.definition,
      { publish: true, publishSampleProducts: true, actorUserId: null },
    ).catch((error: unknown) => {
      logError("theme studio: preview materialization threw", error, {
        previewId: prepared.previewId,
      });
      return { success: false, errors: ["materialize: threw"] };
    });
    await withService(async (db) => {
      await db
        .update(themeStudioPreviews)
        .set({
          status: applied.success ? "ready" : "failed",
          updatedAt: sql`now()`,
        })
        .where(eq(themeStudioPreviews.id, prepared.previewId));
      await recordThemeStudioEvent(db, {
        projectId: input.projectId,
        actor,
        eventType: applied.success ? "preview_created" : "preview_failed",
        detail: {
          previewId: prepared.previewId,
          versionId: input.versionId,
          versionNumber: prepared.versionNumber,
          ...(applied.success ? {} : { problems: applied.errors.length }),
          ...(evicted.length ? { evicted: evicted.length } : {}),
        },
      });
    });
    revalidateTag(STORE_TAG, "max");
    if (!applied.success) {
      throw new ThemeStudioError(
        "illegal_state",
        "The preview couldn't be built from this version. Open it again to retry.",
      );
    }
  } else if (evicted.length) {
    revalidateTag(STORE_TAG, "max");
  }

  const [row] = await withService((db) =>
    db
      .select({
        expiresAt: themeStudioPreviews.expiresAt,
        packageJson: themeStudioVersions.packageJson,
      })
      .from(themeStudioPreviews)
      .innerJoin(
        themeStudioVersions,
        eq(themeStudioVersions.id, themeStudioPreviews.versionId),
      )
      .where(eq(themeStudioPreviews.id, prepared.previewId))
      .limit(1),
  );
  const parsed = row ? validateThemePackageV2(row.packageJson) : null;
  if (!row || !parsed?.ok) {
    throw new ThemeStudioError("not_found", "That preview no longer exists.");
  }
  return {
    previewId: prepared.previewId,
    origin: subdomainOrigin(prepared.slug),
    enterToken: signPreviewToken(
      "enter",
      {
        storeId: prepared.storeId,
        versionId: input.versionId,
        actorId: actor.id,
      },
      PREVIEW_ENTER_TTL_SECONDS,
    ),
    pages: previewPagesFor(parsed.value),
    expiresAt: row.expiresAt,
  };
}

/** Discard one project's previews now, for example when it is archived. */
export async function discardProjectPreviews(
  projectId: string,
): Promise<number> {
  return sweep(eq(themeStudioPreviews.projectId, projectId), 50);
}

async function sweep(where: SQL | undefined, limit: number): Promise<number> {
  const due = await withService((db) =>
    db
      .select({
        id: themeStudioPreviews.id,
        projectId: themeStudioPreviews.projectId,
        versionId: themeStudioPreviews.versionId,
        storeId: themeStudioPreviews.storeId,
      })
      .from(themeStudioPreviews)
      .where(where)
      .orderBy(asc(themeStudioPreviews.expiresAt))
      .limit(limit),
  );
  let removed = 0;
  for (const preview of due) {
    // One transaction per preview, so one failure leaves the rest to go.
    try {
      await withService(async (db) => {
        if (await deletePreviewStore(db, preview.storeId)) {
          removed += 1;
          await recordThemeStudioEvent(db, {
            projectId: preview.projectId,
            actor: "worker",
            eventType: "preview_expired",
            detail: { previewId: preview.id, versionId: preview.versionId },
          });
        }
      });
    } catch (error) {
      logError("theme studio: preview cleanup failed", error, {
        previewId: preview.id,
      });
    }
  }
  if (removed) revalidateTag(STORE_TAG, "max");
  return removed;
}

/**
 * The retention sweep, run on the existing heartbeat. Removes previews idle
 * past their expiry, materializations abandoned part-way, and every preview of
 * an archived project. Bounded per pass; a backlog drains over later passes.
 */
export async function sweepThemeStudioPreviews(
  limit = 10,
): Promise<{ removed: number }> {
  const removed = await sweep(
    or(
      lt(themeStudioPreviews.expiresAt, sql`now()`),
      and(
        eq(themeStudioPreviews.status, "materializing"),
        lt(
          themeStudioPreviews.updatedAt,
          sql`now() - (${MATERIALIZE_STALE_MINUTES}::int * interval '1 minute')`,
        ),
      ),
      sql`${themeStudioPreviews.projectId} IN (SELECT id FROM theme_studio_projects WHERE status = 'archived')`,
    ),
    limit,
  );
  return { removed };
}
