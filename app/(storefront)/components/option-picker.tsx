"use client";

import {
  selectValue,
  valueStates,
  type PickableVariant,
  type ProductOption,
} from "@/lib/products/options";

// ---------------------------------------------------------------------------
// One row of choices per option axis — "Size: S M L", "Colour: ● ● ●" — shared
// by the classic PDP, the grocery PDP and the quick-add dialog, so a product
// is chosen the same way wherever a shopper meets it.
//
// ★ It never selects a VALUE, only a VARIANT. Picking "L" asks
//   `selectValue` for the variant to move to, which keeps as many of the other
//   picks as it can and never lands on a combination that does not exist — so
//   the page is always showing a real, priced, stocked (or honestly sold-out)
//   SKU, and the cart can never receive a half-chosen one.
// ★ A combination that does not exist is struck through and still clickable:
//   "L" with "Black" chosen moves to "L / Tan" rather than refusing, because
//   hiding a size a shop sells in another colour is how shoppers conclude it
//   is not stocked at all. A sold-out one is marked and SELECTS exactly, so
//   the page says "Sold out" about the thing they asked for rather than
//   quietly changing a pick they did not touch.
// ---------------------------------------------------------------------------

export function OptionPicker<V extends PickableVariant>({
  options,
  variants,
  selectedId,
  onSelect,
}: {
  options: readonly ProductOption[];
  variants: readonly V[];
  selectedId: string | null;
  onSelect: (variant: V) => void;
}) {
  const current = variants.find((v) => v.id === selectedId) ?? variants[0];
  const selected = current?.option_values ?? [];

  return (
    <div className="sm-opts">
      {options.map((option, axis) => {
        const states = valueStates(options, variants, selected, axis);
        const swatches = option.swatches;
        const chosen = selected[axis] ?? "";
        return (
          <fieldset key={option.name} className="sm-opt">
            <legend className="sm-opt-legend">
              {option.name}
              {chosen && (
                <span className="sm-opt-chosen">
                  : <span>{chosen}</span>
                </span>
              )}
            </legend>
            <div className="sm-opt-values">
              {states.map((state) => {
                const active = state.value === chosen;
                const unavailable = !state.available;
                const swatch = swatches?.[state.value];
                const label = `${option.name} ${state.value}${
                  !state.exists
                    ? ", not available with this selection"
                    : unavailable
                      ? ", sold out"
                      : ""
                }`;
                return (
                  <button
                    key={state.value}
                    type="button"
                    aria-pressed={active}
                    aria-label={label}
                    title={swatch ? state.value : undefined}
                    className={`sm-opt-value${swatch ? " is-swatch" : ""}${
                      active ? " is-active" : ""
                    }${unavailable ? " is-unavailable" : ""}`}
                    onClick={() => {
                      const next = selectValue(
                        variants,
                        selected,
                        axis,
                        state.value,
                      );
                      if (next && next.id !== current?.id) onSelect(next);
                    }}
                  >
                    {swatch ? (
                      <span
                        className="sm-opt-swatch"
                        style={{ backgroundColor: swatch }}
                        aria-hidden
                      />
                    ) : (
                      state.value
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
