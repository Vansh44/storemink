import "server-only";

import { createHash } from "node:crypto";
import {
  CODE_HEIGHT_MAX,
  CODE_HEIGHT_MIN,
  CODE_MAX_CHARS,
  validateConfig,
  validatePageSlug,
  type CustomCodeConfig,
} from "@/lib/sections/registry";

export const MINK_STOREFRONT_PATCH_SCHEMA_VERSION = 1 as const;
export const MINK_STOREFRONT_CODE_CHUNK_CHARS = 8_000;
export const MINK_STOREFRONT_PATCH_MAX_CHARS = 96 * 1024;
export const MINK_STOREFRONT_SANDBOX_ATTRIBUTE = "allow-scripts" as const;

export interface MinkStorefrontCodePatch {
  schemaVersion: typeof MINK_STOREFRONT_PATCH_SCHEMA_VERSION;
  operation: "replace_custom_code";
  target: {
    /** `home` is the public tool alias for the stored empty homepage slug. */
    pageSlug: string;
    sectionId: string;
    /** Exact microsecond-preserving optimistic-lock value returned by context. */
    expectedPageVersion: string;
    expectedSectionDigest: string;
  };
  code: {
    html: string;
    css: string;
    js: string;
    heightMode: "auto" | "fixed";
    fixedHeight: number;
  };
}

export interface ValidatedMinkStorefrontCodePatch {
  patch: MinkStorefrontCodePatch;
  config: CustomCodeConfig;
  patchDigest: string;
}

export interface MinkStorefrontSandboxContract {
  schemaVersion: typeof MINK_STOREFRONT_PATCH_SCHEMA_VERSION;
  phase: "7B";
  mode: "private_proposal_preview";
  target: {
    pageSlug: "exact";
    sectionId: "exact";
    pageVersion: "required";
    sectionDigest: "required";
  };
  limits: {
    maxCharactersPerCodeField: number;
    maxCharactersPerPatch: number;
    codeReadChunkCharacters: number;
    minFixedHeight: number;
    maxFixedHeight: number;
  };
  iframe: {
    sandboxAttribute: typeof MINK_STOREFRONT_SANDBOX_ATTRIBUTE;
    opaqueOrigin: true;
    sameOrigin: false;
    topNavigation: false;
  };
  prohibitedCapabilities: readonly string[];
  authority: {
    canReadBuilderContext: true;
    canValidatePatchShape: true;
    canCreatePrivateProposal: boolean;
    canPreviewGeneratedCode: boolean;
    canSaveCode: false;
    canPublish: false;
    canAccessRepository: false;
    canDeploy: false;
  };
}

export const MINK_STOREFRONT_SANDBOX_CONTRACT = Object.freeze({
  schemaVersion: MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
  phase: "7B",
  mode: "private_proposal_preview",
  target: {
    pageSlug: "exact",
    sectionId: "exact",
    pageVersion: "required",
    sectionDigest: "required",
  },
  limits: {
    maxCharactersPerCodeField: CODE_MAX_CHARS,
    maxCharactersPerPatch: MINK_STOREFRONT_PATCH_MAX_CHARS,
    codeReadChunkCharacters: MINK_STOREFRONT_CODE_CHUNK_CHARS,
    minFixedHeight: CODE_HEIGHT_MIN,
    maxFixedHeight: CODE_HEIGHT_MAX,
  },
  iframe: {
    sandboxAttribute: MINK_STOREFRONT_SANDBOX_ATTRIBUTE,
    opaqueOrigin: true,
    sameOrigin: false,
    topNavigation: false,
  },
  prohibitedCapabilities: Object.freeze([
    "network requests",
    "cookies or browser storage",
    "parent or top-window access",
    "dynamic code evaluation",
    "workers or service workers",
    "forms, embeds, nested frames, or top navigation",
    "repository, environment, database, or deployment access",
  ]),
  authority: {
    canReadBuilderContext: true,
    canValidatePatchShape: true,
    canCreatePrivateProposal: true,
    canPreviewGeneratedCode: true,
    canSaveCode: false,
    canPublish: false,
    canAccessRepository: false,
    canDeploy: false,
  },
} as const) satisfies MinkStorefrontSandboxContract;

