import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { collectThemeImageUrls } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_VIEWPORTS,
  type ThemePackageV2,
} from "./contracts";
import {
  gate,
  GATE_LABELS,
  THEME_STUDIO_QA_VIEWPORTS,
  type AcceptanceAssetRow,
  type BrowserEvidence,
  type GateResult,
} from "./acceptance-gates";
import { recordAutomaticAcceptance, renderedPreviewGates } from "./acceptance";
import { themeStudioAcceptanceRuns } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("./acceptance-http", () => ({ fetchInternalPageWithRetry: fetchPage }));
vi.mock("./repository", async (original) => ({
  ...(await original<typeof import("./repository")>()),
  recordThemeStudioEvent: vi.fn(),
}));

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function fixture(): { pkg: ThemePackageV2; rows: AcceptanceAssetRow[] } {
  let theme: ThemeDefinition = structuredClone(THEME_DEFINITIONS[0]);
  const urls = [...collectThemeImageUrls(theme)];
  const slotFor = new Map(urls.map((url, i) => [url, `slot-${i}`]));
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && slotFor.has(value)) {
      return `theme-asset://${slotFor.get(value)}`;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
      );
    }
    return value;
  };
  theme = rewrite(theme) as ThemeDefinition;
  theme.catalog.visibility = "hidden";
  theme.release = { version: "0.0.3", status: "draft", notes: ["Generated."] };
  theme.demo = { slug: theme.demo.slug, status: "unavailable" };
  const assets = urls.map((url, i) => ({
    id: `slot-${i}`,
    path: `theme-asset://slot-${i}`,
    kind: (url === THEME_DEFINITIONS[0].catalog.previewImage
      ? "preview"
      : "content") as "preview" | "content",
    source: "generated" as const,
    sha256: hex(`asset-${i}`),
    width: 1600,
    height: 1200,
    alt: `Generated image ${i}`,
    licenseNote: "Generated for this theme and licensed to StoreMink.",
  }));
  const rows = assets.map((asset, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    purpose: "placeholder",
    mediaType: "image/webp",
    byteSize: 120_000,
    width: 1600,
    height: 1200,
    sha256: asset.sha256,
  }));
  const pkg: ThemePackageV2 = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition: theme,
    renderer: {
      minVersion: theme.engine.version,
      viewports: THEME_STUDIO_VIEWPORTS,
    },
    declaredCapabilities: {
      features: [...theme.catalog.features],
      surfaces: ["home", "shop", "product", "cart"],
    },
    assets,
    provenance: {
      origin: "generated",
      modelKey: "gemini-3.8-flash",
      promptVersion: "theme-studio-v2",
      referenceDigests: [],
    },
    capabilityGaps: [],
  };
  return { pkg, rows };
}

const evidence = (): BrowserEvidence => ({
  userAgent: "Chrome",
  samples: Object.entries(THEME_STUDIO_QA_VIEWPORTS).map(
    ([viewport, dimensions]) => ({
      viewport: viewport as keyof typeof THEME_STUDIO_QA_VIEWPORTS,
      surface: "home",
      path: "/",
      ...dimensions,
      overflowPx: 0,
      overflowOffenders: [],
      clippedText: [],
      smallTapTargets: [],
      imageCropIssues: [],
      brokenImages: 0,
      violations: [],
      lcpMs: 1000,
      cls: 0,
    }),
  ),
});

async function record(
  input: { missingSurface?: boolean; failedRoute?: boolean } = {},
) {
  const { pkg, rows } = fixture();
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table, values });
      },
    }),
  } as unknown as Db;
  const result = await recordAutomaticAcceptance(db, {
    projectId: "project",
    versionId: "final-version",
    packageDigest: "digest",
    pkg,
    actor: { id: "operator", email: "operator@test.dev" },
    buildId: "build",
    sourceVersionId: "captured-version",
    renderedGates: [
      gate(
        "routes.render",
        input.failedRoute
          ? [{ code: "indexable", message: "Missing noindex" }]
          : [],
      ),
      gate("routes.links", []),
      gate("routes.markup", []),
    ],
    evidence: evidence(),
    surfaces: input.missingSurface ? ["home", "product"] : ["home"],
  });
  return {
    result,
    row: writes.find((w) => w.table === themeStudioAcceptanceRuns)!.values,
  };
}

describe("automatic acceptance persistence", () => {
  it("runs every shared gate and binds a completed report to the final catalog version", async () => {
    const { result, row } = await record();
    expect(row).toMatchObject({
      id: result.acceptanceRunId,
      versionId: "final-version",
      packageDigest: "digest",
      buildId: "build",
      status: "passed",
      serverReport: { automatic: true, sourceVersionId: "captured-version" },
    });
    expect(row.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.assetsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.gates.map((g) => g.id).sort()).toEqual(
      Object.keys(GATE_LABELS).sort(),
    );
  });
  it("rejects omitted pages even when every submitted browser sample passes", async () => {
    const { row, result } = await record({ missingSurface: true });
    expect(row.status).toBe("failed");
    expect(result.gates.find((g) => g.id === "browser.coverage")?.status).toBe(
      "fail",
    );
  });
  it("does not allow passing browser measurements to override failed server routes", async () => {
    expect((await record({ failedRoute: true })).row.status).toBe("failed");
  });
});

describe("shared rendered preview checks", () => {
  it("uses the scoped capture cookie and checks noindex, links and markup with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    fetchPage.mockReset().mockImplementation(async ({ path }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        status: path === "/missing" ? 404 : 200,
        error: null,
        headers: { "x-robots-tag": "noindex" },
        body: '<html lang="en"><main class="storefront-root sm-themed-type"><a href="/linked">Link</a></main></html>',
      };
    });
    const cookies = { sm_studio_capture: "scoped-token" };
    const gates: GateResult[] = await renderedPreviewGates({
      origin: "https://studio-preview.storemink.com",
      cookies,
      timeoutMs: 5000,
      pages: [
        { surface: "home", path: "/", label: "Home" },
        { surface: "shop", path: "/shop", label: "Shop" },
        { surface: "product", path: "/products/example", label: "Product" },
        { surface: "not_found", path: "/missing", label: "Missing" },
      ],
    });
    expect(peak).toBe(2);
    expect(gates.every((g) => g.status === "pass")).toBe(true);
    expect(
      fetchPage.mock.calls.every(
        ([args]) => args.cookies === cookies && args.timeoutMs === 5000,
      ),
    ).toBe(true);
    expect(fetchPage.mock.calls.map(([args]) => args.path)).toContain(
      "/linked",
    );
  });
});
