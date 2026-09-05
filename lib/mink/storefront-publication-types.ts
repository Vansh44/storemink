import type { MinkProductActionStatus } from "./product-action-types";

export const MINK_STOREFRONT_BROWSER_VALIDATION_VERSION = 1 as const;
export const MINK_STOREFRONT_BROWSER_WIDTHS = Object.freeze({
  desktop: 1280,
  mobile: 390,
});
// ★ These MUST NOT be stricter than package.json's `browserslist`, which is
// the whole app's stated support floor (chrome/edge 111, firefox 128,
// safari/ios_saf 16.4). A publication check that refuses a browser the rest of
// the dashboard supports is an unfixable dead end: it is enforced again
// server-side, so there is no override, and macOS Monterey caps out at Safari
// 16.x. Firefox stays at 121 deliberately — it is BELOW its browserslist floor,
// so it can only ever be permissive, never blocking.
//
// ⚠ Major versions only: `browser.major` is the sole version field in the
// persisted, hash-bound `browser_validation` payload. Safari's 16.4 minor is
// enforced by `minkStorefrontBrowserIdentity` below instead of by widening
// that payload.
export const MINK_STOREFRONT_BROWSER_FLOORS = Object.freeze({
  chromium: 111,
  firefox: 121,
  webkit: 16,
});

/** Safari/iOS gained the `@property` + `color-mix()` baseline at 16.4. */
const WEBKIT_MINOR_FLOOR = Object.freeze({ major: 16, minor: 4 });

export const MINK_STOREFRONT_BROWSER_ISSUES = [
  "runtime_error",
  "csp_violation",
  "horizontal_overflow",
  "missing_image_alt",
  "missing_button_name",
  "missing_link_name",
  "missing_form_label",
  "duplicate_id",
  "invalid_heading_order",
  "positive_tabindex",
  "hidden_focus_target",
] as const;

export type MinkStorefrontBrowserIssue =
  (typeof MINK_STOREFRONT_BROWSER_ISSUES)[number];
export type MinkStorefrontBrowserViewport = "desktop" | "mobile";
export type MinkStorefrontBrowserFamily =
  | "chromium"
  | "firefox"
  | "webkit"
  | "unknown";

/** Client-safe, bounded browser identity; never stores the raw user agent. */
export function minkStorefrontBrowserIdentity(userAgent: string): {
  family: MinkStorefrontBrowserFamily;
  major: number;
  supported: boolean;
} {
  const edge = /Edg\/(\d+)/.exec(userAgent);
  const chromium = /(?:Chrome|CriOS)\/(\d+)/.exec(userAgent);
  const firefox = /(?:Firefox|FxiOS)\/(\d+)/.exec(userAgent);
  const safari = /Version\/(\d+)(?:\.(\d+))?(?:\.\d+)*[^\n]*Safari\//.exec(
    userAgent,
  );
  const family: MinkStorefrontBrowserFamily =
    edge || chromium
      ? "chromium"
      : firefox
        ? "firefox"
        : safari
          ? "webkit"
          : "unknown";
  const major = Number((edge ?? chromium ?? firefox ?? safari)?.[1] ?? 0);
  const floor =
    family === "unknown" ? null : MINK_STOREFRONT_BROWSER_FLOORS[family];
  // Only Safari needs the minor: 16.0-16.3 are outside browserslist while 16.4
  // is inside it, and the stored payload carries no minor field.
  const belowWebkitMinor =
    family === "webkit" &&
    major === WEBKIT_MINOR_FLOOR.major &&
    Number(safari?.[2] ?? 0) < WEBKIT_MINOR_FLOOR.minor;
  return {
    family,
    major,
    supported: floor !== null && major >= floor && !belowWebkitMinor,
  };
}

export interface MinkStorefrontBrowserFrameResult {
  token: string;
  viewport: MinkStorefrontBrowserViewport;
  width: number;
  passed: boolean;
  issues: MinkStorefrontBrowserIssue[];
  runtimeErrorCount: number;
  cspViolationCount: number;
  horizontalOverflow: boolean;
}

export interface MinkStorefrontBrowserValidation {
  schemaVersion: typeof MINK_STOREFRONT_BROWSER_VALIDATION_VERSION;
  patchDigest: string;
  checkedAt: string;
  browser: {
    family: MinkStorefrontBrowserFamily;
    major: number;
    supported: boolean;
  };
  viewports: {
    desktop: Omit<MinkStorefrontBrowserFrameResult, "token">;
    mobile: Omit<MinkStorefrontBrowserFrameResult, "token">;
  };
}

export interface MinkStorefrontPublicationValues {
  page_slug: string;
  page_title: string;
  page_status: "draft" | "published";
  published_at: string | null;
  sections_digest: string;
  target_section_id: string;
  target_section_digest: string;
}

export interface MinkStorefrontPublicationApproval {
  id: string;
  sourceApprovalId: string;
  toolName: "publish_storefront_code";
  operation: "apply" | "rollback";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: 0;
  resource: {
    type: "storefront_page";
    id: string;
    label: string;
    dashboardPath: string;
    publicPath: string;
  };
  before: MinkStorefrontPublicationValues;
  after: MinkStorefrontPublicationValues;
  checks: {
    staticChecksPassed: boolean;
    browserChecksPassed: boolean;
    desktopWidth: number;
    mobileWidth: number;
    browserFamily: MinkStorefrontBrowserFamily | null;
    browserMajor: number | null;
  };
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkStorefrontPublicationResult {
  approval: MinkStorefrontPublicationApproval;
  auditId: string;
  repeated: boolean;
}
