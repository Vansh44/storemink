import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeDefinition } from "./types";

const state = vi.hoisted(() => ({
  catalogRows: [] as unknown[],
  exactRows: [] as unknown[],
  insertedValues: [] as unknown[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (db: unknown) => unknown) =>
    run({
      select: () => ({
        from: () => ({
          // The catalog projection awaits the join directly; the current-
          // release lookup narrows it with .where().limit().
          innerJoin: () =>
            Object.assign(Promise.resolve(state.catalogRows), {
              where: () => ({
                limit: async () => state.catalogRows.slice(0, 1),
              }),
            }),
          where: () => ({
            limit: async () => state.exactRows,
          }),
        }),
      }),
      insert: () => ({
        values: (values: unknown) => {
          state.insertedValues.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "new-release" }],
            }),
            onConflictDoUpdate: async () => [],
          };
        },
      }),
    }),
  ),
}));

import { getThemeDefinition } from "./index";
import { themeDefinitionToPackageV2 } from "@/lib/theme-studio/contracts";
import {
  digestThemePackage,
  getThemeCatalog,
  insertThemeRelease,
  jsonbTextBytes,
  resolveInstalledThemeDefinition,
  resolveThemeCandidateDefinition,
  resolveThemeDefinition,
  selectThemeCatalogRelease,
} from "./runtime-registry";

/** What PostgreSQL hands back for a jsonb value: object keys re-ordered by
 * length, then bytes. Every stored row in these tests goes through it, because
 * a package that only validates in its original key order is one that stops
 * validating the moment it is stored. */
function jsonbRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbRoundTrip);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) =>
      a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0,
    );
  return Object.fromEntries(
    entries.map(([key, nested]) => [key, jsonbRoundTrip(nested)]),
  );
}

function releaseRow(
  definition: ThemeDefinition,
  overrides: Record<string, unknown> = {},
) {
  const pkg = themeDefinitionToPackageV2(definition);
  return {
    id: `release-${definition.id}-${definition.release.version}`,
    themeId: definition.id,
    version: definition.release.version,
    releaseStatus: definition.release.status,
    packageJson: jsonbRoundTrip(pkg),
    manifestDigest: digestThemePackage(pkg),
    visibility: definition.catalog.visibility,
    ...overrides,
  };
}

function basketRelease(
  version: string,
  status: ThemeDefinition["release"]["status"] = "published",
): ThemeDefinition {
  const bundled = getThemeDefinition("basket");
  return {
    ...bundled,
    name: `Runtime Basket ${version}`,
    release: {
      ...bundled.release,
      version,
      status,
      releasedAt: status === "published" ? "2026-09-23" : undefined,
    },
  };
}

