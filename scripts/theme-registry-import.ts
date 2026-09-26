/**
 * Inspect or import the bundled theme releases into the Phase 1 runtime
 * registry.
 *
 *   npm run theme-registry:import
 *   npm run theme-registry:import -- --commit
 *   npm run theme-registry:import -- --activate studio@0.1.0 --visibility public
 *
 * Dry-run is the default. `--commit` idempotently inserts every bundled
 * release and creates only missing catalog pointers. `--activate` imports
 * first, then explicitly moves one catalog pointer; it never changes stores
 * already pinned to another release.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const activation = option("--activate");
  const visibility = option("--visibility") ?? "public";
  const dbName = process.env.DB_NAME ?? "(unset)";

  if (!["hidden", "legacy", "public"].includes(visibility)) {
    throw new Error("--visibility must be hidden, legacy, or public.");
  }
  if (
    (commit || activation) &&
    dbName === "storemink" &&
    option("--confirm-production") !== "storemink"
  ) {
    throw new Error(
      "Production requires --confirm-production storemink after checking DB_NAME.",
    );
  }

  const { THEME_DEFINITIONS } = await import("@/lib/themes");
  const {
    digestThemePackage,
    importBundledThemeReleases,
    selectThemeCatalogRelease,
  } = await import("@/lib/themes/runtime-registry");
  const { themeDefinitionToPackageV2 } =
    await import("@/lib/theme-studio/contracts");

  console.log(`Database: ${dbName}`);
  console.log("Bundled releases:");
  for (const definition of THEME_DEFINITIONS) {
    const digest = digestThemePackage(themeDefinitionToPackageV2(definition));
    console.log(
      `  ${definition.id}@${definition.release.version} ${digest} ${definition.catalog.visibility}`,
    );
  }

  if (!commit && !activation) {
    console.log("\nDry run only. Pass --commit to write the registry.");
    return;
  }

  const imported = await importBundledThemeReleases();
  console.log(`\nInserted: ${imported.inserted.join(", ") || "none"}`);
  console.log(`Existing: ${imported.existing.join(", ") || "none"}`);
  console.log(
    `Catalog pointers created: ${imported.catalogEntriesCreated.join(", ") || "none"}`,
  );

  if (activation) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+)$/.exec(
      activation,
    );
    if (!match) {
      throw new Error("--activate must use theme-id@major.minor.patch.");
    }
    const selected = await selectThemeCatalogRelease({
      themeId: match[1],
      version: match[2],
      visibility: visibility as "hidden" | "legacy" | "public",
    });
    console.log(
      `Activated ${activation} (${selected.manifestDigest}) as ${visibility}.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
