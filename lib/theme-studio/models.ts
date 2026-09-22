import modelRegistry from "./models.json";

// Theme Studio models are deliberately isolated from merchant-facing Mink.
// The browser receives only the stable key and label; the server resolves the
// provider id from this code-owned registry. No caller-supplied model string is
// ever forwarded to Vertex.

export const THEME_STUDIO_MODEL_KEYS = [
  "opus-5",
  "opus-5.5",
  "fable-5",
] as const;

export type ThemeStudioModelKey = (typeof THEME_STUDIO_MODEL_KEYS)[number];

interface ThemeStudioModelRecord {
  key: ThemeStudioModelKey;
  label: string;
  providerModel: string;
  envOverride: string;
  purpose: string;
}

const records = modelRegistry as ThemeStudioModelRecord[];

function assertRegistry(): readonly ThemeStudioModelRecord[] {
  const expected = new Set<string>(THEME_STUDIO_MODEL_KEYS);
  const seen = new Set<string>();
  for (const record of records) {
    if (!expected.has(record.key)) {
      throw new Error(`Unknown Theme Studio model key: ${record.key}`);
    }
    if (seen.has(record.key)) {
      throw new Error(`Duplicate Theme Studio model key: ${record.key}`);
    }
    if (
      !record.label.trim() ||
      !record.providerModel.trim() ||
      !record.envOverride.trim() ||
      !record.purpose.trim()
    ) {
      throw new Error(`Incomplete Theme Studio model record: ${record.key}`);
    }
    seen.add(record.key);
  }
  for (const key of expected) {
    if (!seen.has(key))
      throw new Error(`Missing Theme Studio model key: ${key}`);
  }
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

export const THEME_STUDIO_MODELS = assertRegistry();

export function parseThemeStudioModelKey(
  input: unknown,
): ThemeStudioModelKey | null {
  return typeof input === "string" &&
    THEME_STUDIO_MODEL_KEYS.includes(input as ThemeStudioModelKey)
    ? (input as ThemeStudioModelKey)
    : null;
}

export function resolveThemeStudioModel(
  key: ThemeStudioModelKey,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeStudioModelRecord {
  const record = THEME_STUDIO_MODELS.find((candidate) => candidate.key === key);
  if (!record) throw new Error(`Theme Studio model is not allowlisted: ${key}`);
  const overridden = env[record.envOverride]?.trim();
  if (
    overridden &&
    !isAllowedProviderVersion(record.providerModel, overridden)
  ) {
    throw new Error(
      `${record.envOverride} must stay within the ${record.providerModel} model family.`,
    );
  }
  return {
    ...record,
    providerModel: overridden || record.providerModel,
  };
}

function isAllowedProviderVersion(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}@`);
}

export function themeStudioModelOptions(): readonly {
  key: ThemeStudioModelKey;
  label: string;
  purpose: string;
}[] {
  return THEME_STUDIO_MODELS.map(({ key, label, purpose }) => ({
    key,
    label,
    purpose,
  }));
}