describe("runtime theme registry", () => {
  beforeEach(() => {
    state.catalogRows = [];
    state.exactRows = [];
    state.insertedValues = [];
  });

  it("keeps every bundled theme when the runtime registry is empty", async () => {
    const catalog = await getThemeCatalog();
    expect(catalog.map((theme) => theme.id)).toEqual([
      "basket",
      "studio",
      "ritual",
      "vitrine",
    ]);
  });

  it("overlays a validated published runtime release in the catalog", async () => {
    const runtime = basketRelease("2.0.0");
    state.catalogRows = [releaseRow(runtime)];

    const catalog = await getThemeCatalog();
    expect(catalog.find((theme) => theme.id === "basket")).toMatchObject({
      name: "Runtime Basket 2.0.0",
      release: { version: "2.0.0", status: "published" },
    });
    expect(catalog).toHaveLength(4);
  });

  it("honors an exact published pin even when the catalog points elsewhere", async () => {
    const pinned = basketRelease("2.0.0");
    state.exactRows = [releaseRow(pinned)];

    await expect(
      resolveThemeDefinition("basket", "2.0.0"),
    ).resolves.toMatchObject({
      name: "Runtime Basket 2.0.0",
      release: { version: "2.0.0" },
    });
  });

  it("fails safe to the bundled release when a database digest is invalid", async () => {
    const runtime = basketRelease("2.0.0");
    state.catalogRows = [
      releaseRow(runtime, { manifestDigest: "0".repeat(64) }),
    ];

    const resolved = await resolveThemeDefinition("basket");
    expect(resolved.release.version).toBe("1.0.0");
    expect(resolved.name).toBe("Basket");
  });

  it("allows exact operator preview of a candidate without exposing it publicly", async () => {
    const candidate = basketRelease("2.1.0", "candidate");
    state.exactRows = [releaseRow(candidate)];

    const preview = await resolveThemeCandidateDefinition("basket", "2.1.0");
    expect(preview).toMatchObject({
      status: "candidate",
      definition: { release: { version: "2.1.0" } },
    });

    const storefront = await resolveThemeDefinition("basket", "2.1.0");
    expect(storefront.release.version).toBe("1.0.0");
  });

  it("validates source provenance before storing an immutable release", async () => {
    const candidate = basketRelease("2.2.0", "candidate");
    const bundledPackage = themeDefinitionToPackageV2(candidate);

    await expect(
      insertThemeRelease({ package: bundledPackage }),
    ).rejects.toThrow(/provenance/i);
    expect(state.insertedValues).toHaveLength(0);

    const generatedPackage = {
      ...bundledPackage,
      assets: bundledPackage.assets.map((asset) => ({
        ...asset,
        source: "licensed" as const,
        sha256: "a".repeat(64),
      })),
      provenance: {
        origin: "generated" as const,
        modelKey: "gemini-3.8-flash" as const,
        promptVersion: "theme-studio-stage-b-v1",
        referenceDigests: [],
      },
    };
    const stored = await insertThemeRelease({ package: generatedPackage });

    expect(stored).toMatchObject({
      inserted: true,
      release: {
        id: "new-release",
        status: "candidate",
        definition: { release: { version: "2.2.0" } },
      },
    });
    expect(state.insertedValues).toHaveLength(1);
  });

  it("accepts a stored package whose keys jsonb has re-ordered", async () => {
    const runtime = basketRelease("2.0.0");
    const pkg = themeDefinitionToPackageV2(runtime);
    const stored = jsonbRoundTrip(pkg) as typeof pkg;
    // The re-ordering is real, not a no-op, for both previously
    // order-sensitive comparisons.
    expect(Object.keys(stored.renderer.viewports)).not.toEqual(
      Object.keys(pkg.renderer.viewports),
    );
    expect(Object.keys(stored.definition.preset.menus)).not.toEqual(
      Object.keys(pkg.definition.preset.menus),
    );
    state.exactRows = [releaseRow(runtime)];
    await expect(
      resolveThemeDefinition("basket", "2.0.0"),
    ).resolves.toMatchObject({ name: "Runtime Basket 2.0.0" });
  });

  it("projects catalog entries without the preset payload", async () => {
    state.catalogRows = [releaseRow(basketRelease("2.0.0"))];
    const basket = (await getThemeCatalog()).find(
      (theme) => theme.id === "basket",
    );
    expect(basket).toBeDefined();
    expect(basket).not.toHaveProperty("preset");
  });

  it("renders an unknown installed id un-themed instead of as the default", async () => {
    await expect(
      resolveInstalledThemeDefinition({ id: "arcade" }),
    ).resolves.toBeNull();
    await expect(resolveInstalledThemeDefinition(null)).resolves.toBeNull();
    await expect(
      resolveInstalledThemeDefinition({ id: "studio" }),
    ).resolves.toMatchObject({ id: "studio" });
    // Install paths keep their default fallback on purpose.
    await expect(resolveThemeDefinition("arcade")).resolves.toMatchObject({
      id: "basket",
    });
  });

  it("renders a Theme Studio preview store from its exact version, and nothing else", async () => {
    const pkg = themeDefinitionToPackageV2(getThemeDefinition("studio"));
    state.exactRows = [
      { packageJson: pkg, packageDigest: digestThemePackage(pkg) },
    ];
    await expect(
      resolveInstalledThemeDefinition({
        id: "whatever",
        studioVersionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toMatchObject({ id: "studio" });

    // A digest that does not match the stored package is not rendered, and
    // there is no fallback to a release or bundled theme with the same id.
    state.exactRows = [{ packageJson: pkg, packageDigest: "0".repeat(64) }];
    await expect(
      resolveInstalledThemeDefinition({
        id: "studio",
        studioVersionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toBeNull();
    state.exactRows = [];
    await expect(
      resolveInstalledThemeDefinition({
        id: "studio",
        studioVersionId: "not-a-uuid",
      }),
    ).resolves.toBeNull();
  });

  it("refuses to activate a release the readers would reject", async () => {
    state.exactRows = [
      releaseRow(basketRelease("2.0.0"), { manifestDigest: "0".repeat(64) }),
    ];
    await expect(
      selectThemeCatalogRelease({
        themeId: "basket",
        version: "2.0.0",
        visibility: "public",
      }),
    ).rejects.toThrow(/failed validation/);
    expect(state.insertedValues).toHaveLength(0);

    state.exactRows = [releaseRow(basketRelease("2.0.0"))];
    await expect(
      selectThemeCatalogRelease({
        themeId: "basket",
        version: "2.0.0",
        visibility: "public",
      }),
    ).resolves.toMatchObject({ releaseId: "release-basket-2.0.0" });
  });

  it("rejects an actor id that is not a platform_admins uuid", async () => {
    state.exactRows = [releaseRow(basketRelease("2.0.0"))];
    await expect(
      selectThemeCatalogRelease({
        themeId: "basket",
        version: "2.0.0",
        visibility: "public",
        actorId: "firebase-uid-abc123",
      }),
    ).rejects.toThrow(/uuid/);
    expect(state.insertedValues).toHaveLength(0);
  });

  it("measures package size the way package_json::text does", () => {
    expect(jsonbTextBytes({ a: 1, b: [1, "x"], c: {} })).toBe(
      '{"a": 1, "b": [1, "x"], "c": {}}'.length,
    );
    expect(jsonbTextBytes({ k: "₹" })).toBe(
      Buffer.byteLength('{"k": "₹"}', "utf8"),
    );
    expect(jsonbTextBytes({ a: undefined, b: null })).toBe(
      '{"b": null}'.length,
    );
  });
});
