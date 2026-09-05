import type { CustomCodeConfig } from "@/lib/sections/registry";
import {
  MINK_STOREFRONT_BROWSER_FLOORS,
  MINK_STOREFRONT_BROWSER_ISSUES,
  MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
  MINK_STOREFRONT_BROWSER_WIDTHS,
  type MinkStorefrontBrowserFamily,
  type MinkStorefrontBrowserValidation,
  type MinkStorefrontBrowserViewport,
} from "./storefront-publication-types";

const SHA256_RE = /^[a-f0-9]{64}$/;
const VALIDATION_MAX_AGE_MS = 2 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;

export interface MinkStorefrontStaticValidation {
  passed: boolean;
  checks: string[];
  issues: string[];
}

export function validateMinkStorefrontPublicationStatic(
  config: CustomCodeConfig,
): MinkStorefrontStaticValidation {
  const issues: string[] = [];
  const html = config.html;
  const css = config.css;

  for (const tag of html.matchAll(/<img\b([^>]*)>/gi)) {
    if (!hasAttribute(tag[1] ?? "", "alt")) {
      issues.push(
        "Every image must have an alt attribute, including decorative images.",
      );
      break;
    }
  }
  validateNamedElements(html, "button", "button", issues);
  validateNamedElements(html, "a", "link", issues);
  validateFormLabels(html, issues);
  validateIds(html, issues);
  validateHeadings(html, issues);

  if (/\btabindex\s*=\s*["']?[1-9]\d*/i.test(html)) {
    issues.push("Positive tabindex values are not allowed.");
  }
  if (
    /<(?:a|button|input|select|textarea)\b[^>]*\baria-hidden\s*=\s*["']?true/i.test(
      html,
    )
  ) {
    issues.push(
      "Focusable controls cannot be hidden from assistive technology.",
    );
  }
  if (
    /(?:outline\s*:\s*(?:none|0(?:\s+none)?)(?:\s*!important)?|:focus\s*\{[^}]*outline\s*:\s*(?:none|0))/i.test(
      css,
    )
  ) {
    issues.push("Keyboard focus outlines cannot be removed.");
  }
  if (
    /\b(?:animation|transition)(?:-[a-z-]+)?\s*:/i.test(css) &&
    !/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/i.test(css)
  ) {
    issues.push(
      "Animated or transitioning content must include a prefers-reduced-motion fallback.",
    );
  }
  for (const match of css.matchAll(/\bmin-width\s*:\s*(\d{3,})px/gi)) {
    if (Number(match[1]) > MINK_STOREFRONT_BROWSER_WIDTHS.mobile) {
      issues.push(
        "CSS min-width cannot force content wider than the mobile validation viewport.",
      );
      break;
    }
  }

  return {
    passed: issues.length === 0,
    checks: [
      "Accessible names and image alternatives checked",
      "Form labels, unique IDs and heading order checked",
      "Keyboard focus and motion preferences checked",
      "Mobile minimum-width constraints checked",
      "Generated-code CSP and capability policy revalidated",
    ],
    issues: [...new Set(issues)].slice(0, 20),
  };
}

export function validateMinkStorefrontBrowserValidation(input: {
  value: unknown;
  patchDigest: string;
  now?: number;
  maxAgeMs?: number;
  skipFreshness?: boolean;
}): MinkStorefrontBrowserValidation {
  const value = requireRecord(input.value, "Browser validation is missing.");
  assertOnlyKeys(value, [
    "schemaVersion",
    "patchDigest",
    "checkedAt",
    "browser",
    "viewports",
  ]);
  if (
    value.schemaVersion !== MINK_STOREFRONT_BROWSER_VALIDATION_VERSION ||
    value.patchDigest !== input.patchDigest ||
    !SHA256_RE.test(String(value.patchDigest ?? ""))
  ) {
    throw new Error(
      "Browser validation does not match this exact code proposal.",
    );
  }
  if (typeof value.checkedAt !== "string" || value.checkedAt.length > 40) {
    throw new Error("Browser validation time is invalid.");
  }
  const checkedAt = Date.parse(value.checkedAt);
  const now = input.now ?? Date.now();
  if (
    Number.isNaN(checkedAt) ||
    (!input.skipFreshness &&
      (checkedAt > now + MAX_CLOCK_SKEW_MS ||
        now - checkedAt > (input.maxAgeMs ?? VALIDATION_MAX_AGE_MS)))
  ) {
    throw new Error(
      "Browser validation expired. Run both viewport checks again.",
    );
  }

  const browser = requireRecord(value.browser, "Browser identity is invalid.");
  assertOnlyKeys(browser, ["family", "major", "supported"]);
  const family = browser.family as MinkStorefrontBrowserFamily;
  if (
    !["chromium", "firefox", "webkit", "unknown"].includes(family) ||
    !Number.isInteger(browser.major) ||
    Number(browser.major) < 0 ||
    Number(browser.major) > 999 ||
    typeof browser.supported !== "boolean"
  ) {
    throw new Error("Browser identity is invalid.");
  }
  const floor =
    family === "unknown" ? null : MINK_STOREFRONT_BROWSER_FLOORS[family];
  if (!browser.supported || floor === null || Number(browser.major) < floor) {
    throw new Error(
      "Use a supported current Chrome, Edge, Firefox or Safari browser before publishing.",
    );
  }

  const viewports = requireRecord(
    value.viewports,
    "Viewport validation is invalid.",
  );
  assertOnlyKeys(viewports, ["desktop", "mobile"]);
  const desktop = readViewport(viewports.desktop, "desktop");
  const mobile = readViewport(viewports.mobile, "mobile");
  return {
    schemaVersion: MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
    patchDigest: input.patchDigest,
    checkedAt: new Date(checkedAt).toISOString(),
    browser: {
      family,
      major: Number(browser.major),
      supported: true,
    },
    viewports: { desktop, mobile },
  };
}

function readViewport(value: unknown, viewport: MinkStorefrontBrowserViewport) {
  const row = requireRecord(value, `${viewport} validation is invalid.`);
  assertOnlyKeys(row, [
    "viewport",
    "width",
    "passed",
    "issues",
    "runtimeErrorCount",
    "cspViolationCount",
    "horizontalOverflow",
  ]);
  const expectedWidth = MINK_STOREFRONT_BROWSER_WIDTHS[viewport];
  if (
    row.viewport !== viewport ||
    row.width !== expectedWidth ||
    row.passed !== true ||
    row.runtimeErrorCount !== 0 ||
    row.cspViolationCount !== 0 ||
    row.horizontalOverflow !== false ||
    !Array.isArray(row.issues) ||
    row.issues.length !== 0 ||
    !row.issues.every((issue) => MINK_STOREFRONT_BROWSER_ISSUES.includes(issue))
  ) {
    throw new Error(
      `${viewport === "desktop" ? "Desktop" : "Mobile"} browser validation did not pass cleanly.`,
    );
  }
  return {
    viewport,
    width: expectedWidth,
    passed: true,
    issues:
      [] as MinkStorefrontBrowserValidation["viewports"][typeof viewport]["issues"],
    runtimeErrorCount: 0,
    cspViolationCount: 0,
    horizontalOverflow: false,
  };
}

function validateNamedElements(
  html: string,
  tag: "button" | "a",
  label: string,
  issues: string[],
) {
  const pattern = new RegExp(
    `<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`,
    "gi",
  );
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const text = stripTags(match[2] ?? "");
    if (
      !text &&
      !hasNonEmptyAttribute(attributes, "aria-label") &&
      !hasNonEmptyAttribute(attributes, "aria-labelledby")
    ) {
      issues.push(`Every ${label} must have an accessible name.`);
      return;
    }
  }
}