const ROOT_KEYS = ["schemaVersion", "operation", "target", "code"] as const;
const TARGET_KEYS = [
  "pageSlug",
  "sectionId",
  "expectedPageVersion",
  "expectedSectionDigest",
] as const;
const CODE_KEYS = ["html", "css", "js", "heightMode", "fixedHeight"] as const;
const SECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Validate the immutable storefront-code contract. Phase 7B may store the
 * validated value as a private Mink proposal and execute it only inside the
 * opaque preview iframe. This function never executes code or updates a
 * Website Builder page. A later phase must independently re-read and match
 * both optimistic-lock fields before it can propose a guarded builder write.
 */
export function validateMinkStorefrontCodePatch(
  input: unknown,
):
  | { ok: true; value: ValidatedMinkStorefrontCodePatch }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: ["Patch must be an object."] };
  }
  rejectUnknownKeys(input, ROOT_KEYS, "patch", issues);
  if (input.schemaVersion !== MINK_STOREFRONT_PATCH_SCHEMA_VERSION) {
    issues.push("schemaVersion must be 1.");
  }
  if (input.operation !== "replace_custom_code") {
    issues.push("operation must be replace_custom_code.");
  }

  const target = isRecord(input.target) ? input.target : null;
  const code = isRecord(input.code) ? input.code : null;
  if (!target) issues.push("target must be an object.");
  if (!code) issues.push("code must be an object.");
  if (!target || !code) return { ok: false, issues };

  rejectUnknownKeys(target, TARGET_KEYS, "target", issues);
  rejectUnknownKeys(code, CODE_KEYS, "code", issues);

  const pageSlug = readPageSlug(target.pageSlug, issues);
  const sectionId = readSectionId(target.sectionId, issues);
  const expectedPageVersion = readVersion(target.expectedPageVersion, issues);
  const expectedSectionDigest = readDigest(
    target.expectedSectionDigest,
    issues,
  );
  const html = readCodeField(code.html, "html", issues);
  const css = readCodeField(code.css, "css", issues);
  const js = readCodeField(code.js, "js", issues);
  const heightMode =
    code.heightMode === "auto" || code.heightMode === "fixed"
      ? code.heightMode
      : null;
  if (!heightMode) issues.push("code.heightMode must be auto or fixed.");
  const fixedHeight = Number(code.fixedHeight);
  if (
    !Number.isInteger(code.fixedHeight) ||
    fixedHeight < CODE_HEIGHT_MIN ||
    fixedHeight > CODE_HEIGHT_MAX
  ) {
    issues.push(
      `code.fixedHeight must be an integer from ${CODE_HEIGHT_MIN} to ${CODE_HEIGHT_MAX}.`,
    );
  }

  if (html.length + css.length + js.length > MINK_STOREFRONT_PATCH_MAX_CHARS) {
    issues.push(
      `Combined code exceeds the ${MINK_STOREFRONT_PATCH_MAX_CHARS}-character AI patch limit.`,
    );
  }
  validateGeneratedHtml(html, issues);
  validateGeneratedCss(css, issues);
  validateGeneratedJavaScript(js, issues);

  const configResult = validateConfig(
    "custom_code",
    {
      html,
      css,
      js,
      height_mode: heightMode ?? "auto",
      fixed_height: Number.isFinite(fixedHeight)
        ? fixedHeight
        : CODE_HEIGHT_MIN,
    },
    "draft",
  );
  if ("error" in configResult) issues.push(configResult.error);

  if (
    issues.length ||
    !pageSlug ||
    !sectionId ||
    !expectedPageVersion ||
    !expectedSectionDigest ||
    !heightMode ||
    "error" in configResult
  ) {
    return { ok: false, issues: [...new Set(issues)].slice(0, 20) };
  }

  const patch: MinkStorefrontCodePatch = {
    schemaVersion: MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
    operation: "replace_custom_code",
    target: {
      pageSlug,
      sectionId,
      expectedPageVersion,
      expectedSectionDigest,
    },
    code: { html, css, js, heightMode, fixedHeight },
  };
  return {
    ok: true,
    value: {
      patch,
      config: configResult.config as CustomCodeConfig,
      patchDigest: digestMinkStorefrontValue(patch),
    },
  };
}

export function digestMinkStorefrontValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function readPageSlug(value: unknown, issues: string[]): string | null {
  if (value === "home") return "home";
  if (typeof value !== "string") {
    issues.push("target.pageSlug must be home or an exact page slug.");
    return null;
  }
  const validated = validatePageSlug(value);
  if ("error" in validated) {
    issues.push(`target.pageSlug: ${validated.error}`);
    return null;
  }
  if (validated.slug !== value) {
    issues.push("target.pageSlug must already be normalized and exact.");
    return null;
  }
  return validated.slug;
}

