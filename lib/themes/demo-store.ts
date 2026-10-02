import "server-only";

import { eq, sql } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// The one way a theme's demo store row is created or refreshed.
//
// Three callers seed a demo store — the operator Themes panel
// (app/actions/platform.ts), Theme Studio publication
// (lib/theme-studio/publication.ts) and scripts/seed-demo-store.ts — and each
// used to write its own row with the name `${theme.name} Demo`. That suffix is
// what a visitor saw in the header of themes.storemink.com's live preview
// ("Luxe Demo"), on a page whose whole job is to show how the theme looks as
// a real shop. The demo IS the theme, so it carries the theme's own name.
//
// ★ A RESEED REWRITES THE NAME, so stores seeded before this change correct
// themselves the next time anyone seeds them. Demo stores are platform-owned
// (no admins row, nobody logs in), so there is no merchant edit to preserve.
//
// ★ IT REFUSES A NON-DEMO ROW. The slug namespace `demo-*` is blocked at
// signup, but a row that somehow holds the slug without `settings.demo` is a
// real store, and resetting it would wipe a merchant's catalogue.
// ---------------------------------------------------------------------------

export interface DemoStoreTheme {
  id: string;
  name: string;
  demo: { slug: string };
}

export class NotADemoStoreError extends Error {
  constructor(slug: string) {
    super(`The store ${slug} exists and is not a demo store.`);
  }
}

/** The name a demo store shows: the theme's own, never "… Demo". */
export function demoStoreName(theme: Pick<DemoStoreTheme, "name">): string {
  return theme.name.trim();
}

/**
 * Create `demo-{theme}` or bring an existing one's name up to date, inside the
 * caller's transaction. Returns the store id and whether it was created.
 */
export async function upsertDemoStoreRow(
  db: Db,
  theme: DemoStoreTheme,
): Promise<{ storeId: string; created: boolean }> {
  const slug = theme.demo.slug;
  const name = demoStoreName(theme);
  const [existing] = await db
    .select({ id: stores.id, settings: stores.settings })
    .from(stores)
    .where(eq(stores.slug, slug))
    .limit(1);
  if (existing) {
    const settings = (existing.settings ?? {}) as Record<string, unknown>;
    if (settings.demo !== true) throw new NotADemoStoreError(slug);
    await db
      .update(stores)
      .set({
        name,
        // Merge rather than jsonb_set: jsonb_set cannot create `brand` itself
        // when an older row has none, and would silently write nothing.
        settings: sql`coalesce(${stores.settings}, '{}'::jsonb) || jsonb_build_object('brand', coalesce(${stores.settings} -> 'brand', '{}'::jsonb) || jsonb_build_object('name', ${name}::text))`,
      })
      .where(eq(stores.id, existing.id));
    return { storeId: existing.id, created: false };
  }
  const [created] = await db
    .insert(stores)
    .values({
      slug,
      name,
      status: "active",
      plan: "free",
      settings: {
        demo: true,
        template: theme.id,
        brand: { name },
      },
    })
    .returning({ id: stores.id });
  return { storeId: created.id, created: true };
}
