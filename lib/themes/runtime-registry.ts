import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidateTag, unstable_cache } from "next/cache";
import { themeCatalogEntries, themeReleases } from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  themeDefinitionToPackageV2,
  validateThemePackageV2,
  type ThemePackageV2,
} from "@/lib/theme-studio/contracts";
import { getThemeDefinition, THEME_DEFINITIONS } from "./index";
import {
  THEME_META,
  isThemeId,
  type ThemeCatalogVisibility,
  type ThemeMeta,
} from "./meta";
import type { ThemeDefinition } from "./types";

export const THEME_REGISTRY_TAG = "theme-runtime-registry";
const THEME_REGISTRY_REVALIDATE_SECONDS = 300;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Content address for the exact JSON value persisted in package_json. */
export function digestThemePackage(pkg: ThemePackageV2): string {
  const jsonValue = JSON.parse(JSON.stringify(pkg)) as unknown;
  return createHash("sha256").update(canonicalJson(jsonValue)).digest("hex");
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

async function queryCatalogRowsWithDb(db: Db): Promise<StoredCatalogRow[]> {
  return db
    .select({
      id: themeReleases.id,
      themeId: themeReleases.themeId,
      version: themeReleases.version,
      releaseStatus: themeReleases.releaseStatus,
      packageJson: themeReleases.packageJson,
      manifestDigest: themeReleases.manifestDigest,
      visibility: themeCatalogEntries.visibility,
    })
    .from(themeCatalogEntries)
    .innerJoin(
      themeReleases,
      and(
        eq(themeReleases.id, themeCatalogEntries.currentReleaseId),
        eq(themeReleases.themeId, themeCatalogEntries.themeId),
      ),
    );
}

async function queryCatalogRows(): Promise<StoredCatalogRow[]> {
  return withService(queryCatalogRowsWithDb);
}

const queryCatalogRowsCached = unstable_cache(
  queryCatalogRows,
  ["theme-runtime-catalog"],
  {
    tags: [THEME_REGISTRY_TAG],
    revalidate: THEME_REGISTRY_REVALIDATE_SECONDS,
  },
);

async function catalogRows(): Promise<StoredCatalogRow[]> {
  try {
    return await queryCatalogRowsCached();
  } catch {
    // Server actions, scripts and some tests have no incremental-cache scope.
    // Read straight through there; the cache is an optimization, not a source
    // of correctness. During the additive rollout the old revision can also
    // run before migration 0127 exists, in which case bundled themes remain
    // the deliberate safe fallback.
    try {
      return await queryCatalogRows();
    } catch {
      return [];
    }
  }
}

async function queryExactRelease(
  themeId: string,
  version: string,
): Promise<StoredReleaseRow | null> {
  return withService((db) => queryExactReleaseWithDb(db, themeId, version));
}

async function queryExactReleaseWithDb(
  db: Db,
  themeId: string,
  version: string,
): Promise<StoredReleaseRow | null> {
  const rows = await db
    .select({
      id: themeReleases.id,
      themeId: themeReleases.themeId,
      version: themeReleases.version,
      releaseStatus: themeReleases.releaseStatus,
      packageJson: themeReleases.packageJson,
      manifestDigest: themeReleases.manifestDigest,
    })
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

const queryExactReleaseCached = unstable_cache(
  queryExactRelease,
  ["theme-runtime-release"],
  {
    tags: [THEME_REGISTRY_TAG],
    revalidate: THEME_REGISTRY_REVALIDATE_SECONDS,
  },
);

async function exactRelease(
  themeId: string,
  version: string,
): Promise<RuntimeThemeRelease | null> {
  try {
    const row = await queryExactReleaseCached(themeId, version);
    return row ? parseRelease(row) : null;
  } catch {
    try {
      const row = await queryExactRelease(themeId, version);
      return row ? parseRelease(row) : null;
    } catch {
      return null;
    }
  }
}

/** Public/client-safe catalog projection. A valid runtime pointer replaces the
 * bundled release with the same id; unimported bundled themes remain present. */
export async function getThemeCatalog(): Promise<ThemeMeta[]> {
  const resolved = new Map(THEME_META.map((theme) => [theme.id, theme]));
  for (const row of await catalogRows()) {
    const release = parseRelease(row);
    if (
      !release ||
      release.status !== "published" ||
      !isCatalogVisibility(row.visibility)
    ) {
      continue;
    }
    resolved.set(release.definition.id, {
      ...release.definition,
      catalog: {
        ...release.definition.catalog,
        visibility: row.visibility,
      },
    });
  }
  return [...resolved.values()];
}

/** Resolve storefront/install behavior from a pinned runtime release first,
 * then the runtime catalog pointer, then the immutable bundled fallback. */
export async function resolveThemeDefinition(
  id: unknown,
  version?: unknown,
): Promise<ThemeDefinition> {
  if (isThemeId(id)) {
    if (typeof version === "string" && SEMVER_RE.test(version)) {
      const pinned = await exactRelease(id, version);
      if (pinned?.status === "published") return pinned.definition;
    } else {
      const row = (await catalogRows()).find((entry) => entry.themeId === id);
      const current = row ? parseRelease(row) : null;
      if (current?.status === "published") return current.definition;
    }
  }
  return getThemeDefinition(id, version);
}

/** Transaction-aware resolver for service repositories that already hold a
 * scoped database transaction. This avoids opening a nested pool connection. */
export async function resolveThemeDefinitionWithDb(
  db: Db,
  id: unknown,
  version?: unknown,
): Promise<ThemeDefinition> {
  if (isThemeId(id)) {
    if (typeof version === "string" && SEMVER_RE.test(version)) {
      const row = await queryExactReleaseWithDb(db, id, version);
      const pinned = row ? parseRelease(row) : null;
      if (pinned?.status === "published") return pinned.definition;
    } else {
      const row = (await queryCatalogRowsWithDb(db)).find(
        (entry) => entry.themeId === id,
      );
      const current = row ? parseRelease(row) : null;
      if (current?.status === "published") return current.definition;
    }
  }
  return getThemeDefinition(id, version);
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
  return exactRelease(themeId, version);
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
  if (
    Buffer.byteLength(JSON.stringify(parsed.value), "utf8") >
    2 * 1024 * 1024
  ) {
    throw new Error("Theme package exceeds the 2 MiB registry limit.");
  }

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
      createdBy: input.actorId ?? null,
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
    : await queryExactReleaseWithDb(
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
  const result = await withService(async (db) => {
    const rows = await db
      .select({
        id: themeReleases.id,
        status: themeReleases.releaseStatus,
        digest: themeReleases.manifestDigest,
      })
      .from(themeReleases)
      .where(
        and(
          eq(themeReleases.themeId, input.themeId),
          eq(themeReleases.version, input.version),
        ),
      )
      .limit(1);
    const release = rows[0];
    if (!release || release.status !== "published") {
      throw new Error("The selected runtime theme release is not published.");
    }
    await db
      .insert(themeCatalogEntries)
      .values({
        themeId: input.themeId,
        currentReleaseId: release.id,
        visibility: input.visibility,
        updatedBy: input.actorId ?? null,
      })
      .onConflictDoUpdate({
        target: themeCatalogEntries.themeId,
        set: {
          currentReleaseId: release.id,
          visibility: input.visibility,
          updatedBy: input.actorId ?? null,
        },
      });
    return { releaseId: release.id, manifestDigest: release.digest };
  });
  revalidateThemeRegistry();
  return result;
}