function validateFormLabels(html: string, issues: string[]) {
  const labelledIds = new Set(
    [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(
      (match) => match[1],
    ),
  );
  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attributes = match[2] ?? "";
    if (/\btype\s*=\s*["']?hidden\b/i.test(attributes)) continue;
    const id = readAttribute(attributes, "id");
    if (
      !hasNonEmptyAttribute(attributes, "aria-label") &&
      !hasNonEmptyAttribute(attributes, "aria-labelledby") &&
      !(id && labelledIds.has(id))
    ) {
      issues.push("Every form control must have a label or accessible name.");
      return;
    }
  }
}

// ★ Read the `id` ATTRIBUTE, never any attribute whose name ends in `id`.
// A bare /\bid\s*=/ scan also matches `data-id=` (`\b` sits between the
// hyphen and the `i`), so two `data-id="card"` elements were reported as
// duplicate element IDs and refused publication outright — while the in-frame
// check, which walks `querySelectorAll("[id]")`, correctly saw none. The two
// checks must agree, and the DOM one is right. `readAttribute` anchors on
// start-of-attributes or whitespace, which is what excludes `data-id`.
function validateIds(html: string, issues: string[]) {
  const seen = new Set<string>();
  for (const tag of html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gi)) {
    const id = readAttribute(tag[1] ?? "", "id");
    if (!id) continue;
    if (seen.has(id)) {
      issues.push("Element IDs must be unique.");
      return;
    }
    seen.add(id);
  }
}

function validateHeadings(html: string, issues: string[]) {
  let previous = 0;
  for (const match of html.matchAll(/<h([1-6])\b/gi)) {
    const level = Number(match[1]);
    if (previous > 0 && level > previous + 1) {
      issues.push("Heading levels cannot skip an outline level.");
      return;
    }
    previous = level;
  }
}

function stripTags(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .trim();
}

function hasAttribute(value: string, name: string) {
  return new RegExp(`(?:^|\\s)${name}\\s*=`, "i").test(value);
}

function hasNonEmptyAttribute(value: string, name: string) {
  const found = readAttribute(value, name);
  return Boolean(found?.trim());
}

function readAttribute(value: string, name: string): string | null {
  const quoted = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`,
    "i",
  ).exec(value);
  if (quoted) return quoted[1];
  const bare = new RegExp(`(?:^|\\s)${name}\\s*=\\s*([^\\s>]+)`, "i").exec(
    value,
  );
  return bare?.[1] ?? null;
}

function requireRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new Error("Browser validation contains unsupported fields.");
  }
}
