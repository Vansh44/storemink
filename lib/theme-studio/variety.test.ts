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
import {
  runThemeGeneration,
  usableVarietyEdits,
  applyVarietyEdits,
  type GenerationInput,
} from "./pipeline";
import { STAGE_A_VARIETY_SCHEMA } from "./schemas";
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
  "mixed",
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
                  : mode === "mixed"
                    ? [
                        // One unusable edit must not discard the usable ones.
                        {
                          path: "/definition/preset/brand/tagline",
                          valueJson: '"change copy"',
                        },
                        { path: edits[0].path, valueJson: "not json" },
                        ...edits,
                      ]
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
    if (mode === "improve" || mode === "mixed") {
      expect(outcome.distinctness?.score).toBeGreaterThan(0.35);
      // The report keeps the score the correction started from.
      expect(outcome.distinctness?.beforeScore).toBe(0);
    } else {
      expect(outcome.distinctness?.status).toBe("similar");
      expect(outcome.package.definition.preset).toEqual(
        original.package.definition.preset,
      );
    }
  },
);

it("counts a different homepage structure as a major axis", () => {
  const a = structuredClone(studio);
  const fp = themeFingerprint(a);
  const context = [
    {
      themeId: "studio",
      direction: null,
      fingerprint: { ...fp, sections: ["ticker", "faq_accordion", "video"] },
    },
  ];
  expect(measureDistinctness(a, context).changedAxes).toBe(1);
  expect(
    measureDistinctness(a, [{ ...context[0], fingerprint: fp }]).changedAxes,
  ).toBe(0);
  expect(
    readDistinctnessReport({
      ...measureDistinctness(a, context),
      changedAxes: 7,
    }),
  ).not.toBeNull();
});

it("filters unusable variety edits and keeps required style choices non-null", async () => {
  const original = await generate(createFakeModelClient(fakeInput));
  if (original.kind !== "version") throw new Error("Fixture failed");
  const pkg = original.package;
  const settings = [
    { path: "/definition/preset/design/layout/card" },
    { path: "/definition/preset/design/buttons/shape" },
    { path: "/definition/preset/pages/0/sections/0/style/scheme" },
  ];
  expect(
    usableVarietyEdits(
      {
        edits: [
          { path: "/definition/preset/brand/tagline", valueJson: '"x"' },
          { path: settings[0].path, valueJson: '"overlay"' },
          { path: settings[0].path, valueJson: '"framed"' },
          { path: settings[1].path, valueJson: "null" },
          { path: settings[1].path, valueJson: "{" },
          { path: settings[2].path, valueJson: "null" },
          "not an edit",
        ],
      },
      settings,
      pkg,
    ),
  ).toEqual([
    { path: settings[0].path, valueJson: '"overlay"' },
    { path: settings[2].path, valueJson: "null" },
  ]);
  expect(usableVarietyEdits({}, settings, pkg)).toEqual([]);
  // Unsupported or non-scalar values are dropped per edit, not per batch.
  const card = { ...settings[0], choices: ["classic", "overlay", "framed"] };
  expect(
    usableVarietyEdits(
      {
        edits: [
          { path: card.path, valueJson: '"masonry"' },
          { path: settings[1].path, valueJson: '{"shape":"square"}' },
          { path: settings[1].path, valueJson: '"square"' },
        ],
      },
      [card, settings[1]],
      pkg,
    ),
  ).toEqual([{ path: settings[1].path, valueJson: '"square"' }]);
});

it("keeps the variety edits that validate when a whole-theme check refuses one", async () => {
  const original = await generate(createFakeModelClient(fakeInput));
  if (original.kind !== "version") throw new Error("Fixture failed");
  const design = "/definition/preset/design";
  const edits = [
    // Faux-bold at the current semibold headings; valid once the weight drops.
    {
      path: `${design}/fonts/display`,
      valueJson: '"var(--font-instrument-serif)"',
    },
    { path: `${design}/typography/headingWeight`, valueJson: '"regular"' },
    // Always refused: semibold button labels in a regular-only body face.
    {
      path: `${design}/fonts/body`,
      valueJson: '"var(--font-instrument-serif)"',
    },
    { path: `${design}/layout/card`, valueJson: '"overlay"' },
  ];
  const repaired = applyVarietyEdits(
    original.package,
    edits,
    original.intent.paletteFamily,
  );
  expect(repaired?.definition.preset.design).toMatchObject({
    fonts: {
      display: "var(--font-instrument-serif)",
      body: original.package.definition.preset.design.fonts.body,
    },
    typography: { headingWeight: "regular" },
    layout: { card: "overlay" },
  });
  expect(
    applyVarietyEdits(
      original.package,
      [edits[2]],
      original.intent.paletteFamily,
    ),
  ).toBeNull();
});

it("never keeps the supporting half of a refused change on its own", async () => {
  const original = await generate(createFakeModelClient(fakeInput));
  if (original.kind !== "version") throw new Error("Fixture failed");
  const design = "/definition/preset/design";
  const before = original.package.definition.preset.design;
  const weight = {
    path: `${design}/typography/headingWeight`,
    valueJson: '"regular"',
  };
  const body = {
    path: `${design}/fonts/body`,
    valueJson: '"var(--font-instrument-serif)"',
  };
  // The weight is valid alone but invisible to the fingerprint (a helper
  // only); the body face is refused even with it (button labels).
  const repaired = applyVarietyEdits(
    original.package,
    [weight, body, { path: `${design}/layout/card`, valueJson: '"overlay"' }],
    original.intent.paletteFamily,
  );
  expect(repaired?.definition.preset.design.layout?.card).toBe("overlay");
  expect(repaired?.definition.preset.design.typography?.headingWeight).toBe(
    before.typography?.headingWeight,
  );
  expect(repaired?.definition.preset.design.fonts.body).toBe(before.fonts.body);
  expect(
    applyVarietyEdits(
      original.package,
      [weight, body],
      original.intent.paletteFamily,
    ),
  ).toBeNull();
});

it("keeps a schema-1 revision on its original contract under the variety prompt", async () => {
  const legacy = await generate(createFakeModelClient(fakeInput), {
    ...input(),
    promptVersion: "theme-studio-v20",
  });
  if (legacy.kind !== "version") throw new Error("Fixture failed");
  expect(legacy.intent.schemaVersion).toBe(1);
  const fake = createFakeModelClient(fakeInput);
  const schemas: unknown[] = [];
  const outcome = await generate(
    {
      provider: "fake",
      async generate(request, signal) {
        if (request.stage === "intent") schemas.push(request.schema);
        return fake.generate(request, signal);
      },
    },
    {
      ...input(),
      messages: [{ kind: "revision", body: "Make it calmer." }],
      revision: { baseIntent: legacy.intent, basePackage: legacy.package },
    },
  );
  expect(schemas.length).toBeGreaterThan(0);
  expect(schemas).not.toContain(STAGE_A_VARIETY_SCHEMA);
  expect(outcome.kind).toBe("version");
  if (outcome.kind === "version") expect(outcome.intent.schemaVersion).toBe(1);
});

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
