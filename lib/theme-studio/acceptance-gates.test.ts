import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { collectThemeImageUrls } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import {
  acceptanceAssetsDigest,
  acceptanceEvidenceDigest,
  acceptanceOutcome,
  evaluateBrowserGates,
  evaluatePackageGates,
  gate,
  internalLinks,
  linkFindings,
  markupFindings,
  parseBrowserEvidence,
  readAcceptanceReport,
  renderedWithTheme,
  routeRenderFindings,
  securityFindings,
  type AcceptanceAssetRow,
  type AcceptanceSurface,
  type BrowserSample,
  type GateResult,
} from "./acceptance-gates";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_VIEWPORTS,
  type ThemePackageV2,
} from "./contracts";

// A Studio-shaped package built from a bundled theme: every image rewritten to
// a theme-asset:// slot backed by a stored row, release left as a hidden draft.
// It passes every package gate, so each test breaks exactly one thing.
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

function statusOf(gates: GateResult[], id: string) {
  return gates.find((g) => g.id === id)?.status;
}

describe("package gates", () => {
  it("a clean package passes every package gate", () => {
    const { pkg, rows } = fixture();
    const { gates, pkg: parsed } = evaluatePackageGates(pkg, rows);
    expect(parsed).not.toBeNull();
    for (const result of gates) {
      expect(result.findings, result.id).toEqual([]);
      expect(result.status, result.id).toBe("pass");
    }
  });

  it("a contract failure skips everything after it, and skipped fails", () => {
    const { pkg, rows } = fixture();
    const broken = { ...pkg, schemaVersion: 1 };
    const { gates, pkg: parsed } = evaluatePackageGates(broken, rows);
    expect(parsed).toBeNull();
    expect(statusOf(gates, "package.schema")).toBe("fail");
    expect(statusOf(gates, "package.content")).toBe("skipped");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("placeholder imagery fails provenance", () => {
    const { pkg, rows } = fixture();
    pkg.assets[0].licenseNote = PLACEHOLDER_LICENSE_NOTE;
    const { gates } = evaluatePackageGates(pkg, rows);
    expect(statusOf(gates, "assets.provenance")).toBe("fail");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("an asset with no stored bytes, or a reference image, fails integrity", () => {
    const { pkg, rows } = fixture();
    const missing = rows.slice(1);
    missing[0] = { ...missing[0], purpose: "reference" };
    const findings = evaluatePackageGates(pkg, missing).gates.find(
      (g) => g.id === "assets.integrity",
    )!.findings;
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["missing", "purpose"]),
    );
  });

  it("an undersized real image fails integrity; a placeholder is exempt", () => {
    const { pkg, rows } = fixture();
    rows[1] = { ...rows[1], width: 400, height: 300 };
    pkg.assets[1] = { ...pkg.assets[1], width: 400, height: 300 };
    const sized = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.integrity",
    )!;
    expect(sized.findings.map((f) => f.code)).toContain("size");
    pkg.assets[1].licenseNote = PLACEHOLDER_LICENSE_NOTE;
    const exempt = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.integrity",
    )!;
    expect(exempt.findings.map((f) => f.code)).not.toContain("size");
  });

  it("thin content fails the content gate without blocking", () => {
    const { pkg, rows } = fixture();
    pkg.definition.preset.sampleData!.products =
      pkg.definition.preset.sampleData!.products.slice(0, 3);
    const { gates } = evaluatePackageGates(pkg, rows);
    expect(statusOf(gates, "package.content")).toBe("fail");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("a blocking capability gap fails the content gate", () => {
    const { pkg, rows } = fixture();
    pkg.capabilityGaps = [
      {
        code: "unsupported_section",
        requestedCapability: "3D product viewer",
        fallback: "Use a gallery.",
        blocking: true,
      } as never,
    ];
    const content = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "package.content",
    );
    // The contract may reject the gap shape first; either way it cannot pass.
    expect(content?.status).not.toBe("pass");
  });
});

describe("security scan", () => {
  it("is clean for a clean package", () => {
    expect(securityFindings(fixture().pkg)).toEqual([]);
  });

  it("finds script tags, handlers and javascript: links in copy", () => {
    const { pkg } = fixture();
    pkg.definition.description =
      'Lovely <img src=x onerror="alert(1)"> and <script>steal()</script>';
    pkg.definition.preset.menus.header.push({
      label: "Hi",
      href: "javascript:alert(1)",
    } as never);
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["markup", "handler", "scheme", "external_link"]),
    );
  });

  it("finds an off-site image and a CSS escape in a design token", () => {
    const { pkg } = fixture();
    pkg.definition.preset.sampleData!.products[0].image_url =
      "https://evil.example/x.jpg";
    pkg.definition.preset.design.shape.card = "4px; background:url(x)";
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["external_asset", "css"]));
  });

  it("finds an unregistered capability and custom code", () => {
    const { pkg } = fixture();
    pkg.declaredCapabilities.features = [];
    const page = pkg.definition.preset.pages[0];
    page.sections.push({
      ...page.sections[0],
      id: "x",
      type: "custom_code",
    } as never);
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["capability", "custom_code"]),
    );
  });

  it("a security failure BLOCKS rather than fails", () => {
    const gates = [
      gate("package.schema", []),
      gate("package.security", [{ code: "markup", message: "x" }]),
    ];
    expect(acceptanceOutcome(gates)).toBe("blocked");
  });

  it("ordinary copy mentioning words like online is not a handler", () => {
    const { pkg } = fixture();
    pkg.definition.description =
      "Shop online = easy. Order online today and pick up in store, anytime.";
    expect(securityFindings(pkg)).toEqual([]);
  });
});

