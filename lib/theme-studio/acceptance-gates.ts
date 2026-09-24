import { createHash } from "node:crypto";
import {
  collectThemeImageUrls,
  validateThemeCatalogMeta,
  validateThemeDesign,
  validateThemeHomepage,
  validateThemeImage,
  validateThemeLinks,
  validateThemePages,
  validateThemeSampleData,
  type ThemeFinding,
} from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import { PLACEHOLDER_LICENSE_NOTE, THEME_ASSET_PREFIX } from "./compiler";
import {
  THEME_STUDIO_VIEWPORTS,
  canonicalJson,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";

// ---------------------------------------------------------------------------
// Theme Studio automated acceptance: the gates, as pure functions.
//
// A generated version must clear these before it can be presented for human
// approval. The orchestration (reading rows, building the preview, fetching
// rendered pages, recording evidence) lives in acceptance.ts; everything that
// DECIDES lives here, so every rule is unit-tested without a database or a
// browser.
//
// ★ A GATE IS REQUIRED OR ADVISORY, NEVER "PASS WITH A WARNING". The plan is
// explicit that failure keeps a version out of review rather than publishing
// with a note. The only advisory gate is performance, and only because it is
// measured on whatever machine the operator happens to use, which is not the
// production-build Lighthouse run the thresholds were written for.
//
// ★ SECURITY FAILURES BLOCK; QUALITY FAILURES DO NOT. A version that carries
// a script or an off-site asset is not something to iterate on, so the
// project moves to `blocked`. A version with a thin catalogue or a contrast
// problem stays `ready` and is fixed by a revision.
//
// ★ EVIDENCE IS DERIVED FROM RAW MEASUREMENTS HERE, NEVER FROM A CLIENT'S
// VERDICT. The operator's browser reports what it measured — overflow in
// pixels, axe violations with impact, broken images — and the thresholds are
// applied on the server. A client that says "passed" is ignored.
// ---------------------------------------------------------------------------

export const ACCEPTANCE_REPORT_VERSION = 1;

export type GateStatus = "pass" | "fail" | "advisory" | "skipped";

export type GateId =
  | "package.schema"
  | "package.content"
  | "package.design"
  | "package.security"
  | "assets.integrity"
  | "assets.provenance"
  | "demo.materialize"
  | "routes.render"
  | "routes.links"
  | "routes.markup"
  | "browser.coverage"
  | "browser.overflow"
  | "browser.accessibility"
  | "browser.media"
  | "browser.performance";

export interface GateFinding {
  code: string;
  message: string;
  where?: string;
}

export interface GateResult {
  id: GateId;
  label: string;
  required: boolean;
  status: GateStatus;
  findings: GateFinding[];
  metrics?: Record<string, number | string | null>;
}

export const GATE_LABELS: Record<GateId, string> = {
  "package.schema": "Package contract",
  "package.content": "Pages, catalogue and links",
  "package.design": "Design system and contrast",
  "package.security": "Security scan",
  "assets.integrity": "Asset integrity",
  "assets.provenance": "Asset provenance",
  "demo.materialize": "Demo materialization",
  "routes.render": "Storefront routes",
  "routes.links": "Navigation links",
  "routes.markup": "Rendered markup",
  "browser.coverage": "Browser coverage",
  "browser.overflow": "Responsive layout",
  "browser.accessibility": "Accessibility (axe)",
  "browser.media": "Media loading",
  "browser.performance": "Performance (advisory)",
};

/** Findings per gate are capped: a reviewer needs the pattern, not 400 rows. */
const MAX_FINDINGS = 40;

export function gate(
  id: GateId,
  findings: GateFinding[],
  options: {
    required?: boolean;
    status?: GateStatus;
    metrics?: GateResult["metrics"];
  } = {},
): GateResult {
  const required = options.required ?? true;
  const status =
    options.status ??
    (findings.length === 0 ? "pass" : required ? "fail" : "advisory");
  return {
    id,
    label: GATE_LABELS[id],
    required,
    status,
    findings: findings.slice(0, MAX_FINDINGS),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  };
}

function skipped(id: GateId, reason: string): GateResult {
  return gate(id, [{ code: "skipped", message: reason }], {
    status: "skipped",
  });
}

function fromThemeFindings(findings: ThemeFinding[]): GateFinding[] {
  return findings.map((f) => ({
    code: `${f.area}.${f.code}`,
    message: f.message,
  }));
}

// ------------------------------------------------------------ digests

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A stored asset row, as much of it as the gates read. */
export interface AcceptanceAssetRow {
  id: string;
  purpose: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

/**
 * The content address of every asset a package renders: each declared asset
 * paired with the stored row that backs it. Rows are immutable, so this moves
 * only when the package points at different bytes — which is exactly when
 * earlier evidence stops describing what would be shown.
 */
export function acceptanceAssetsDigest(
  pkg: ThemePackageV2,
  rows: readonly AcceptanceAssetRow[],
): string {
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const entries = [...pkg.assets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((asset) => {
      const row = asset.sha256 ? bySha.get(asset.sha256) : undefined;
      return {
        asset: asset.id,
        sha256: asset.sha256,
        row: row
          ? {
              id: row.id,
              purpose: row.purpose,
              mediaType: row.mediaType,
              bytes: row.byteSize,
              width: row.width,
              height: row.height,
            }
          : null,
      };
    });
  return sha256Hex(canonicalJson(entries));
}

export interface EvidenceBinding {
  runId: string;
  versionId: string;
  packageDigest: string;
  assetsDigest: string;
  buildId: string;
}

/** The digest a finished run is recorded under: its inputs and every gate. */
export function acceptanceEvidenceDigest(
  binding: EvidenceBinding,
  gates: readonly GateResult[],
): string {
  return sha256Hex(
    canonicalJson({ version: ACCEPTANCE_REPORT_VERSION, binding, gates }),
  );
}

// ------------------------------------------------------------ package gates

const SCRIPT_RE =
  /<\s*\/?\s*(script|iframe|object|embed|frame|style|link|meta|base)\b/i;
const HANDLER_RE = /\bon[a-z]{3,}\s*=/i;
const SCRIPT_SCHEME_RE = /\b(?:javascript|vbscript)\s*:/i;
const URL_KEY_RE = /(?:^|_)(?:url|src|image|poster)$/i;

/** Keys whose string values are rendered as a media source. */
function isAssetKey(key: string): boolean {
  return URL_KEY_RE.test(key) || key === "images" || key === "previewImage";
}
const HREF_KEY_RE = /(?:^|_)href$/i;
const CSS_ESCAPE_RE = /(?:expression\s*\(|url\s*\(|@import|behavior\s*:)/i;

/** Walk every string in a JSON value with the key path that holds it. */
function walkStrings(
  value: unknown,
  visit: (text: string, key: string, path: string) => void,
  key = "",
  path = "",
): void {
  if (typeof value === "string") {
    visit(value, key, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkStrings(item, visit, key, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, nested] of Object.entries(value)) {
      walkStrings(nested, visit, k, path ? `${path}.${k}` : k);
    }
  }
}

/** A link a generated theme may carry: same-site paths and in-page anchors. */
function isSafeHref(href: string): boolean {
  if (href === "") return true;
  if (href.startsWith("#")) return true;
  return /^\/(?![/\\])[^\s\\]*$/.test(href);
}

/**
 * Plan §7.2 item 9: no scripts, event handlers, external asset URLs, unknown
 * CSS values or unregistered capabilities reached the package. Deliberately
 * independent of the compiler that should already have refused all of this —
 * a gate that trusts the thing it checks is not a gate.
 */
export function securityFindings(pkg: ThemePackageV2): GateFinding[] {
  const findings: GateFinding[] = [];
  const add = (code: string, message: string, where: string) =>
    findings.push({ code, message, where });

  walkStrings(pkg.definition, (text, key, path) => {
    const htmlish = text.includes("<");
    if (SCRIPT_RE.test(text)) {
      add("markup", "Contains an executable or document-level HTML tag.", path);
    }
    if (htmlish && HANDLER_RE.test(text)) {
      add("handler", "Contains an inline event handler.", path);
    }
    const linkish = isAssetKey(key) || HREF_KEY_RE.test(key);
    if (
      (SCRIPT_SCHEME_RE.test(text) &&
        (linkish || htmlish || text.includes("="))) ||
      (linkish && /^\s*data\s*:/i.test(text))
    ) {
      add("scheme", "Contains a javascript:, vbscript: or data: URL.", path);
    }
    if (isAssetKey(key) && text && !text.startsWith(THEME_ASSET_PREFIX)) {
      add(
        "external_asset",
        "An image or media field points outside the package's own assets.",
        path,
      );
    }
    if (HREF_KEY_RE.test(key) && !isSafeHref(text)) {
      add("external_link", "A link leaves the storefront.", path);
    }
  });

  // Design tokens reach an inline style attribute, so anything beyond a plain
  // colour, length or font variable is refused here as well as upstream.
  walkStrings(pkg.definition.preset.design, (text, _key, path) => {
    if (CSS_ESCAPE_RE.test(text) || /[;{}<>]/.test(text)) {
      add(
        "css",
        "A design token is not a plain CSS value.",
        `preset.design.${path}`,
      );
    }
  });

  for (const page of pkg.definition.preset.pages) {
    for (const section of page.sections) {
      if (section.type === "custom_code") {
        add(
          "custom_code",
          "Generated themes may not contain custom code.",
          `${page.slug || "(home)"}/${section.id}`,
        );
      }
    }
  }

  const declared = new Set(pkg.declaredCapabilities.features);
  for (const feature of pkg.definition.catalog.features) {
    if (!declared.has(feature)) {
      add(
        "capability",
        `The catalog claims "${feature}" but the package never declared it.`,
        "definition.catalog.features",
      );
    }
  }
  return findings;
}

/** Media types a storefront asset may be stored as. */
const STOREFRONT_MEDIA_TYPES = new Set(["image/webp", "image/avif"]);
/** Asset purposes whose bytes may render on a storefront. Reference images are
 * the operator's inspiration and are never licensed for publication. */
const RENDERABLE_PURPOSES = new Set(["placeholder", "image"]);

export function isPlaceholderAsset(
  asset: ThemePackageV2["assets"][number],
): boolean {
  return asset.licenseNote === PLACEHOLDER_LICENSE_NOTE;
}

/** Every declared asset resolves to a stored row with the same bytes. */
export function assetIntegrityFindings(
  pkg: ThemePackageV2,
  rows: readonly AcceptanceAssetRow[],
): GateFinding[] {
  const findings: GateFinding[] = [];
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const referenced = collectThemeImageUrls(pkg.definition);
  for (const asset of pkg.assets) {
    const where = asset.id;
    if (!asset.sha256) {
      findings.push({
        code: "digest",
        message: "The asset has no content digest.",
        where,
      });
      continue;
    }
    const row = bySha.get(asset.sha256);
    if (!row) {
      findings.push({
        code: "missing",
        message: "No stored image matches the asset's digest.",
        where,
      });
      continue;
    }
    if (!RENDERABLE_PURPOSES.has(row.purpose)) {
      findings.push({
        code: "purpose",
        message: `A ${row.purpose} image cannot be rendered on a storefront.`,
        where,
      });
    }
    if (!STOREFRONT_MEDIA_TYPES.has(row.mediaType)) {
      findings.push({
        code: "format",
        message: `Stored as ${row.mediaType}.`,
        where,
      });
    }
    if (
      (asset.width !== null && asset.width !== row.width) ||
      (asset.height !== null && asset.height !== row.height)
    ) {
      findings.push({
        code: "dimensions",
        message: "The declared dimensions do not match the stored image.",
        where,
      });
    }
    // Placeholders are tiny solid images by design and are refused by
    // provenance; production sizing applies to real imagery only.
    if (!isPlaceholderAsset(asset)) {
      for (const message of validateThemeImage(
        asset.id,
        {
          format: row.mediaType.replace("image/", ""),
          width: row.width,
          height: row.height,
          bytes: row.byteSize,
        },
        { preview: asset.path === pkg.definition.catalog.previewImage },
      )) {
        findings.push({ code: "size", message, where });
      }
    }
    if (!referenced.has(asset.path) && asset.kind !== "reference") {
      findings.push({
        code: "unused",
        message: "The asset is declared but nothing renders it.",
        where,
      });
    }
  }
  return findings;
}

/** Every rendered asset must be publishable: no placeholders, alt text, and
 * a source this platform can stand behind. */
export function assetProvenanceFindings(pkg: ThemePackageV2): GateFinding[] {
  const findings: GateFinding[] = [];
  const placeholders = pkg.assets.filter(isPlaceholderAsset);
  if (placeholders.length > 0) {
    findings.push({
      code: "placeholder",
      message: `${placeholders.length} image slot${placeholders.length === 1 ? " is" : "s are"} still a StoreMink placeholder. Replace them with operator-owned, licensed or generated imagery before this version can be reviewed.`,
      where: placeholders
        .map((a) => a.id)
        .slice(0, 12)
        .join(", "),
    });
  }
  for (const asset of pkg.assets) {
    if (asset.alt.trim().length < 3) {
      findings.push({
        code: "alt",
        message: "The asset has no alt text.",
        where: asset.id,
      });
    }
    if (asset.source === "legacy-bundled") {
      findings.push({
        code: "source",
        message: "A generated theme cannot ship bundled legacy imagery.",
        where: asset.id,
      });
    }
    if (
      (asset.source === "licensed" || asset.source === "operator-owned") &&
      !asset.licenseNote?.trim()
    ) {
      findings.push({
        code: "license",
        message: "Licensed or operator-owned imagery needs a licence note.",
        where: asset.id,
      });
    }
  }
  return findings;
}

/**
 * The package-level gates (plan §7.2 items 1, 2 and 9). The schema gate runs
 * the full ThemePackageV2 contract again: a stored version was valid when it
 * was written, and this proves it is still valid under today's rules.
 */
export function evaluatePackageGates(
  packageJson: unknown,
  rows: readonly AcceptanceAssetRow[],
): { gates: GateResult[]; pkg: ThemePackageV2 | null } {
  const parsed = validateThemePackageV2(packageJson);
  if (!parsed.ok) {
    const reason =
      "The package contract failed, so nothing else can be checked.";
    return {
      pkg: null,
      gates: [
        gate(
          "package.schema",
          parsed.issues.map((message) => ({ code: "contract", message })),
        ),
        skipped("package.content", reason),
        skipped("package.design", reason),
        skipped("package.security", reason),
        skipped("assets.integrity", reason),
        skipped("assets.provenance", reason),
      ],
    };
  }
  const pkg = parsed.value;
  const theme: ThemeDefinition = pkg.definition;
  return {
    pkg,
    gates: [
      gate("package.schema", []),
      gate(
        "package.content",
        fromThemeFindings([
          ...validateThemeCatalogMeta(theme, { bundledAssets: false }),
          ...validateThemePages(theme),
          ...validateThemeHomepage(theme),
          ...validateThemeSampleData(theme),
          ...validateThemeLinks(theme),
        ]).concat(
          pkg.capabilityGaps
            .filter((gap) => gap.blocking)
            .map((gap) => ({
              code: "capability_gap",
              message: `A blocking capability gap remains: ${gap.requestedCapability}.`,
            })),
        ),
      ),
      gate("package.design", fromThemeFindings(validateThemeDesign(theme))),
      gate("package.security", securityFindings(pkg)),
      gate("assets.integrity", assetIntegrityFindings(pkg, rows)),
      gate("assets.provenance", assetProvenanceFindings(pkg)),
    ],
  };
}

// ------------------------------------------------------------ rendered routes

export type AcceptanceSurface =
  | "home"
  | "shop"
  | "product"
  | "cart"
  | "content"
  | "not_found";

export interface RouteFetchResult {
  surface: AcceptanceSurface;
  path: string;
  status: number | null;
  /** Whether the page rendered with the theme's design applied. */
  themed: boolean;
  noindex: boolean;
  error: string | null;
}

/** Plan §7.2 item 4: the five surfaces render themed, the missing route is a
 * real (themed) 404, and every one of them tells crawlers to stay away. */
export function routeRenderFindings(
  routes: readonly RouteFetchResult[],
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const route of routes) {
    const expected = route.surface === "not_found" ? 404 : 200;
    if (route.error) {
      findings.push({ code: "fetch", message: route.error, where: route.path });
      continue;
    }
    if (route.status !== expected) {
      findings.push({
        code: "status",
        message: `Returned ${route.status ?? "no response"}, expected ${expected}.`,
        where: route.path,
      });
      continue;
    }
    if (!route.themed) {
      findings.push({
        code: "unthemed",
        message: "Rendered without the theme's design.",
        where: route.path,
      });
    }
    if (!route.noindex) {
      findings.push({
        code: "indexable",
        message: "A preview page did not carry noindex.",
        where: route.path,
      });
    }
  }
  return findings;
}

/**
 * Whether a rendered page carries the theme's root classes. The class list is
 * matched as ONE contiguous string, either in the HTML attribute or inside the
 * streamed RSC payload: a not-found page can arrive as Next's minimal error
 * document with the real tree in the payload, and it is still the themed
 * storefront 404 once rendered.
 */
export function renderedWithTheme(html: string): boolean {
  return /storefront-root\b[^"\\<>]*\bsm-themed-type\b/.test(html);
}

export interface LinkCheckResult {
  path: string;
  status: number | null;
  error: string | null;
}

export function linkFindings(links: readonly LinkCheckResult[]): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const link of links) {
    if (link.error) {
      findings.push({ code: "fetch", message: link.error, where: link.path });
    } else if (link.status === null || link.status >= 400) {
      findings.push({
        code: "broken",
        message: `Returned ${link.status ?? "no response"}.`,
        where: link.path,
      });
    }
  }
  return findings;
}

/** Attribute values of every occurrence of `attr` on `tag` elements. */
function attributeValues(html: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const tagRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const attrRe = new RegExp(
    `\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  for (const match of html.matchAll(tagRe)) {
    const found = match[0].match(attrRe);
    if (found) out.push(found[2] ?? found[3] ?? found[4] ?? "");
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/g, '"');
}

/** A resource URL counts as first-party when it is relative, or absolute on
 * the page's own origin. */
function isFirstParty(url: string, origin: string): boolean {
  const value = decodeEntities(url.trim());
  if (value === "" || value.startsWith("#")) return true;
  // An inline image costs no request and reveals nothing to anyone.
  if (/^data:image\//i.test(value)) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

/** Same-origin page links worth crawling, from one rendered page. */
export function internalLinks(html: string): string[] {
  const links = new Set<string>();
  for (const raw of attributeValues(html, "a", "href")) {
    const href = decodeEntities(raw.trim());
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    if (href.startsWith("/api/") || href.startsWith("/_next/")) continue;
    const path = href.split("#")[0];
    if (path) links.add(path);
  }
  return [...links];
}

/**
 * Static checks on rendered HTML: nothing loads from another origin, and every
 * image says what it is (an empty alt is a deliberate "decorative", a missing
 * one is a defect). The browser stage runs axe over the live page; this is the
 * part that needs no browser.
 */
export function markupFindings(
  pages: readonly { path: string; html: string }[],
  origin: string,
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const { path, html } of pages) {
    const resources = [
      ...attributeValues(html, "img", "src"),
      ...attributeValues(html, "script", "src"),
      ...attributeValues(html, "iframe", "src"),
      ...attributeValues(html, "source", "src"),
      ...attributeValues(html, "video", "src"),
      ...attributeValues(html, "video", "poster"),
    ];
    const foreign = resources.filter(
      (url) => url && !isFirstParty(url, origin),
    );
    for (const url of [...new Set(foreign)].slice(0, 5)) {
      findings.push({
        code: "external_resource",
        message: `Loads ${url.slice(0, 120)} from another origin.`,
        where: path,
      });
    }
    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
      if (!/\salt\s*=/i.test(tag)) {
        findings.push({
          code: "img_alt",
          message: "An image has no alt attribute.",
          where: path,
        });
        break;
      }
    }
    // Next's minimal error document (a not-found page's first paint) has no
    // lang until the payload renders; the browser stage's axe run checks the
    // rendered page, so only a full document is held to it here.
    const errorShell = /<html\b[^>]*\bid="__next_error__"/.test(html);
    if (!errorShell && !/<html\b[^>]*\slang\s*=\s*["']?[a-z]/i.test(html)) {
      findings.push({
        code: "lang",
        message: "The page has no language.",
        where: path,
      });
    }
  }
  return findings;
}

// ------------------------------------------------------------ browser stage

export type AcceptanceViewport = keyof typeof THEME_STUDIO_VIEWPORTS;
export const ACCEPTANCE_VIEWPORTS = Object.keys(
  THEME_STUDIO_VIEWPORTS,
) as AcceptanceViewport[];

export const AXE_IMPACTS = [
  "minor",
  "moderate",
  "serious",
  "critical",
] as const;
export type AxeImpact = (typeof AXE_IMPACTS)[number];
/** axe violations at these impacts fail the gate; lower ones are listed. */
const BLOCKING_IMPACTS = new Set<AxeImpact>(["serious", "critical"]);

export interface BrowserSample {
  viewport: AcceptanceViewport;
  surface: AcceptanceSurface;
  path: string;
  width: number;
  height: number;
  overflowPx: number;
  overflowOffenders: string[];
  brokenImages: number;
  violations: {
    id: string;
    impact: AxeImpact | null;
    nodes: number;
    help: string;
    /** The first offending element's selector, when the browser gave one. */
    target?: string;
  }[];
  lcpMs: number | null;
  cls: number | null;
}

export interface BrowserEvidence {
  userAgent: string;
  samples: BrowserSample[];
}

const SURFACES: readonly AcceptanceSurface[] = [
  "home",
  "shop",
  "product",
  "cart",
  "content",
  "not_found",
];

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/**
 * Strictly parse what the operator's browser sent. Anything malformed is
 * refused outright rather than repaired: a missing measurement must never be
 * read as a clean one.
 */
export function parseBrowserEvidence(
  raw: unknown,
): { ok: true; value: BrowserEvidence } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "The browser report is not an object." };
  }
  const input = raw as Record<string, unknown>;
  const userAgent = str(input.userAgent, 300) ?? "";
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    return { ok: false, error: "The browser report has no samples." };
  }
  if (input.samples.length > ACCEPTANCE_VIEWPORTS.length * SURFACES.length) {
    return { ok: false, error: "The browser report has too many samples." };
  }
  const samples: BrowserSample[] = [];
  for (const [index, item] of input.samples.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `Sample ${index} is not an object.` };
    }
    const s = item as Record<string, unknown>;
    const viewport = s.viewport as AcceptanceViewport;
    const surface = s.surface as AcceptanceSurface;
    if (
      !ACCEPTANCE_VIEWPORTS.includes(viewport) ||
      !SURFACES.includes(surface)
    ) {
      return {
        ok: false,
        error: `Sample ${index} names an unknown viewport or surface.`,
      };
    }
    const width = finiteNumber(s.width, 1, 10_000);
    const height = finiteNumber(s.height, 1, 10_000);
    const overflowPx = finiteNumber(s.overflowPx, -100_000, 100_000);
    const brokenImages = finiteNumber(s.brokenImages, 0, 10_000);
    if (
      width === null ||
      height === null ||
      overflowPx === null ||
      brokenImages === null
    ) {
      return { ok: false, error: `Sample ${index} is missing a measurement.` };
    }
    if (!Array.isArray(s.violations) || s.violations.length > 100) {
      return {
        ok: false,
        error: `Sample ${index} has no accessibility result.`,
      };
    }
    const violations: BrowserSample["violations"] = [];
    for (const v of s.violations) {
      if (!v || typeof v !== "object") {
        return {
          ok: false,
          error: `Sample ${index} has a malformed violation.`,
        };
      }
      const record = v as Record<string, unknown>;
      const id = str(record.id, 80);
      const nodes = finiteNumber(record.nodes, 0, 100_000);
      if (!id || nodes === null) {
        return {
          ok: false,
          error: `Sample ${index} has a malformed violation.`,
        };
      }
      const impact = AXE_IMPACTS.includes(record.impact as AxeImpact)
        ? (record.impact as AxeImpact)
        : null;
      const target = str(record.target, 120);
      violations.push({
        id,
        impact,
        nodes,
        help: str(record.help, 200) ?? "",
        ...(target ? { target } : {}),
      });
    }
    const offenders = Array.isArray(s.overflowOffenders)
      ? s.overflowOffenders
          .slice(0, 5)
          .map((o) => str(o, 120))
          .filter((o): o is string => o !== null)
      : [];
    samples.push({
      viewport,
      surface,
      path: str(s.path, 512) ?? "",
      width,
      height,
      overflowPx,
      overflowOffenders: offenders,
      brokenImages,
      violations,
      lcpMs: finiteNumber(s.lcpMs, 0, 600_000),
      cls: finiteNumber(s.cls, 0, 1_000),
    });
  }
  return { ok: true, value: { userAgent, samples } };
}

/** Plan thresholds, applied to operator-machine measurements as advisory. */
export const PERFORMANCE_THRESHOLDS = { lcpMs: 2500, cls: 0.1 } as const;

/**
 * Plan §7.2 items 5–7 as far as a browser can measure them: every surface at
 * every viewport, no horizontal overflow, no serious or critical axe
 * violation, no broken image. The expected surfaces come from the SERVER's
 * record of the run, so a report that silently skips a page fails coverage.
 */
export function evaluateBrowserGates(
  evidence: BrowserEvidence,
  expectedSurfaces: readonly AcceptanceSurface[],
): GateResult[] {
  const coverage: GateFinding[] = [];
  const bySample = new Map<string, BrowserSample>();
  for (const sample of evidence.samples) {
    bySample.set(`${sample.viewport}:${sample.surface}`, sample);
  }
  for (const viewport of ACCEPTANCE_VIEWPORTS) {
    const expectedWidth = THEME_STUDIO_VIEWPORTS[viewport].width;
    for (const surface of expectedSurfaces) {
      const sample = bySample.get(`${viewport}:${surface}`);
      if (!sample) {
        coverage.push({
          code: "missing",
          message: "Not measured.",
          where: `${viewport} · ${surface}`,
        });
      } else if (Math.abs(sample.width - expectedWidth) > 1) {
        coverage.push({
          code: "viewport",
          message: `Measured at ${sample.width}px, expected ${expectedWidth}px.`,
          where: `${viewport} · ${surface}`,
        });
      }
    }
  }
  const measured = [...bySample.values()].filter((s) =>
    expectedSurfaces.includes(s.surface),
  );

  const overflow: GateFinding[] = [];
  const accessibility: GateFinding[] = [];
  const minorA11y: GateFinding[] = [];
  const media: GateFinding[] = [];
  const performance: GateFinding[] = [];
  let worstLcp: number | null = null;
  let worstCls: number | null = null;
  let blockingViolations = 0;

  for (const sample of measured) {
    const where = `${sample.viewport} · ${sample.surface}`;
    if (sample.overflowPx > 1) {
      overflow.push({
        code: "horizontal_overflow",
        message: `The page is ${Math.round(sample.overflowPx)}px wider than the viewport${sample.overflowOffenders.length ? ` (${sample.overflowOffenders.join(", ")})` : ""}.`,
        where,
      });
    }
    for (const violation of sample.violations) {
      const entry = {
        code: violation.id,
        message: `${violation.help || violation.id} (${violation.nodes} element${violation.nodes === 1 ? "" : "s"}, ${violation.impact ?? "unrated"})${violation.target ? ` — first: ${violation.target}` : ""}`,
        where,
      };
      if (violation.impact && BLOCKING_IMPACTS.has(violation.impact)) {
        accessibility.push(entry);
        blockingViolations += 1;
      } else {
        minorA11y.push(entry);
      }
    }
    if (sample.brokenImages > 0) {
      media.push({
        code: "broken_image",
        message: `${sample.brokenImages} image${sample.brokenImages === 1 ? "" : "s"} failed to load.`,
        where,
      });
    }
    if (sample.lcpMs !== null) worstLcp = Math.max(worstLcp ?? 0, sample.lcpMs);
    if (sample.cls !== null) worstCls = Math.max(worstCls ?? 0, sample.cls);
    if (sample.lcpMs !== null && sample.lcpMs > PERFORMANCE_THRESHOLDS.lcpMs) {
      performance.push({
        code: "lcp",
        message: `LCP ${Math.round(sample.lcpMs)}ms.`,
        where,
      });
    }
    if (sample.cls !== null && sample.cls >= PERFORMANCE_THRESHOLDS.cls) {
      performance.push({
        code: "cls",
        message: `CLS ${sample.cls.toFixed(3)}.`,
        where,
      });
    }
  }

  const accessibilityGate = gate("browser.accessibility", accessibility, {
    metrics: {
      blockingViolations,
      otherViolations: minorA11y.length,
    },
  });
  // Lower-impact violations are shown to the reviewer without failing.
  accessibilityGate.findings = [...accessibility, ...minorA11y].slice(
    0,
    MAX_FINDINGS,
  );

  return [
    gate("browser.coverage", coverage, {
      metrics: {
        samples: measured.length,
        expected: ACCEPTANCE_VIEWPORTS.length * expectedSurfaces.length,
      },
    }),
    gate("browser.overflow", overflow),
    accessibilityGate,
    gate("browser.media", media),
    gate("browser.performance", performance, {
      required: false,
      metrics: { worstLcpMs: worstLcp, worstCls },
    }),
  ];
}

// ------------------------------------------------------------ verdict

export type AcceptanceOutcome = "pass" | "fail" | "blocked";

/** Security failure blocks; any other required non-pass fails. A skipped
 * required gate is a failure too: "we could not check" is never a pass. */
export function acceptanceOutcome(
  gates: readonly GateResult[],
): AcceptanceOutcome {
  if (gates.some((g) => g.id === "package.security" && g.status === "fail")) {
    return "blocked";
  }
  return gates.some((g) => g.required && g.status !== "pass") ? "fail" : "pass";
}

export interface AcceptanceReport {
  version: typeof ACCEPTANCE_REPORT_VERSION;
  gates: GateResult[];
  /** The surfaces the browser stage must measure, fixed by the server. */
  surfaces?: AcceptanceSurface[];
  userAgent?: string;
}

/** Read a stored report back leniently for display: anything unexpected is
 * dropped rather than trusted. */
export function readAcceptanceReport(value: unknown): AcceptanceReport {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const gates = Array.isArray(input.gates)
    ? input.gates.filter(
        (g): g is GateResult =>
          !!g &&
          typeof g === "object" &&
          typeof (g as GateResult).id === "string" &&
          (g as GateResult).id in GATE_LABELS &&
          Array.isArray((g as GateResult).findings),
      )
    : [];
  const surfaces = Array.isArray(input.surfaces)
    ? input.surfaces.filter((s): s is AcceptanceSurface =>
        SURFACES.includes(s as AcceptanceSurface),
      )
    : undefined;
  return {
    version: ACCEPTANCE_REPORT_VERSION,
    gates,
    ...(surfaces ? { surfaces } : {}),
    ...(typeof input.userAgent === "string"
      ? { userAgent: input.userAgent }
      : {}),
  };
}
