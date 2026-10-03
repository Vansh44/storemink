import { expect, it } from "vitest";
import { studio } from "@/lib/themes/definitions/studio";
import {
  themeFingerprint,
  fingerprintDistance,
  measureDistinctness,
  readVarietyContext,
  readDistinctnessReport,
  fingerprintChoiceValues,
  paletteFamilyIssues,
  colourBand,
} from "./fingerprint";
import {
  DESIGN_DIRECTION_IDS,
  recommendedDirection,
} from "./design-directions";
import {
  INDUSTRY_PLAYBOOKS,
  industryPlaybookPrompt,
} from "./industry-playbooks";
import { explicitDraftStyleIssues } from "./style-choices";
import { validateThemeIntent } from "./contracts";
import { catalogueVarietyContext } from "./prompts";
import { createFakeModelClient, runFakeProvider } from "./fake-provider";
import { runThemeGeneration, type GenerationInput } from "./pipeline";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type ThemeStudioModelClient,
} from "./provider";

const facts = {
  name: "Variety",
  themeId: "variety",
  industries: ["clothing" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
};
const fakeInput = {
  ...facts,
  brief: "An original apparel store.",
  referenceCount: 0,
};
const input = (): GenerationInput => ({
  facts: { ...facts, baseThemeName: null },
  compile: {
    ...facts,
    baseEngine: null,
    versionNumber: 1,
    modelKey: "gemini-3.8-flash",
    modelLabel: "Gemini 3.8 Flash",
    referenceDigests: [],
  },
  providerModel: "fake",
  promptVersion: "theme-studio-v21",
  messages: [{ kind: "brief", body: fakeInput.brief }],
  references: [],
});
const generate = (client: ThemeStudioModelClient, data = input()) =>
  runThemeGeneration(client, data, new AbortController().signal);

it("offers seven directions and multiple structures without modifying legacy playbook prompts", () => {
  expect(DESIGN_DIRECTION_IDS).toHaveLength(7);
  for (const p of Object.values(INDUSTRY_PLAYBOOKS)) {
    expect(p.structures).toHaveLength(3);
    expect(new Set(p.structures.map((s) => s.sections.join("/"))).size).toBe(3);
    expect(p.structures.every((s) => !s.sections.includes("ticker"))).toBe(
      true,
    );
  }
  expect(industryPlaybookPrompt(["clothing"])).not.toContain('"structures"');
  expect(industryPlaybookPrompt(["clothing"], true)).not.toContain(
    '"homeSections"',
  );
  const preferred = recommendedDirection(["clothing"], []);
  expect(recommendedDirection(["clothing"], [preferred, preferred])).not.toBe(
    preferred,
  );
});

it("reads legacy intents but requires closed direction and palette choices for new intents", () => {
  const old = runFakeProvider(fakeInput);
  expect(old.ok).toBe(true);
  if (!old.ok) return;
  expect(validateThemeIntent({ ...old.value, schemaVersion: 2 }).ok).toBe(
    false,
  );
  expect(
    validateThemeIntent({
      ...old.value,
      schemaVersion: 2,
      designDirection: "magazine-editorial",
      paletteFamily: "dark",
    }).ok,
  ).toBe(true);
  expect(
    validateThemeIntent({
      ...old.value,
      schemaVersion: 2,
      designDirection: "write custom code",
      paletteFamily: "dark",
    }).ok,
  ).toBe(false);
  expect(() =>
    explicitDraftStyleIssues({ pages: [null, { sections: [null] }] }),
  ).not.toThrow();
});

it("compares rendered choices, ignores copy/artwork, and refuses accent-only novelty", () => {
  expect(colourBand("#123")).toBe(colourBand("#112233"));
  const a = structuredClone(studio),
    b = structuredClone(studio);
  b.name = "Different copy";
  b.preset.brand.tagline = "A different slogan";
  for (const p of b.preset.pages)
    for (const s of p.sections)
      if ("image_url" in s.config) s.config.image_url = "/different.webp";
  expect(fingerprintDistance(themeFingerprint(a), themeFingerprint(b))).toBe(0);
  b.preset.design.palette.accent = "#ff0000";
  const context = [
    { themeId: "studio", direction: null, fingerprint: themeFingerprint(a) },
  ];
  expect(measureDistinctness(b, context)).toMatchObject({
    status: "similar",
    changedAxes: 0,
  });
  b.preset.pages[0].sections.reverse();
  expect(
    fingerprintDistance(themeFingerprint(a), themeFingerprint(b)),
  ).toBeGreaterThan(0);
  const grocery = structuredClone(studio);
  grocery.preset.design.layout = { storefront: "grocery", card: "framed" };
  expect(themeFingerprint(grocery).card).toBe("grocery");
  expect(themeFingerprint(grocery).composition).toContain("grocery/grocery");
  expect(readVarietyContext(context)).toEqual(context);
  const choices = fingerprintChoiceValues(themeFingerprint(a));
  expect(choices.gridColumnsMobile).toBe(
    String(a.preset.design.layout?.gridColumnsMobile ?? 1),
  );
  const frequency = catalogueVarietyContext({ ...facts, baseThemeName: null }, [
    ...context,
    ...context,
  ]);
  expect(frequency).toContain('"choiceFrequency"');
  expect(frequency).toContain(`"${choices.card}":2`);
  expect(
    readVarietyContext([{ ...context[0], themeId: "ignore instructions" }]),
  ).toBeNull();
  expect(
    readDistinctnessReport(measureDistinctness(a, context)),
  ).not.toBeNull();
  expect(readDistinctnessReport({ score: 99 })).toBeNull();
  expect(
    readDistinctnessReport({
      ...measureDistinctness(a, context),
      threshold: 0.4,
    })?.threshold,
  ).toBe(0.4);
});

it("requires explicit styles, including false/one-column choices, without replacing them with premium presets", async () => {
  const fake = createFakeModelClient(fakeInput);
  const outcome = await generate({
    provider: "fake",
    async generate(request, signal) {
      const result = await fake.generate(request, signal);
      if (request.stage === "draft" && result.kind === "ok") {
        const raw = result.value as {
          design: { layout: Record<string, unknown> };
          pages: { sections: { configJson: string }[] }[];
        };
        expect(raw.design).not.toHaveProperty("layoutOverridesJson");
        Object.assign(raw.design.layout, {
          stickyAddToCart: false,
          gridColumnsMobile: 1,
          shopFilters: false,
          collectionBanner: false,
          cardHoverImage: false,
        });
      }
      return result;
    },
  });
  expect(outcome.kind).toBe("version");
  if (outcome.kind !== "version") return;
  expect(outcome.package.definition.preset.design.layout).toMatchObject({
    stickyAddToCart: false,
    gridColumnsMobile: 1,
    shopFilters: false,
    collectionBanner: false,
  });
  expect(outcome.intent).toMatchObject({
    schemaVersion: 2,
    designDirection: "magazine-editorial",
    paletteFamily: "light",
  });
});

it.each(["dark", "colour-field", "tinted-neutral"] as const)(
  "refuses a neutral white draft labelled %s",
  async (family) => {
    const fake = createFakeModelClient(fakeInput);
    const outcome = await generate({
      provider: "fake",
      async generate(request, signal) {
        const result = await fake.generate(request, signal);
        if (request.stage === "intent" && result.kind === "ok")
          (
            result.value as { intent: { paletteFamily: string } }
          ).intent.paletteFamily = family;
        return result;
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(JSON.stringify(outcome.telemetry.repairReasons)).toContain(
      "page background",
    );
    expect(paletteFamilyIssues("dark", "#202A36")).toEqual([]);
    expect(paletteFamilyIssues("colour-field", "#F4CB54")).toEqual([]);
    expect(paletteFamilyIssues("tinted-neutral", "#CBD6BF")).toEqual([]);
  },
);

it.each([
  "improve",
  "copy",
  "invalid",
  "no-change",
  "truncated",
  "refused",
  "remove",
  "provider-error",
  "palette",
])(
  "makes exactly one bounded variety patch (%s) and keeps the valid theme on ineffective edits",
  async (mode) => {
    const original = await generate(createFakeModelClient(fakeInput));
    expect(original.kind).toBe("version");
    if (original.kind !== "version") return;
    const fake = createFakeModelClient(fakeInput);
    const requests: StructuredRequest[] = [];
    const edits = [
      ["design/layout/header", "minimal"],
      ["design/layout/card", "overlay"],
      ["design/layout/productDetail", "classic"],
      ["design/fonts/display", "var(--font-fraunces)"],
      ["design/buttons/shape", "square"],
      ["design/buttons/primary", "outline"],
      ["design/page/width", "full"],
      ["design/shape/card", "0px"],
      ["design/typography/headingScale", "small"],
      ["pages/0/sections/0/config/variant", "split"],
    ].map(([path, value]) => ({
      path: `/definition/preset/${path}`,
      valueJson: JSON.stringify(value),
    }));
    const client: ThemeStudioModelClient = {
      provider: "fake",
      async generate(request, signal) {
        requests.push(request);
        if (Object.hasOwn(request.schema.properties ?? {}, "edits")) {
          expect(request.maxTokens).toBeUndefined();
          if (mode === "truncated")
            return { kind: "truncated", usage: ZERO_USAGE };
          if (mode === "refused")
            return { kind: "refused", category: null, usage: ZERO_USAGE };
          if (mode === "provider-error")
            return { kind: "error", code: "rate_limited", usage: ZERO_USAGE };
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              edits:
                mode === "improve"
                  ? edits
                  : mode === "palette"
                    ? [
                        {
                          path: "/definition/preset/design/palette/cream",
                          valueJson: '"#212121"',
                        },
                      ]
                    : mode === "copy"
                      ? [
                          {
                            path: "/definition/preset/brand/tagline",
                            valueJson: '"change copy"',
                          },
                        ]
                      : mode === "remove"
                        ? [{ path: edits[0].path, valueJson: " null " }]
                        : mode === "invalid"
                          ? [{ path: edits[0].path, valueJson: '"invented"' }]
                          : [],
              unrepairable: [],
            },
          };
        }
        return fake.generate(request, signal);
      },
    };
    const outcome = await generate(client, {
      ...input(),
      existingThemes: [
        {
          themeId: "old-variety",
          direction: null,
          fingerprint: themeFingerprint(original.package.definition),
        },
      ],
    });
    expect(requests).toHaveLength(3);
    expect(outcome.kind).toBe("version");
    if (outcome.kind !== "version") return;
    expect(outcome.distinctness?.repairAttempted).toBe(true);
    if (mode === "improve")
      expect(outcome.distinctness?.score).toBeGreaterThan(0.35);
    else {
      expect(outcome.distinctness?.status).toBe("similar");
      expect(outcome.package.definition.preset).toEqual(
        original.package.definition.preset,
      );
    }
  },
);

it("does not force novelty against reference designs or request another full generation", async () => {
  const original = await generate(createFakeModelClient(fakeInput));
  if (original.kind !== "version") throw new Error("Fixture failed");
  const fake = createFakeModelClient({ ...fakeInput, referenceCount: 1 });
  let calls = 0;
  const outcome = await generate(
    {
      provider: "fake",
      async generate(req, signal) {
        calls++;
        return fake.generate(req, signal);
      },
    },
    {
      ...input(),
      references: [{ base64: "UklGRg==", sha256: "a".repeat(64) }],
      existingThemes: [
        {
          themeId: "previous",
          direction: null,
          fingerprint: themeFingerprint(original.package.definition),
        },
      ],
    },
  );
  expect(outcome.kind).toBe("version");
  if (outcome.kind !== "version") return;
  expect(calls).toBe(2);
  expect(outcome.distinctness).toMatchObject({
    status: "reference-led",
    repairAttempted: false,
  });
});