describe("digests", () => {
  it("the assets digest moves when the backing bytes change", () => {
    const { pkg, rows } = fixture();
    const before = acceptanceAssetsDigest(pkg, rows);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(acceptanceAssetsDigest(pkg, [...rows].reverse())).toBe(before);
    const changed = rows.map((row, i) =>
      i === 0 ? { ...row, byteSize: 1 } : row,
    );
    expect(acceptanceAssetsDigest(pkg, changed)).not.toBe(before);
    const repointed = structuredClone(pkg);
    repointed.assets[0].sha256 = hex("other");
    expect(acceptanceAssetsDigest(repointed, rows)).not.toBe(before);
  });

  it("the evidence digest binds the inputs and every gate", () => {
    const binding = {
      runId: "r",
      versionId: "v",
      packageDigest: hex("p"),
      assetsDigest: hex("a"),
      buildId: "b1",
    };
    const gates = [gate("package.schema", [])];
    const base = acceptanceEvidenceDigest(binding, gates);
    expect(
      acceptanceEvidenceDigest({ ...binding, buildId: "b2" }, gates),
    ).not.toBe(base);
    expect(
      acceptanceEvidenceDigest(binding, [
        gate("package.schema", [{ code: "x", message: "y" }]),
      ]),
    ).not.toBe(base);
  });
});

describe("rendered routes", () => {
  it("recognises the themed root in HTML and in an escaped RSC payload", () => {
    expect(
      renderedWithTheme(
        '<div class="storefront-root sm-header-classic sm-themed-type sm-pdp-classic">',
      ),
    ).toBe(true);
    expect(
      renderedWithTheme(
        '["$","div",null,{\\"className\\":\\"storefront-root sm-header-classic sm-themed-type\\"}]',
      ),
    ).toBe(true);
    expect(
      renderedWithTheme('<div class="storefront-root sm-header-classic">'),
    ).toBe(false);
    // The two tokens in DIFFERENT class lists do not count.
    expect(
      renderedWithTheme(
        '<div class="storefront-root"></div><p class="sm-themed-type">',
      ),
    ).toBe(false);
  });

  it("does not hold Next's minimal error document to the lang rule", () => {
    expect(
      markupFindings(
        [
          {
            path: "/missing",
            html: '<!DOCTYPE html><html id="__next_error__"><body></body></html>',
          },
        ],
        "https://x.example",
      ),
    ).toEqual([]);
  });

  it("expects 200 for surfaces, 404 for the missing page, themed and noindex", () => {
    const ok = (surface: AcceptanceSurface, status: number) => ({
      surface,
      path: `/${surface}`,
      status,
      themed: true,
      noindex: true,
      error: null,
    });
    expect(
      routeRenderFindings([ok("home", 200), ok("not_found", 404)]),
    ).toEqual([]);
    const findings = routeRenderFindings([
      ok("home", 500),
      ok("not_found", 200),
      { ...ok("shop", 200), themed: false },
      { ...ok("cart", 200), noindex: false },
      { ...ok("content", 200), status: null, error: "timeout" },
    ]);
    expect(findings.map((f) => f.code)).toEqual([
      "status",
      "status",
      "unthemed",
      "indexable",
      "fetch",
    ]);
  });

  it("broken links are 4xx/5xx, redirects are fine", () => {
    expect(
      linkFindings([
        { path: "/a", status: 200, error: null },
        { path: "/b", status: 307, error: null },
        { path: "/c", status: 404, error: null },
        { path: "/d", status: null, error: "timeout" },
      ]).map((f) => f.where),
    ).toEqual(["/c", "/d"]);
  });

  it("extracts only same-origin page links", () => {
    const html =
      '<a href="/shop">x</a><a href="/shop#top">y</a><a href="https://x.com">z</a>' +
      '<a href="//evil.example">e</a><a href="/api/x">a</a><a href="/_next/y">n</a>' +
      "<a href='/our-story'>s</a>";
    expect(internalLinks(html).sort()).toEqual(["/our-story", "/shop"]);
  });

  it("markup: foreign resources, missing alt and missing lang", () => {
    const origin = "https://studio-preview-abc.storemink.com";
    const clean =
      '<html lang="en"><img src="/_next/image?url=%2Fa" alt="">' +
      `<script src="/_next/static/x.js"></script><img src="${origin}/x.webp" alt="x">` +
      '<img src="data:image/gif;base64,AA" alt=""></html>';
    expect(markupFindings([{ path: "/", html: clean }], origin)).toEqual([]);
    const bad =
      '<html><img src="https://cdn.evil.example/p.jpg"><script src="https://t.example/a.js"></script></html>';
    expect(
      markupFindings([{ path: "/", html: bad }], origin).map((f) => f.code),
    ).toEqual(["external_resource", "external_resource", "img_alt", "lang"]);
  });
});

