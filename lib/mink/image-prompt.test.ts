import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMinkImagePromptTemplate,
  parseMinkImagePromptDocument,
  renderMinkImagePrompt,
} from "./image-prompt";

const DOCUMENT_PATH = join(process.cwd(), "docs", "mink-ai-image-prompt.md");

describe("Mink storefront image prompt document", () => {
  it("loads the marked Markdown template used by the provider call", () => {
    const template = getMinkImagePromptTemplate();
    expect(template).toContain("{{scene_description}}");
    expect(template).toContain("{{reference_guidance}}");
    for (const exclusion of ["headlines", "watermarks", "people"]) {
      expect(template).toContain(exclusion);
    }
    expect(template).toContain("preserve its form, proportions, colours");
  });

  it("renders the scene once without reinterpreting template-like merchant text", () => {
    const scene =
      "A warm still life whose handwritten brief says {{unknown_placeholder}}.";
    const rendered = renderMinkImagePrompt(
      scene,
      "Reference 1 is an authentic product image.",
    );
    expect(rendered.match(/A warm still life/g)).toHaveLength(1);
    expect(rendered).toContain("{{unknown_placeholder}}");
    expect(rendered).not.toContain("{{scene_description}}");
    expect(rendered).not.toContain("{{reference_guidance}}");
  });

  it("keeps the checked-in document parseable", () => {
    expect(() =>
      parseMinkImagePromptDocument(readFileSync(DOCUMENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("fails closed when markers, fences or placeholders drift", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkImagePromptDocument(
        document.replace("<!-- MINK_IMAGE_PROMPT_END -->", ""),
      ),
    ).toThrow(/marker pair/);
    expect(() =>
      parseMinkImagePromptDocument(document.replace("```text", "```md")),
    ).toThrow(/text code fence/);
    expect(() =>
      parseMinkImagePromptDocument(
        document.replace(
          "{{scene_description}}",
          "{{scene_description}} {{extra}}",
        ),
      ),
    ).toThrow(/no other placeholders/);
  });
});
