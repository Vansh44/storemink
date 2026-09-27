/**
 * Seed (or reseed) a theme's demo store — the showcase behind the signup
 * picker's Preview link and the public theme catalog.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/seed-demo-store.ts vitrine
 *
 * ⚠ `--tsconfig` is NOT optional: lib/themes/apply.ts imports `next/cache`,
 * whose revalidation helpers throw outside a request scope, and the db client
 * chain imports `server-only`. That tsconfig maps both to scripts/_stubs/.
 *
 * ⚠ CHECK WHICH DATABASE YOU ARE SEEDING. `.env` points at STAGING
 * (DB_NAME=storemink_staging), and staging + prod are two databases in ONE
 * Cloud SQL instance, so the proxy being up says nothing about which one you
 * hit. A shell variable beats .env, so PRODUCTION is:
 *
 *   DB_NAME=storemink npx tsx --tsconfig tsconfig.scripts.json \
 *     scripts/seed-demo-store.ts vitrine
 *
 * This is the same work app/actions/platform.ts's `seedDemoStore` does, minus
 * its `requireSuperadmin()` gate — that reads a session cookie and cannot be
 * satisfied outside a request. Prefer the Themes panel on the platform stores
 * console when you have an operator login; use this when you do not.
 *
 * Idempotent: the store row is created only when missing, and applyTheme
 * upserts on (store_id, slug) with reset:true, which is refused unless the
 * store is marked `settings.demo === true`. Re-running restores a demo that
 * someone has clicked around in.
 *
 * ⚠ Revalidation is a no-op here (see scripts/_stubs/next-cache.ts), so an
 * already-running server can serve stale cached reads for up to 300s. A NEW
 * store host resolves immediately — negative host lookups are never cached.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

async function main() {
  const themeId = process.argv[2];
  if (!themeId) {
    console.error(
      "Usage: npx tsx --tsconfig tsconfig.scripts.json scripts/seed-demo-store.ts <themeId>",
    );
    process.exit(1);
  }

  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env at module scope.
  const { resolveThemeDefinition } =
    await import("@/lib/themes/runtime-registry");
  const { applyTheme } = await import("@/lib/themes/apply");
  const { withService } = await import("@/lib/db/client");
  const { stores } = await import("@/drizzle/schema");
  const { eq } = await import("drizzle-orm");

  const theme = await resolveThemeDefinition(themeId);
  if (theme.id !== themeId) {
    console.error(
      `Unknown theme "${themeId}". Registered: nothing resolves to that id.`,
    );
    process.exit(1);
  }

  const slug = theme.demo.slug;
  const dbName = process.env.DB_NAME ?? "(unset)";
  const isProd = dbName === "storemink";
  console.log(
    `\nTheme    ${theme.id} ${theme.release.version}\n` +
      `Store    ${slug}\n` +
      `Database ${dbName}${isProd ? "  ← PRODUCTION" : "  (staging)"}\n`,
  );

  const { storeId, created } = await withService(async (db) => {
    const existing = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.slug, slug))
      .limit(1);
    if (existing[0]) return { storeId: existing[0].id, created: false };

    const [row] = await db
      .insert(stores)
      .values({
        slug,
        name: `${theme.name} Demo`,
        status: "active",
        plan: "free",
        settings: {
          demo: true,
          template: theme.id,
          brand: { name: `${theme.name} Demo` },
        },
      })
      .returning({ id: stores.id });
    return { storeId: row.id, created: true };
  });
  console.log(`${created ? "Created" : "Found"} store ${storeId}`);

  const result = await applyTheme(storeId, theme.id, {
    publish: true,
    reset: true,
    // A demo store IS the showcase, so its sample catalogue must be live.
    // Real merchant stores seed these as drafts.
    publishSampleProducts: true,
  });

  if (result.errors?.length) {
    console.log(`\nCompleted with ${result.errors.length} warning(s):`);
    for (const e of result.errors) console.log(`  - ${e}`);
  }
  console.log(
    result.success
      ? `\nSeeded. ${slug} is ready.\n`
      : `\nSeeding reported failure — see the warnings above.\n`,
  );
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