function sample(overrides: Partial<BrowserSample> = {}): BrowserSample {
  return {
    viewport: "desktop",
    surface: "home",
    path: "/",
    width: 1440,
    height: 900,
    overflowPx: 0,
    overflowOffenders: [],
    brokenImages: 0,
    violations: [],
    lcpMs: 900,
    cls: 0.01,
    ...overrides,
  };
}

function fullCoverage(surfaces: AcceptanceSurface[]): BrowserSample[] {
  return (["desktop", "tablet", "mobile"] as const).flatMap((viewport) =>
    surfaces.map((surface) =>
      sample({
        viewport,
        surface,
        width: THEME_STUDIO_VIEWPORTS[viewport].width,
      }),
    ),
  );
}

describe("browser evidence", () => {
  it("parses a well-formed report and refuses malformed ones", () => {
    const good = parseBrowserEvidence({
      userAgent: "Chrome",
      samples: [sample()],
    });
    expect(good.ok).toBe(true);
    for (const bad of [
      null,
      { samples: [] },
      { samples: [{ ...sample(), viewport: "watch" }] },
      { samples: [{ ...sample(), overflowPx: "0" }] },
      { samples: [{ ...sample(), violations: undefined }] },
      { samples: [{ ...sample(), violations: [{ id: "", nodes: 1 }] }] },
      { samples: Array.from({ length: 19 }, () => sample()) },
    ]) {
      expect(parseBrowserEvidence(bad).ok).toBe(false);
    }
  });

  it("drops a client verdict and unknown impacts rather than trusting them", () => {
    const parsed = parseBrowserEvidence({
      samples: [
        {
          ...sample(),
          passed: true,
          violations: [{ id: "x", nodes: 1, impact: "catastrophic" }],
        },
      ],
    });
    expect(
      parsed.ok && parsed.value.samples[0].violations[0].impact,
    ).toBeNull();
    expect(parsed.ok && "passed" in parsed.value.samples[0]).toBe(false);
  });

  it("full clean coverage passes", () => {
    const surfaces: AcceptanceSurface[] = ["home", "shop", "not_found"];
    const gates = evaluateBrowserGates(
      { userAgent: "x", samples: fullCoverage(surfaces) },
      surfaces,
    );
    expect(acceptanceOutcome(gates)).toBe("pass");
  });

  it("a missing surface or a wrong viewport width fails coverage", () => {
    const surfaces: AcceptanceSurface[] = ["home", "shop"];
    const samples = fullCoverage(surfaces).slice(1);
    samples[0] = { ...samples[0], width: 1000 };
    const coverage = evaluateBrowserGates(
      { userAgent: "", samples },
      surfaces,
    )[0];
    expect(coverage.status).toBe("fail");
    expect(coverage.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["missing", "viewport"]),
    );
  });

  it("overflow, serious axe violations and broken images fail; minor ones and slow LCP do not", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[2] = {
      ...samples[2],
      overflowPx: 24,
      overflowOffenders: ["div.hero"],
      brokenImages: 1,
      violations: [
        { id: "color-contrast", impact: "serious", nodes: 3, help: "Contrast" },
      ],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(gates, "browser.overflow")).toBe("fail");
    expect(statusOf(gates, "browser.accessibility")).toBe("fail");
    expect(statusOf(gates, "browser.media")).toBe("fail");

    const soft = fullCoverage(surfaces);
    soft[0] = {
      ...soft[0],
      lcpMs: 9000,
      cls: 0.5,
      violations: [
        { id: "region", impact: "moderate", nodes: 1, help: "Region" },
      ],
    };
    const softGates = evaluateBrowserGates(
      { userAgent: "", samples: soft },
      surfaces,
    );
    expect(statusOf(softGates, "browser.accessibility")).toBe("pass");
    expect(
      softGates.find((g) => g.id === "browser.accessibility")!.findings,
    ).toHaveLength(1);
    expect(statusOf(softGates, "browser.performance")).toBe("advisory");
    expect(acceptanceOutcome(softGates)).toBe("pass");
  });
});

describe("stored reports", () => {
  it("reads back only recognised gates", () => {
    const report = readAcceptanceReport({
      gates: [gate("package.schema", []), { id: "nope", findings: [] }, "x"],
      surfaces: ["home", "attic"],
    });
    expect(report.gates.map((g) => g.id)).toEqual(["package.schema"]);
    expect(report.surfaces).toEqual(["home"]);
    expect(readAcceptanceReport(null).gates).toEqual([]);
  });
});
