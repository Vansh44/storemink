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
          innerJoin: async () => state.catalogRows,
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
  resolveThemeCandidateDefinition,
  resolveThemeDefinition,
} from "./runtime-registry";

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
    packageJson: pkg,
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
        modelKey: "opus-5" as const,
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
});
