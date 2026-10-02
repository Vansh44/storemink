import "server-only";

import { contentFloorIssues } from "./compiler";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import { STAGE_B_DRAFT_SCHEMA } from "./schemas";
import {
  SECTION_SCHEMES,
  SCHEMELESS_SECTION_TYPES,
} from "@/lib/themes/schemes";
import { validateSections } from "@/lib/sections/registry";
import { HERO_HEIGHTS } from "@/lib/homepage/section-types";

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  anyOf?: JsonSchema[];
};
type Target = { path: string; current: unknown; choices?: readonly unknown[] };
const FORBIDDEN =
  /(^|_)(url|href|id|ids|source)$|^(__proto__|constructor|prototype|html)$/i;

/** Only scalar creative settings. No structure, images, URLs, products, routes,
 * engine, capabilities or release metadata can be written by a QA repair. */
export function repairTargets(pkg: ThemePackageV2): Target[] {
  const targets: Target[] = [];
  const walk = (value: unknown, path: string, schema?: JsonSchema) => {
    if ((value && typeof value === "object") || schema?.properties) {
      const keys = new Set([
        ...Object.keys(value ?? {}),
        ...Object.keys(schema?.properties ?? {}),
      ]);
      for (const key of keys) {
        if (FORBIDDEN.test(key)) continue;
        const child = (value as Record<string, unknown> | null)?.[key];
        const rule = schema?.properties?.[key];
        const resolved =
          rule?.anyOf?.find((s) => s.properties || s.enum) ?? rule;
        walk(child ?? null, `${path}/${key}`, resolved);
      }
    } else if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      // Unset object groups are deliberately not exposed as scalar settings.
      if (schema?.properties) return;
      targets.push({
        path,
        current: value,
        ...(schema?.enum ? { choices: schema.enum } : {}),
      });
    }
  };
  const preset = pkg.definition.preset;
  walk(
    preset.design,
    "/definition/preset/design",
    (STAGE_B_DRAFT_SCHEMA as JsonSchema).properties?.design,
  );
  walk(preset.brand, "/definition/preset/brand");
  preset.pages.forEach((page, p) =>
    page.sections.forEach((section, s) => {
      const root = `/definition/preset/pages/${p}/sections/${s}`;
      walk(section.config, `${root}/config`);
      if (
        section.type === "hero" ||
        section.type === "hero_carousel" ||
        section.type === "tile_grid"
      ) {
        const path = `${root}/config/height`;
        const target = targets.find((t) => t.path === path);
        const choices =
          section.type === "tile_grid"
            ? ["sm", "md", "lg"]
            : HERO_HEIGHTS.filter((h) => h !== "auto");
        if (target) target.choices = choices;
        else targets.push({ path, current: null, choices });
      }
      for (const [key, choices] of Object.entries({
        scheme: SECTION_SCHEMES,
        padding_y: ["sm", "md", "lg"],
        width: ["contained", "full"],
      })) {
        if (key === "scheme" && SCHEMELESS_SECTION_TYPES.includes(section.type))
          continue;
        targets.push({
          path: `${root}/style/${key}`,
          current: section.style?.[key as keyof typeof section.style] ?? null,
          choices,
        });
      }
    }),
  );
  return targets;
}

export const TARGETED_REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["edits", "unrepairable"],
  properties: {
    edits: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "valueJson"],
        properties: { path: { type: "string" }, valueJson: { type: "string" } },
      },
    },
    unrepairable: { type: "array", maxItems: 8, items: { type: "string" } },
  },
};

export function applyTargetedRepair(
  base: ThemePackageV2,
  raw: unknown,
):
  | { ok: true; package: ThemePackageV2; changed: string[] }
  | { ok: false; issues: string[]; unrepairable?: string[] } {
  const result = raw as {
    edits?: { path?: unknown; valueJson?: unknown }[];
    unrepairable?: unknown[];
  } | null;
  if (
    !result ||
    !Array.isArray(result.edits) ||
    result.edits.length > 24 ||
    !Array.isArray(result.unrepairable) ||
    result.unrepairable.length > 8 ||
    result.unrepairable.some((v) => typeof v !== "string" || v.length > 800)
  ) {
    return {
      ok: false,
      issues: ["Return at most 24 scalar edits and 8 unrepairable findings."],
    };
  }
  const allowed = new Map(repairTargets(base).map((t) => [t.path, t]));
  const candidate = structuredClone(base);
  const changed: string[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const edit of result.edits) {
    if (
      !edit ||
      typeof edit.path !== "string" ||
      typeof edit.valueJson !== "string" ||
      edit.valueJson.length > 8000 ||
      !allowed.has(edit.path) ||
      seen.has(edit.path)
    ) {
      issues.push(
        "Every edit must use a unique path from the supplied settings.",
      );
      continue;
    }
    seen.add(edit.path);
    const target = allowed.get(edit.path)!;
    let value: unknown;
    try {
      value = JSON.parse(edit.valueJson);
    } catch {
      issues.push(`${edit.path}: valueJson must be valid JSON.`);
      continue;
    }
    if (
      (value !== null &&
        !["string", "boolean", "number"].includes(typeof value)) ||
      (target.choices && value !== null && !target.choices.includes(value))
    ) {
      issues.push(
        `${edit.path}: use a scalar value and its supported choices.`,
      );
      continue;
    }
    const maxText = edit.path.endsWith("/heading")
      ? 160
      : edit.path.endsWith("/subheading")
        ? 300
        : edit.path.endsWith("/body")
          ? 3000
          : 1000;
    if (typeof value === "string" && value.length > maxText) {
      issues.push(`${edit.path}: text must fit within ${maxText} characters.`);
      continue;
    }
    if (value === target.current) continue;
    const keys = edit.path.slice(1).split("/");
    let parent = candidate as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key]) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    if (value === null) delete parent[keys.at(-1)!];
    else parent[keys.at(-1)!] = value;
    changed.push(edit.path);
  }
  if (issues.length) return { ok: false, issues };
  if (!changed.length)
    return {
      ok: false,
      issues: ["No supported setting changed."],
      unrepairable: result.unrepairable as string[],
    };
  const parsed = validateThemePackageV2(candidate);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const floors = contentFloorIssues(parsed.value);
  // Registry normalisation can turn an invented enum into a default without
  // raising a publish error. Never tell QA that such an ineffective edit ran.
  const rendered = structuredClone(parsed.value);
  for (const page of rendered.definition.preset.pages) {
    const validated = validateSections(page.sections, { mode: "publish" });
    if ("sections" in validated) page.sections = validated.sections;
  }
  const get = (root: unknown, path: string) =>
    path
      .slice(1)
      .split("/")
      .reduce(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        root,
      );
  for (const path of changed)
    if (get(parsed.value, path) !== get(rendered, path))
      floors.push(
        `${path}: the value is unsupported or normalised by the section renderer. Use a supported setting value.`,
      );
  return floors.length
    ? { ok: false, issues: floors }
    : { ok: true, package: parsed.value, changed };
}
