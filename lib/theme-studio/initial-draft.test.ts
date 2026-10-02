import { expect, it } from "vitest";
import type { ThemeIntent } from "./contracts";
import { expandInitialDraft } from "./initial-draft";

const intent = { visual: { density: "balanced" } } as ThemeIntent;
const draft = {
  composition: "editorial",
  navigation: "simple",
  design: { layoutOverridesJson: "{}" },
  pages: [],
  categories: [],
  products: [],
};

it("rejects malformed provider choices and unsupported overrides as repairable validation issues", () => {
  expect(
    expandInitialDraft({ ...draft, composition: { toString: null } }, intent)
      .issues,
  ).not.toHaveLength(0);
  expect(
    expandInitialDraft(
      {
        ...draft,
        design: { layoutOverridesJson: '{"customCss":"hide controls"}' },
      },
      intent,
    ).issues,
  ).toContain("Unsupported layout overrides: customCss.");
  const invalidSection = { type: { toString: null }, configJson: "{}" };
  const result = expandInitialDraft(
    { ...draft, pages: [{ sections: [invalidSection] }] },
    intent,
  );
  // Leave malformed section types for the ordinary compiler to reject.
  expect(
    (result.value as { pages: { sections: unknown[] }[] }).pages[0].sections[0],
  ).toEqual(invalidSection);
});

it("bounds option expansion before allocating a large catalogue and leaves the paid source response unchanged", () => {
  const raw = {
    ...draft,
    products: [
      {
        basePrice: 100,
        sellingPrice: 100,
        options: [
          {
            name: "Size",
            values: Array.from({ length: 101 }, (_, i) => String(i)),
          },
        ],
      },
    ],
  };
  const result = expandInitialDraft(raw, intent);
  expect(result.issues).toContain(
    "products[0] exceeds 100 option combinations.",
  );
  expect(
    (result.value as { products: { variants: unknown[] }[] }).products[0]
      .variants,
  ).toEqual([]);
  expect(raw.products[0]).not.toHaveProperty("variants");
  expect(raw.design).toHaveProperty("layoutOverridesJson", "{}");
});

it("fills mechanical settings without inventing story text, shipping promises or carousel slides", () => {
  const result = expandInitialDraft(
    {
      ...draft,
      pages: [
        {
          sections: ["media_text", "ticker", "usp_bar", "hero_carousel"].map(
            (type) => ({ type, configJson: "{}" }),
          ),
        },
      ],
    },
    intent,
  );
  const sections = (
    result.value as { pages: { sections: { configJson: string }[] }[] }
  ).pages[0].sections.map((s) => JSON.parse(s.configJson));
  expect(sections[0]).toMatchObject({
    media_position: "left",
    media_ratio: "portrait",
    heading: "",
    body: "",
    cta_href: "",
  });
  expect(sections[1]).toMatchObject({ speed: "medium", messages: [] });
  expect(sections[2]).toMatchObject({ items: [] });
  expect(sections[3]).toMatchObject({ slides: [], height: "medium" });
});

it("routes a misplaced rich-text body to the exact content field before paid artwork", () => {
  const story = {
    type: "rich_text",
    configJson: JSON.stringify({ body: "Original story" }),
  };
  const invalid = expandInitialDraft(
    { ...draft, pages: [{ sections: [story] }] },
    intent,
  );
  expect(invalid.issues).toContain(
    "pages[0].sections[0].configJson: rich_text requires a nonempty html string with original paragraphs. Put content in html, not body, text or markdown.",
  );
  const valid = expandInitialDraft(
    {
      ...draft,
      pages: [
        {
          sections: [
            {
              ...story,
              configJson: JSON.stringify({ html: "<p>Original story</p>" }),
            },
          ],
        },
      ],
    },
    intent,
  );
  expect(valid.issues).toEqual([]);
});
