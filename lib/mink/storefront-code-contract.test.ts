import { describe, expect, it } from "vitest";
import {
  MINK_STOREFRONT_CODE_CHUNK_CHARS,
  MINK_STOREFRONT_SANDBOX_CONTRACT,
  validateMinkStorefrontCodePatch,
} from "./storefront-code-contract";

const BASE_PATCH = {
  schemaVersion: 1,
  operation: "replace_custom_code",
  target: {
    pageSlug: "home",
    sectionId: "8eeea6f1-42f5-4be6-b60c-fd7463d7cc95",
    expectedPageVersion: "2026-09-04T10:20:30.123456+00:00",
    expectedSectionDigest: "a".repeat(64),
  },
  code: {
    html: '<section class="offer"><h2>Fresh arrivals</h2></section>',
    css: ".offer { padding: 2rem; }",
    js: "document.querySelector('.offer')?.classList.add('ready');",
    heightMode: "auto",
    fixedHeight: 480,
  },
} as const;

describe("Phase 7B storefront code contract", () => {
  it("normalizes a safe, exactly targeted patch without executing it", () => {
    const result = validateMinkStorefrontCodePatch(BASE_PATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toMatchObject({
      height_mode: "auto",
      fixed_height: 480,
    });
    expect(result.value.patchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(MINK_STOREFRONT_SANDBOX_CONTRACT).toMatchObject({
      phase: "7B",
      mode: "private_proposal_preview",
      iframe: {
        sandboxAttribute: "allow-scripts",
        sameOrigin: false,
        topNavigation: false,
      },
      authority: {
        canCreatePrivateProposal: true,
        canPreviewGeneratedCode: true,
        canSaveCode: false,
        canPublish: false,
      },
      limits: { codeReadChunkCharacters: MINK_STOREFRONT_CODE_CHUNK_CHARS },
    });
  });

  it("preserves the exact microsecond PostgreSQL timestamp returned by context", () => {
    const expectedPageVersion = "2026-09-04 10:20:30.123456+00";
    const result = validateMinkStorefrontCodePatch({
      ...BASE_PATCH,
      target: { ...BASE_PATCH.target, expectedPageVersion },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.patch.target.expectedPageVersion).toBe(
      expectedPageVersion,
    );
  });

  it.each([
    ["network", { js: "fetch('https://evil.example')" }, "network APIs"],
    ["cookies", { js: "console.log(document.cookie)" }, "cookies"],
    ["parent", { js: "parent.location = '/login'" }, "parent"],
    ["eval", { js: "eval('alert(1)')" }, "dynamic code"],
    ["active html", { html: "<iframe src=/admin></iframe>" }, "HTML"],
    ["CSS import", { css: "@import url('/private.css');" }, "@import"],
    [
      "computed parent",
      { js: "window['parent'].postMessage('x', '*')" },
      "computed access",
    ],
    ["navigation", { js: "window.open('/dashboard')" }, "navigation"],
    ["messaging", { js: "postMessage('secret', '*')" }, "cross-context"],
    ["unbounded loop", { js: "while (true) {}" }, "unbounded loops"],
  ])("rejects %s capabilities", (_label, override, expected) => {
    const result = validateMinkStorefrontCodePatch({
      ...BASE_PATCH,
      code: { ...BASE_PATCH.code, ...override },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain(expected);
  });

  it("rejects tenant injection, normalized-target drift, and stale-target omissions", () => {
    const result = validateMinkStorefrontCodePatch({
      ...BASE_PATCH,
      storeId: "another-store",
      target: {
        ...BASE_PATCH.target,
        pageSlug: " About-Us ",
        expectedSectionDigest: undefined,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain("patch.storeId is not allowed.");
    expect(result.issues.join(" ")).toContain("normalized and exact");
    expect(result.issues.join(" ")).toContain("SHA-256");
  });

  it("enforces per-field and combined AI size limits", () => {
    const result = validateMinkStorefrontCodePatch({
      ...BASE_PATCH,
      code: {
        ...BASE_PATCH.code,
        html: "h".repeat(64 * 1024),
        css: "c".repeat(40 * 1024),
        js: "",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("Combined code exceeds");
  });
});
