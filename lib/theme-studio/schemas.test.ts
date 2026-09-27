import { describe, expect, it } from "vitest";
import {
  STAGE_A_ENVELOPE_SCHEMA,
  STAGE_B_DRAFT_SCHEMA,
  THEME_STUDIO_SECTION_TYPES,
} from "./schemas";

// Structured outputs reject a schema outright if any object is open, and
// silently cannot enforce length/numeric constraints. These walk every node so
// a schema edit that breaks either rule fails here instead of as a provider
// 400 on the first paid call.

const UNSUPPORTED = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "minItems",
  "maxItems",
];

function walk(node: unknown, path: string, problems: string[]) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${path}[${i}]`, problems));
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  for (const key of UNSUPPORTED)
    if (key in schema) problems.push(`${path} uses ${key}`);
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path} is open`);
    const props = Object.keys((schema.properties ?? {}) as object).sort();
    const required = [...((schema.required ?? []) as string[])].sort();
    if (JSON.stringify(props) !== JSON.stringify(required))
      problems.push(`${path} has optional properties`);
  }
  for (const [key, value] of Object.entries(schema))
    walk(value, `${path}.${key}`, problems);
}

describe("provider schemas", () => {
  it.each([
    ["stage A", STAGE_A_ENVELOPE_SCHEMA],
    ["stage B", STAGE_B_DRAFT_SCHEMA],
  ])("%s is closed and uses only supported keywords", (_name, schema) => {
    const problems: string[] = [];
    walk(schema, "$", problems);
    expect(problems).toEqual([]);
  });

  it("never offers executable code, blog feeds or video to the model", () => {
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("custom_code");
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("latest_blogs");
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("video");
    expect(JSON.stringify(STAGE_B_DRAFT_SCHEMA)).not.toContain('"custom_code"');
  });
});
