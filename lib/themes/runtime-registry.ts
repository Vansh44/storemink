import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidateTag, unstable_cache } from "next/cache";
import { themeCatalogEntries, themeReleases } from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  canonicalJson,
  themeDefinitionToPackageV2,
  validateThemePackageV2,
  type ThemePackageV2,
} from "@/lib/theme-studio/contracts";
import {
  getThemeDefinition,
  isBundledThemeId,
  THEME_DEFINITIONS,
} from "./index";
import {
  THEME_META,
  isThemeId,
  type ThemeCatalogVisibility,
  type ThemeMeta,
  type ThemeSelection,
} from "./meta";
import type { ThemeDefinition } from "./types";

export const THEME_REGISTRY_TAG = "theme-runtime-registry";
const THEME_REGISTRY_REVALIDATE_SECONDS = 300;
/** Same ceiling as theme_releases_package_size_check, measured the same way. */
const THEME_PACKAGE_MAX_BYTES = 2 * 1024 * 1024;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED_RELEASE_STATUSES = new Set([
  "candidate",
  "approved",
  "published",
  "blocked",
]);

type StoredReleaseRow = {
  id: string;
  themeId: string;
  version: string;
  releaseStatus: string;
  packageJson: unknown;
  manifestDigest: string;
};

type StoredCatalogRow = StoredReleaseRow & {
  visibility: string;
};

export interface RuntimeThemeRelease {
  id: string;
  package: ThemePackageV2;
  definition: ThemeDefinition;
  manifestDigest: string;
  status: "candidate" | "approved" | "published" | "blocked";
}

export interface BundledThemeImportResult {
  inserted: string[];
  existing: string[];
  catalogEntriesCreated: string[];
}

export type ThemeReleaseSource = "bundled-import" | "theme-studio";

/** Content address for the exact JSON value persisted in package_json. Keys
 * are sorted, so jsonb's own key reordering cannot change the digest. */
export function digestThemePackage(pkg: ThemePackageV2): string {
  return createHash("sha256").update(canonicalJson(pkg)).digest("hex");
}

/** Byte length of `package_json::text`, which is what the database CHECK
 * measures. jsonb's text output writes `": "` and `", "` separators, so it is
 * larger than compact JSON.stringify output; measuring the compact form lets
 * a package just under the limit through here and into a raw constraint
 * violation at INSERT. */
export function jsonbTextBytes(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 2;
    return (
      2 +
      2 * (value.length - 1) +
      value.reduce<number>(
        (total, item) =>
          total + jsonbTextBytes(item === undefined ? null : item),
        0,
      )
    );
  }
  const entries = Object.entries(value).filter(
    ([, nested]) => nested !== undefined,
  );
  if (entries.length === 0) return 2;
  return (
    2 +
    2 * (entries.length - 1) +
    entries.reduce(
      (total, [key, nested]) =>
        total +
        Buffer.byteLength(JSON.stringify(key), "utf8") +
        2 +
        jsonbTextBytes(nested),
      0,
    )
  );
}

function assertActorId(actorId: string | null | undefined): string | null {
  if (actorId === undefined || actorId === null) return null;
  // created_by / updated_by record a platform_admins.id (uuid). A Firebase
  // session uid is text and would fail the uuid cast mid-transaction.
  if (!UUID_RE.test(actorId)) {
    throw new Error("actorId must be a platform_admins.id (uuid).");
  }
  return actorId;
}

function parseRelease(row: StoredReleaseRow): RuntimeThemeRelease | null {
  if (
    !isThemeId(row.themeId) ||
    !SEMVER_RE.test(row.version) ||
    !STORED_RELEASE_STATUSES.has(row.releaseStatus) ||
    !/^[a-f0-9]{64}$/.test(row.manifestDigest)
  ) {
    return null;
  }
  const parsed = validateThemePackageV2(row.packageJson);
  if (!parsed.ok) return null;
  const definition = parsed.value.definition;
  if (
    definition.id !== row.themeId ||
    definition.release.version !== row.version ||
    definition.release.status !== row.releaseStatus ||
    digestThemePackage(parsed.value) !== row.manifestDigest
  ) {
    return null;
  }
  return {
    id: row.id,
    package: parsed.value,
    definition,
    manifestDigest: row.manifestDigest,
    status: row.releaseStatus as RuntimeThemeRelease["status"],
  };
}

