"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  MAX_OPTIONS,
  MAX_OPTION_VALUES,
  guessSwatch,
  normalizeOptions,
  type ProductOption,
} from "@/lib/products/options";

// ---------------------------------------------------------------------------
// The option axes of a product — "Size: S, M, L", "Colour: Black, Tan" — as a
// merchant edits them. It only edits the OPTIONS; the parent regenerates the
// variant rows from them (lib/products/options.ts `generateVariantRows`), so
// an existing row keeps its id, prices and stock whenever its combination
// survives the edit.
//
// ★ Values are TAGS, added on Enter or comma, never a comma-separated text
//   box: a half-typed "Blac" must not briefly become a variant.
// ★ A colour axis can show swatches. The picker only stores a hex for a value
//   the option actually has, the same rule the save enforces.
// ---------------------------------------------------------------------------

const fieldClass =
  "w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-sm text-[#1f2937] outline-none transition placeholder:text-[#9ca3af] focus:border-[#4f46e5] focus:ring-2 focus:ring-[#4f46e5]/15";

export function OptionsEditor({
  options,
  onChange,
  legacyNames,
}: {
  options: ProductOption[];
  onChange: (next: ProductOption[]) => void;
  /** Existing plain variant names, offered as the first option's values. */
  legacyNames: string[];
}) {
  const check = normalizeOptions(options);
  const error = "error" in check ? check.error : null;

  const update = (i: number, patch: Partial<ProductOption>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const addOption = () => {
    const first = options.length === 0;
    // Turning plain variants ("S", "M", "L") into an option keeps those rows:
    // their names become the option's values.
    const values = first
      ? [...new Set(legacyNames.map((n) => n.trim()).filter(Boolean))]
          .filter((n) => !n.includes("/"))
          .slice(0, MAX_OPTION_VALUES)
      : [];
    onChange([...options, { name: "", values }]);
  };

  return (
    <div className="space-y-3">
      {options.map((option, i) => (
        <OptionRow
          key={i}
          option={option}
          index={i}
          onChange={(patch) => update(i, patch)}
          onRemove={() => onChange(options.filter((_, j) => j !== i))}
        />
      ))}

      {error && options.length > 0 && (
        <p role="alert" className="text-xs text-[#b45309]">
          {error} Variants update once this is fixed.
        </p>
      )}

      {options.length < MAX_OPTIONS && (
        <button
          type="button"
          onClick={addOption}
          className="flex items-center gap-1 rounded-md border border-[#d1d5db] bg-white px-2.5 py-1 text-xs font-medium text-[#374151] hover:bg-[#f3f4f6]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {options.length === 0
            ? "Add options like size or colour"
            : "Add another option"}
        </button>
      )}
    </div>
  );
}

function OptionRow({
  option,
  index,
  onChange,
  onRemove,
}: {
  option: ProductOption;
  index: number;
  onChange: (patch: Partial<ProductOption>) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const swatchesOn = option.swatches !== undefined;

  const commit = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const lower = new Set(option.values.map((v) => v.toLowerCase()));
    const added = parts.filter((p) => {
      if (lower.has(p.toLowerCase())) return false;
      lower.add(p.toLowerCase());
      return true;
    });
    if (added.length > 0)
      onChange({
        values: [...option.values, ...added],
        // A new value on a swatch option starts with a colour guessed from
        // its name, so turning swatches on never leaves a value blank.
        ...(option.swatches
          ? {
              swatches: {
                ...option.swatches,
                ...Object.fromEntries(added.map((v) => [v, guessSwatch(v)])),
              },
            }
          : {}),
      });
    setDraft("");
  };

  const removeValue = (value: string) => {
    const swatches = option.swatches ? { ...option.swatches } : undefined;
    if (swatches) delete swatches[value];
    onChange({
      values: option.values.filter((v) => v !== value),
      ...(swatches ? { swatches } : {}),
    });
  };

  const setSwatch = (value: string, hex: string) =>
    onChange({ swatches: { ...(option.swatches ?? {}), [value]: hex } });

  const nameId = `option-${index}-name`;
  const valuesId = `option-${index}-values`;

  return (
    <div className="space-y-2 rounded-lg border border-[#e5e7eb] bg-white p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <label
            htmlFor={nameId}
            className="mb-1 block text-[12px] font-medium text-[#374151]"
          >
            Option name
          </label>
          <input
            id={nameId}
            className={fieldClass}
            value={option.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={index === 0 ? "Size" : "Colour"}
            maxLength={40}
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="mt-6 rounded-md p-2 text-[#9ca3af] hover:bg-[#fef2f2] hover:text-[#dc2626]"
          aria-label={`Remove option ${option.name || index + 1}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div>
        <label
          htmlFor={valuesId}
          className="mb-1 block text-[12px] font-medium text-[#374151]"
        >
          Values
        </label>
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#d1d5db] bg-white p-1.5">
          {option.values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-md bg-[#f3f4f6] py-0.5 pr-1 pl-1.5 text-xs text-[#1f2937]"
            >
              {swatchesOn && (
                <input
                  type="color"
                  aria-label={`Swatch colour for ${value}`}
                  value={option.swatches?.[value] ?? guessSwatch(value)}
                  onChange={(e) => setSwatch(value, e.target.value)}
                  className="h-4 w-4 cursor-pointer rounded-full border-0 bg-transparent p-0"
                />
              )}
              {value}
              <button
                type="button"
                onClick={() => removeValue(value)}
                className="rounded p-0.5 text-[#9ca3af] hover:text-[#dc2626]"
                aria-label={`Remove ${value}`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          <input
            id={valuesId}
            className="min-w-[8rem] flex-1 border-0 px-1 py-1 text-sm outline-none placeholder:text-[#9ca3af]"
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              if (v.includes(",")) commit(v);
              else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(draft);
              } else if (
                e.key === "Backspace" &&
                draft === "" &&
                option.values.length > 0
              ) {
                removeValue(option.values[option.values.length - 1]);
              }
            }}
            onBlur={() => commit(draft)}
            placeholder={
              option.values.length === 0
                ? "Type a value and press Enter"
                : "Add value"
            }
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-[#374151]">
        <input
          type="checkbox"
          checked={swatchesOn}
          onChange={(e) =>
            onChange({
              swatches: e.target.checked
                ? Object.fromEntries(
                    option.values.map((v) => [v, guessSwatch(v)]),
                  )
                : undefined,
            })
          }
        />
        Show as colour swatches on the storefront
      </label>
    </div>
  );
}