function readSectionId(value: unknown, issues: string[]): string | null {
  if (typeof value !== "string" || !SECTION_ID_RE.test(value)) {
    issues.push(
      "target.sectionId must be an exact 1-128 character builder section id.",
    );
    return null;
  }
  return value;
}

function readVersion(value: unknown, issues: string[]): string | null {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value))
  ) {
    issues.push(
      "target.expectedPageVersion must be the exact timestamp returned by builder context.",
    );
    return null;
  }
  return value;
}

function readDigest(value: unknown, issues: string[]): string | null {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    issues.push(
      "target.expectedSectionDigest must be a lowercase SHA-256 digest.",
    );
    return null;
  }
  return value;
}

function readCodeField(
  value: unknown,
  field: "html" | "css" | "js",
  issues: string[],
): string {
  if (typeof value !== "string") {
    issues.push(`code.${field} must be a string.`);
    return "";
  }
  if (value.length > CODE_MAX_CHARS) {
    issues.push(`code.${field} exceeds ${CODE_MAX_CHARS} characters.`);
  }
  if (/\u0000|[\u202a-\u202e\u2066-\u2069]/i.test(value)) {
    issues.push(
      `code.${field} may not contain null bytes or bidirectional control characters.`,
    );
  }
  return value;
}

function validateGeneratedHtml(value: string, issues: string[]): void {
  const checks: Array<[RegExp, string]> = [
    [
      /<\s*\/?\s*(?:script|style|iframe|object|embed|form|base|meta|link)\b/i,
      "active or navigational HTML elements",
    ],
    [/\son[a-z]+\s*=/i, "inline event handlers"],
    [
      /\b(?:src|srcset|href|action|formaction)\s*=/i,
      "network-capable URL attributes",
    ],
    [/\bstyle\s*=/i, "inline styles (use the separately validated CSS field)"],
    [/<\s*svg\b[^>]*\son[a-z]+\s*=/i, "active SVG event handlers"],
  ];
  addPatternIssues("HTML", value, checks, issues);
}

function validateGeneratedCss(value: string, issues: string[]): void {
  const checks: Array<[RegExp, string]> = [
    [/@import\b/i, "@import"],
    [/\burl\s*\(/i, "network-capable or embedded URLs"],
    [/\bexpression\s*\(/i, "CSS expressions"],
    [/\bbehavior\s*:/i, "CSS behavior"],
    [/-moz-binding\s*:/i, "-moz-binding"],
  ];
  addPatternIssues("CSS", value, checks, issues);
}

function validateGeneratedJavaScript(value: string, issues: string[]): void {
  const checks: Array<[RegExp, string]> = [
    [
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/i,
      "network APIs",
    ],
    [
      /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/i,
      "browser storage or cookies",
    ],
    [
      /\b(?:window\.)?(?:parent|top|opener)\b/i,
      "parent, top, or opener access",
    ],
    [
      /\[\s*["'](?:parent|top|opener|fetch|location|cookie|referrer)["']\s*\]/i,
      "computed access to privileged browser capabilities",
    ],
    [/\b(?:eval|Function)\s*\(/i, "dynamic code evaluation"],
    [/\b(?:Worker|SharedWorker)\s*\(|serviceWorker\b/i, "worker APIs"],
    [/\bimport\s*\(/i, "dynamic imports"],
    [
      /\b(?:new\s+)?Image\s*\(|\.src\s*=|setAttribute\s*\(\s*["']src/i,
      "network-capable resource loading",
    ],
    [
      /\b(?:location\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\(|history\.(?:pushState|replaceState)\s*\()/i,
      "navigation",
    ],
    [
      /\b(?:postMessage|document\.referrer|window\.name)\b/i,
      "cross-context messaging or embedding metadata",
    ],
    [/\b(?:https?|wss?):\/\//i, "external URL literals"],
    [/\bdocument\.(?:write|writeln)\s*\(/i, "document.write"],
    [
      /\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i,
      "obvious unbounded loops",
    ],
  ];
  addPatternIssues("JavaScript", value, checks, issues);
}

function addPatternIssues(
  language: string,
  value: string,
  checks: Array<[RegExp, string]>,
  issues: string[],
): void {
  for (const [pattern, capability] of checks) {
    if (pattern.test(value)) {
      issues.push(`${language} may not use ${capability}.`);
    }
  }
}

function rejectUnknownKeys<const T extends readonly string[]>(
  value: Record<string, unknown>,
  allowed: T,
  label: string,
  issues: string[],
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${label}.${key} is not allowed.`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