function isCatalogVisibility(value: string): value is ThemeCatalogVisibility {
  return value === "hidden" || value === "legacy" || value === "public";
}

/** The client-safe projection. Spreading a ThemeDefinition into a ThemeMeta
 * type-checks but carries `preset` (pages, menus, sample catalog) with it,
 * straight into the signup client's RSC payload. */
function toThemeMeta(
  definition: ThemeDefinition,
  visibility: ThemeCatalogVisibility,
): ThemeMeta {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    engine: definition.engine,
    release: definition.release,
    catalog: { ...definition.catalog, visibility },
    demo: definition.demo,
  };
}

const RELEASE_COLUMNS = {
  id: themeReleases.id,
  themeId: themeReleases.themeId,
  version: themeReleases.version,
  releaseStatus: themeReleases.releaseStatus,
  packageJson: themeReleases.packageJson,
  manifestDigest: themeReleases.manifestDigest,
};

function catalogJoin(db: Db) {
  return db
    .select({ ...RELEASE_COLUMNS, visibility: themeCatalogEntries.visibility })
    .from(themeCatalogEntries)
    .innerJoin(
      themeReleases,
      and(
        eq(themeReleases.id, themeCatalogEntries.currentReleaseId),
        eq(themeReleases.themeId, themeCatalogEntries.themeId),
      ),
    );
}

