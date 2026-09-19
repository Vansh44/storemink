import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_DOCUMENT_PATH = join(
  process.cwd(),
  "docs",
  "mink-ai-image-prompt.md",
);
const START_MARKER = "<!-- MINK_IMAGE_PROMPT_START -->";
const END_MARKER = "<!-- MINK_IMAGE_PROMPT_END -->";
const SCENE_PLACEHOLDER = "{{scene_description}}";
const REFERENCE_PLACEHOLDER = "{{reference_guidance}}";

let productionTemplate: string | null = null;

export function renderMinkImagePrompt(
  sceneDescription: string,
  referenceGuidance: string,
): string {
  return getMinkImagePromptTemplate()
    .replace(SCENE_PLACEHOLDER, sceneDescription)
    .replace(REFERENCE_PLACEHOLDER, referenceGuidance);
}

export function getMinkImagePromptTemplate(): string {
  if (process.env.NODE_ENV === "production" && productionTemplate) {
    return productionTemplate;
  }
  const template = parseMinkImagePromptDocument(
    readFileSync(PROMPT_DOCUMENT_PATH, "utf8"),
  );
  if (process.env.NODE_ENV === "production") productionTemplate = template;
  return template;
}

export function parseMinkImagePromptDocument(document: string): string {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (
    start < 0 ||
    end < 0 ||
    end <= start ||
    document.indexOf(START_MARKER, start + START_MARKER.length) >= 0 ||
    document.indexOf(END_MARKER, end + END_MARKER.length) >= 0
  ) {
    throw new Error(
      "Mink image prompt document must contain exactly one ordered prompt marker pair.",
    );
  }
  const section = document
    .slice(start + START_MARKER.length, end)
    .trim()
    .replace(/\r\n/g, "\n");
  const fenced = section.match(/^```text\n([\s\S]*?)\n```$/);
  if (!fenced) {
    throw new Error(
      "Mink image prompt markers must contain exactly one text code fence.",
    );
  }
  const template = fenced[1];
  const found = template.match(/\{\{[^{}]+\}\}/g) ?? [];
  if (
    found.length !== 2 ||
    !found.includes(SCENE_PLACEHOLDER) ||
    !found.includes(REFERENCE_PLACEHOLDER) ||
    template.split(SCENE_PLACEHOLDER).length !== 2 ||
    template.split(REFERENCE_PLACEHOLDER).length !== 2
  ) {
    throw new Error(
      `Mink image prompt must contain ${SCENE_PLACEHOLDER} and ${REFERENCE_PLACEHOLDER} exactly once and no other placeholders.`,
    );
  }
  return template;
}
