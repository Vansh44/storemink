"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createThemeStudioProjectAction } from "@/app/actions/theme-studio-actions";
import {
  INDUSTRY_LABELS,
  type ThemeCatalogSize,
  type ThemeFeature,
  type ThemeIndustry,
} from "@/lib/themes/meta";
import type { ThemeStudioModelKey } from "@/lib/theme-studio/models";

// The intake form. It collects only what the server re-validates: a model KEY
// from the server-provided list (never a provider id), vocabularies from the
// Phase 0 contract, and a bounded brief. Reference images are added on the
// project page, where they can be reviewed before anything is queued.

const SIZE_LABELS: Record<ThemeCatalogSize, string> = {
  "one-product": "One product",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

function humanize(value: string): string {
  const text = value.replace(/-/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function Toggle<T extends string>({
  options,
  selected,
  onChange,
  label,
}: {
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  label: (value: T) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((value) => {
        const on = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onChange(
                on ? selected.filter((v) => v !== value) : [...selected, value],
              )
            }
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              on
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            {label(value)}
          </button>
        );
      })}
    </div>
  );
}

export function NewProjectForm({
  models,
  baseThemes,
  industries,
  catalogSizes,
  features,
  briefMax,
}: {
  models: { key: ThemeStudioModelKey; label: string; purpose: string }[];
  baseThemes: { id: string; name: string }[];
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  features: ThemeFeature[];
  briefMax: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [themeId, setThemeId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [brief, setBrief] = useState("");
  const [chosenIndustries, setIndustries] = useState<ThemeIndustry[]>([]);
  const [sizes, setSizes] = useState<ThemeCatalogSize[]>(["small"]);
  const [chosenFeatures, setFeatures] = useState<ThemeFeature[]>([]);
  const [baseThemeId, setBaseThemeId] = useState("");
  const [modelKey, setModelKey] = useState<ThemeStudioModelKey>(
    models[0]?.key ?? "opus-5",
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createThemeStudioProjectAction({
        name,
        themeId,
        brief,
        industries: chosenIndustries,
        catalogSizes: sizes,
        requiredFeatures: chosenFeatures,
        baseThemeId: baseThemeId || null,
        modelKey,
      });
      if (!result.ok || !result.id) {
        setError(result.error ?? "The project couldn't be created.");
        return;
      }
      router.push(`/dashboard/themes/studio/${result.id}`);
    });
  }

  const field =
    "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none";

  return (
    <form
      onSubmit={submit}
      className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">
          Theme name
          <input
            className={field}
            value={name}
            maxLength={100}
            required
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setThemeId(slugify(e.target.value));
            }}
          />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Theme id
          <input
            className={`${field} font-mono`}
            value={themeId}
            maxLength={80}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            onChange={(e) => {
              setIdTouched(true);
              setThemeId(e.target.value.toLowerCase());
            }}
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            Permanent. Lowercase letters, numbers and hyphens.
          </span>
        </label>
      </div>

      <label className="block text-sm font-medium text-slate-800">
        Design brief
        <textarea
          className={`${field} min-h-40`}
          value={brief}
          maxLength={briefMax}
          required
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Who the store sells to, what should feel distinctive, which pages matter most, and what to avoid."
        />
        <span className="mt-1 block text-xs font-normal text-slate-500">
          {brief.length.toLocaleString("en-IN")} /{" "}
          {briefMax.toLocaleString("en-IN")} characters. Reference images are
          inspiration only: StoreMink extracts layout and visual direction, and
          never copies logos, text, product photos or artwork.
        </span>
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          Industries (1–5)
        </legend>
        <div className="mt-2">
          <Toggle
            options={industries}
            selected={chosenIndustries}
            onChange={(next) => setIndustries(next.slice(0, 5))}
            label={(v) => INDUSTRY_LABELS[v] ?? humanize(v)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          Catalogue sizes
        </legend>
        <div className="mt-2">
          <Toggle
            options={catalogSizes}
            selected={sizes}
            onChange={setSizes}
            label={(v) => SIZE_LABELS[v] ?? humanize(v)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          Required features
        </legend>
        <div className="mt-2">
          <Toggle
            options={features}
            selected={chosenFeatures}
            onChange={setFeatures}
            label={humanize}
          />
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">
          Base theme (optional)
          <select
            className={field}
            value={baseThemeId}
            onChange={(e) => setBaseThemeId(e.target.value)}
          >
            <option value="">None</option>
            {baseThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Model
          <select
            className={field}
            value={modelKey}
            onChange={(e) => setModelKey(e.target.value as ThemeStudioModelKey)}
          >
            {models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs font-normal text-slate-500">
            {models.find((m) => m.key === modelKey)?.purpose}
          </span>
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create project
        </button>
      </div>
    </form>
  );
}