async function queryExactReleaseRowWithDb(
  db: Db,
  themeId: string,
  version: string,
): Promise<StoredReleaseRow | null> {
  const rows = await db
    .select(RELEASE_COLUMNS)
    .from(themeReleases)
    .where(
      and(
        eq(themeReleases.themeId, themeId),
        eq(themeReleases.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Loaders return PARSED values. Validation and the content-digest check run
// once, when a cache entry is filled, instead of on every storefront render;
// and a cache entry is a definition, not a whole catalog of raw packages.

async function loadExactReleaseWithDb(
  db: Db,
  themeId: string,
  version: string,
): Promise<RuntimeThemeRelease | null> {
  const row = await queryExactReleaseRowWithDb(db, themeId, version);
  return row ? parseRelease(row) : null;
}

async function loadCurrentReleaseWithDb(
  db: Db,
  themeId: string,
): Promise<RuntimeThemeRelease | null> {
  const rows = await catalogJoin(db)
    .where(eq(themeCatalogEntries.themeId, themeId))
    .limit(1);
  return rows[0] ? parseRelease(rows[0]) : null;
}

async function loadCatalogProjectionWithDb(db: Db): Promise<ThemeMeta[]> {
  const rows: StoredCatalogRow[] = await catalogJoin(db);
  const projected: ThemeMeta[] = [];
  for (const row of rows) {
    const release = parseRelease(row);
    if (
      release?.status === "published" &&
      isCatalogVisibility(row.visibility)
    ) {
      projected.push(toThemeMeta(release.definition, row.visibility));
    }
  }
  return projected;
}

const CACHE_OPTIONS = {
  tags: [THEME_REGISTRY_TAG],
  revalidate: THEME_REGISTRY_REVALIDATE_SECONDS,
};

const exactReleaseCached = unstable_cache(
  (themeId: string, version: string) =>
    withService((db) => loadExactReleaseWithDb(db, themeId, version)),
  ["theme-runtime-release-parsed-v2"],
  CACHE_OPTIONS,
);

const currentReleaseCached = unstable_cache(
  (themeId: string) =>
    withService((db) => loadCurrentReleaseWithDb(db, themeId)),
  ["theme-runtime-current-parsed-v2"],
  CACHE_OPTIONS,
);

const catalogProjectionCached = unstable_cache(
  () => withService(loadCatalogProjectionWithDb),
  ["theme-runtime-catalog-meta-v2"],
  CACHE_OPTIONS,
);

/** Server actions, scripts and some tests have no incremental-cache scope, so
 * the cached read throws there; read straight through instead. The cache is an
 * optimization, not a source of correctness. During the additive rollout the
 * previous revision can also run before migration 0127 exists, in which case
 * the bundled themes remain the deliberate safe fallback. */
async function readThrough<T>(
  cached: () => Promise<T>,
  direct: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await cached();
  } catch {
    try {
      return await direct();
    } catch {
      return fallback;
    }
  }
}

interface ReleaseLoaders {
  exact(themeId: string, version: string): Promise<RuntimeThemeRelease | null>;
  current(themeId: string): Promise<RuntimeThemeRelease | null>;
}

const cachedLoaders: ReleaseLoaders = {
  exact: (themeId, version) =>
    readThrough(
      () => exactReleaseCached(themeId, version),
      () => withService((db) => loadExactReleaseWithDb(db, themeId, version)),
      null,
    ),
  current: (themeId) =>
    readThrough(
      () => currentReleaseCached(themeId),
      () => withService((db) => loadCurrentReleaseWithDb(db, themeId)),
      null,
    ),
};

function transactionLoaders(db: Db): ReleaseLoaders {
  return {
    exact: (themeId, version) => loadExactReleaseWithDb(db, themeId, version),
    current: (themeId) => loadCurrentReleaseWithDb(db, themeId),
  };
}

/** The one precedence rule: a pinned exact release, else the catalog pointer.
 * Only a published release is ever served from here. */
async function resolveRuntimeDefinition(
  loaders: ReleaseLoaders,
  id: unknown,
  version: unknown,
): Promise<ThemeDefinition | null> {
  if (!isThemeId(id)) return null;
  const release =
    typeof version === "string" && SEMVER_RE.test(version)
      ? await loaders.exact(id, version)
      : await loaders.current(id);
  return release?.status === "published" ? release.definition : null;
}

async function resolveInstalled(
  loaders: ReleaseLoaders,
  selection: ThemeSelection | null,
): Promise<ThemeDefinition | null> {
  if (!selection) return null;
  const runtime = await resolveRuntimeDefinition(
    loaders,
    selection.id,
    selection.version,
  );
  if (runtime) return runtime;
  return isBundledThemeId(selection.id)
    ? getThemeDefinition(selection.id, selection.version)
    : null;
}

/** Public/client-safe catalog projection. A valid runtime pointer replaces the
 * bundled release with the same id; unimported bundled themes remain present. */
export async function getThemeCatalog(): Promise<ThemeMeta[]> {
  const resolved = new Map(THEME_META.map((theme) => [theme.id, theme]));
  const runtime = await readThrough(
    catalogProjectionCached,
    () => withService(loadCatalogProjectionWithDb),
    [],
  );
  for (const meta of runtime) resolved.set(meta.id, meta);
  return [...resolved.values()];
}

/** Resolve a theme to INSTALL (signup, demo seeding, applyTheme): a pinned
 * runtime release, then the runtime catalog pointer, then the bundled release,
 * then the platform default. Rendering an already-installed store must use
 * resolveInstalledThemeDefinition instead, which never substitutes the default. */
export async function resolveThemeDefinition(
  id: unknown,
  version?: unknown,
): Promise<ThemeDefinition> {
  return (
    (await resolveRuntimeDefinition(cachedLoaders, id, version)) ??
    getThemeDefinition(id, version)
  );
}

/** Transaction-aware variant of resolveThemeDefinition for repositories that
 * already hold a scoped database transaction (no nested pool connection). */
export async function resolveThemeDefinitionWithDb(
  db: Db,
  id: unknown,
  version?: unknown,
): Promise<ThemeDefinition> {
  return (
    (await resolveRuntimeDefinition(transactionLoaders(db), id, version)) ??
    getThemeDefinition(id, version)
  );
}

/** Resolve the theme a store has INSTALLED, for rendering and design reads.
 * Returns null — the store renders un-themed, exactly as it did before the
 * runtime registry — when the selected id is neither a runtime release nor a
 * bundled preset. Falling back to the platform default here would silently
 * re-skin every store carrying a retired or stray `template` value. */
export async function resolveInstalledThemeDefinition(
  selection: ThemeSelection | null,
): Promise<ThemeDefinition | null> {
  return resolveInstalled(cachedLoaders, selection);
}

export async function resolveInstalledThemeDefinitionWithDb(
  db: Db,
  selection: ThemeSelection | null,
): Promise<ThemeDefinition | null> {
  return resolveInstalled(transactionLoaders(db), selection);
}

/** Exact operator-preview lookup. It never substitutes the current release or
 * bundled default, so a typo cannot preview or approve the wrong package. */
export async function resolveThemeCandidateDefinition(
  themeId: unknown,
  version: unknown,
): Promise<RuntimeThemeRelease | null> {
  if (
    !isThemeId(themeId) ||
    typeof version !== "string" ||
    !SEMVER_RE.test(version)
  ) {
    return null;
  }
  return cachedLoaders.exact(themeId, version);
}

export function revalidateThemeRegistry(): void {
  revalidateTag(THEME_REGISTRY_TAG, "max");
}

async function insertThemeReleaseWithDb(
  db: Db,
  input: {
    package: unknown;
    source: ThemeReleaseSource;
    actorId?: string | null;
  },
): Promise<{ release: RuntimeThemeRelease; inserted: boolean }> {
  const parsed = validateThemePackageV2(input.package);
  if (!parsed.ok) {
    throw new Error(`Invalid theme package: ${parsed.issues.join(" ")}`);
  }
  const definition = parsed.value.definition;
  if (!STORED_RELEASE_STATUSES.has(definition.release.status)) {
    throw new Error("A runtime release must have a storable release status.");
  }
  if (
    (input.source === "bundled-import" &&
      parsed.value.provenance.origin !== "bundled") ||
    (input.source === "theme-studio" &&
      parsed.value.provenance.origin !== "generated")
  ) {
    throw new Error("Theme package provenance does not match its source.");
  }
  if (jsonbTextBytes(parsed.value) > THEME_PACKAGE_MAX_BYTES) {
    throw new Error("Theme package exceeds the 2 MiB registry limit.");
  }
  const createdBy = assertActorId(input.actorId);

  const manifestDigest = digestThemePackage(parsed.value);
  const [created] = await db
    .insert(themeReleases)
    .values({
      themeId: definition.id,
      version: definition.release.version,
      releaseStatus: definition.release.status,
      packageJson: parsed.value,
      manifestDigest,
      source: input.source,
      createdBy,
    })
    .onConflictDoNothing({
      target: [themeReleases.themeId, themeReleases.version],
    })
    .returning({ id: themeReleases.id });

  const row = created
    ? {
        id: created.id,
        themeId: definition.id,
        version: definition.release.version,
        releaseStatus: definition.release.status,
        packageJson: parsed.value,
        manifestDigest,
      }
    : await queryExactReleaseRowWithDb(
        db,
        definition.id,
        definition.release.version,
      );
  const release = row ? parseRelease(row) : null;
  if (!release || release.manifestDigest !== manifestDigest) {
    throw new Error(
      `Immutable theme release collision for ${definition.id}@${definition.release.version}.`,
    );
  }
  return { release, inserted: Boolean(created) };
}

/** Store one validated immutable package. A retry returns the existing row
 * only when its content digest matches exactly; id/version reuse with changed
 * content is refused. */
export async function insertThemeRelease(input: {
  package: unknown;
  source?: ThemeReleaseSource;
  actorId?: string | null;
}): Promise<{ release: RuntimeThemeRelease; inserted: boolean }> {
  const result = await withService((db) =>
    insertThemeReleaseWithDb(db, {
      ...input,
      source: input.source ?? "theme-studio",
    }),
  );
  revalidateThemeRegistry();
  return result;
}

/** Idempotently copy source-controlled releases into the runtime registry.
 * Existing rows must have the same digest; an immutable id/version collision
 * with different content fails closed. Missing catalog pointers are created,
 * but an existing pointer is never advanced by an import. */
export async function importBundledThemeReleases(): Promise<BundledThemeImportResult> {
  const prepared = THEME_DEFINITIONS.map((definition) => {
    const pkg = themeDefinitionToPackageV2(definition);
    const parsed = validateThemePackageV2(pkg);
    if (!parsed.ok) {
      throw new Error(
        `Bundled theme ${definition.id}@${definition.release.version} is invalid: ${parsed.issues.join(" ")}`,
      );
    }
    if (definition.release.status !== "published") {
      throw new Error(
        `Bundled theme ${definition.id}@${definition.release.version} is not published.`,
      );
    }
    return { definition, pkg: parsed.value };
  });

  const result = await withService(async (db) => {
    const inserted: string[] = [];
    const existing: string[] = [];
    const catalogEntriesCreated: string[] = [];

    for (const item of prepared) {
      const key = `${item.definition.id}@${item.definition.release.version}`;
      const stored = await insertThemeReleaseWithDb(db, {
        package: item.pkg,
        source: "bundled-import",
      });
      (stored.inserted ? inserted : existing).push(key);

      const [entry] = await db
        .insert(themeCatalogEntries)
        .values({
          themeId: item.definition.id,
          currentReleaseId: stored.release.id,
          visibility: item.definition.catalog.visibility,
        })
        .onConflictDoNothing({ target: themeCatalogEntries.themeId })
        .returning({ themeId: themeCatalogEntries.themeId });
      if (entry) catalogEntriesCreated.push(entry.themeId);
    }
    return { inserted, existing, catalogEntriesCreated };
  });
  revalidateThemeRegistry();
  return result;
}

/** Move or restore the catalog pointer to an exact immutable published row.
 * Installed stores remain pinned to their own theme id/version. */
export async function selectThemeCatalogRelease(input: {
  themeId: string;
  version: string;
  visibility: ThemeCatalogVisibility;
  actorId?: string | null;
}): Promise<{ releaseId: string; manifestDigest: string }> {
  if (!isThemeId(input.themeId) || !SEMVER_RE.test(input.version)) {
    throw new Error("A valid theme id and semantic version are required.");
  }
  if (!isCatalogVisibility(input.visibility)) {
    throw new Error("Visibility must be hidden, legacy, or public.");
  }
  const updatedBy = assertActorId(input.actorId);
  const result = await withService(async (db) => {
    // Parse the package with the SAME check the readers apply. A status-only
    // check would report "activated" for a row every reader then rejects,
    // leaving the bundled release live while the operator believes the
    // publish or rollback happened.
    const release = await loadExactReleaseWithDb(
      db,
      input.themeId,
      input.version,
    );
    if (!release) {
      throw new Error(
        "The selected runtime theme release does not exist or failed validation.",
      );
    }
    if (release.status !== "published") {
      throw new Error("The selected runtime theme release is not published.");
    }
    await db
      .insert(themeCatalogEntries)
      .values({
        themeId: input.themeId,
        currentReleaseId: release.id,
        visibility: input.visibility,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: themeCatalogEntries.themeId,
        set: {
          currentReleaseId: release.id,
          visibility: input.visibility,
          updatedBy,
        },
      });
    return { releaseId: release.id, manifestDigest: release.manifestDigest };
  });
  revalidateThemeRegistry();
  return result;
}
