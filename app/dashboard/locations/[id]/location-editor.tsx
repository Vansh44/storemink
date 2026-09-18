"use client";

// One location: its details, and what it is ALLOWED to do.
//
// The capability checkboxes are the point of this screen. Two rules are shown
// inline rather than as a bare disabled box, because a checkbox that refuses to
// tick with no explanation reads as a bug:
//
//   * pickup and returns need POS — someone has to hand the goods over
//   * the last location fulfilling online orders can't be switched off
//
// Both are re-enforced server-side in saveLocationCapabilities. A disabled
// checkbox is not a permission.

import { useState, useTransition } from "react";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Boxes, Loader2, Lock } from "lucide-react";
import {
  saveLocationCapabilities,
  updateLocation,
  type LocationWithCapabilities,
} from "@/app/actions/location-actions";
import {
  CAPABILITY_REGISTRY,
  LOCATION_CAPABILITIES,
  LOCATION_TYPES,
  LOCATION_TYPE_LABEL,
  applyCapability,
  type CapabilityMap,
  type LocationCapability,
} from "@/lib/locations/capabilities";
import { planAllows, type Plan } from "@/lib/plans";

const LBL = "mb-1 block text-xs font-medium text-[#5b6472]";
const INPUT =
  "w-full rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2 text-sm text-[#111827] outline-none transition-colors placeholder:text-[#9ca3af] focus:border-[#111827] disabled:opacity-60";

export function LocationEditor({
  location,
  plan,
  canManage,
  isOnlyFulfilmentLocation,
  pickupOfferedAtCheckout,
}: {
  location: LocationWithCapabilities;
  plan: Plan;
  canManage: boolean;
  isOnlyFulfilmentLocation: boolean;
  /** The STORE-level switch. Ticking a location's pickup box does nothing
   *  until this is on, and a capability that silently does nothing reads as a
   *  bug — the same reason the blocked-capability reasons are shown inline. */
  pickupOfferedAtCheckout: boolean;
}) {
  const router = useRouter();
  const [caps, setCaps] = useState<CapabilityMap>(location.capabilities);
  const [pending, start] = useTransition();

  const dirty = LOCATION_CAPABILITIES.some(
    (c) => caps[c] !== location.capabilities[c],
  );

  useUnsavedChangesWarning(dirty);

  // The shop's street address. Nothing collected this before, so a shopper was
  // told to collect from a named shop and never told where it was.
  // Every editable field of the location lives here. The list page's pencil
  // links straight to this page (the products convention: edit is a full page,
  // only "New" is a dialog), so if the name isn't on it, it cannot be changed
  // at all — which is exactly what happened.
  const addr = (location.address ?? {}) as Record<string, string>;
  const initial = {
    name: location.name,
    type: location.type as string,
    line1: addr.line1 ?? "",
    line2: addr.line2 ?? "",
    city: addr.city ?? "",
    state: addr.state ?? "",
    postalCode: addr.postalCode ?? "",
    gstin: location.gstin ?? "",
    stateCode: location.stateCode ?? "",
    receiptPrefix: location.receiptPrefix ?? "",
  };
  const [form, setForm] = useState(initial);
  const [savingAddr, setSavingAddr] = useState(false);
  const set = (k: keyof typeof initial, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const addrDirty = (Object.keys(initial) as (keyof typeof initial)[]).some(
    (k) => form[k] !== initial[k],
  );

  // ★ The details form, not the capability switches, is where a merchant types
  // the shop's address — the half of this screen with something to lose.
  useUnsavedChangesWarning(addrDirty);

  const saveDetails = async () => {
    if (!form.name.trim()) {
      toast.error("Give the location a name.");
      return;
    }
    setSavingAddr(true);
    // updateLocation replaces the whole row, so every field goes together —
    // sending a partial one would blank the rest, and a missing type silently
    // turns a warehouse into a shop.
    const res = await updateLocation(location.id, {
      name: form.name.trim(),
      type: form.type,
      gstin: form.gstin.trim() || null,
      stateCode: form.stateCode.trim() || null,
      receiptPrefix: form.receiptPrefix.trim() || null,
      address: {
        line1: form.line1.trim(),
        line2: form.line2.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        postalCode: form.postalCode.trim(),
      },
    });
    setSavingAddr(false);
    if (res.error) toast.error(res.error);
    else {
      toast.success("Location saved");
      router.refresh();
    }
  };

  /** Why this capability can't be changed right now, or null. */
  const blockedReason = (cap: LocationCapability): string | null => {
    const def = CAPABILITY_REGISTRY[cap];
    if (def.minPlan && !planAllows(plan, def.minPlan)) {
      return `Available on the ${def.minPlan} plan.`;
    }
    const missing = (def.requires ?? []).filter((d) => !caps[d]);
    if (missing.length > 0) {
      return `Turn on ${missing.map((m) => CAPABILITY_REGISTRY[m].label).join(" and ")} first.`;
    }
    if (
      cap === "online_fulfil" &&
      caps.online_fulfil &&
      isOnlyFulfilmentLocation
    ) {
      return "This is the only location that fulfils online orders.";
    }
    return null;
  };

  const toggle = (cap: LocationCapability, next: boolean) =>
    // Cascade a switch-off to whatever depended on it, so the boxes never
    // disagree with what the server will store.
    setCaps((c) => applyCapability(c, cap, next));

  const save = () =>
    start(async () => {
      const res = await saveLocationCapabilities(location.id, caps);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Capabilities saved");
      router.refresh();
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header flex items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/locations"
            className="mb-2 inline-flex items-center gap-1.5 text-sm text-[#5b6472] transition-colors hover:text-[#111827]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Locations
          </Link>
          <h1 className="text-xl font-semibold text-[#111827]">
            {location.name}
          </h1>
          <p className="mt-1 text-sm text-[#5b6472]">
            {LOCATION_TYPE_LABEL[location.type] ?? location.type}
            {location.isDefault && " · Main location"}
          </p>
        </div>
        <Link
          href={`/dashboard/inventory?location=${location.id}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#111827] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <Boxes className="h-4 w-4" />
          View inventory
        </Link>
      </header>

      <section className="mt-5 max-w-2xl rounded-xl border border-[#e5e5e5] bg-white p-5">
        <h2 className="font-semibold text-[#111827]">Details</h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          The name staff see, and the address shown to shoppers choosing where
          to collect.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="loc-name" className={LBL}>
              Name
            </label>
            <input
              id="loc-name"
              value={form.name}
              disabled={!canManage}
              onChange={(e) => set("name", e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="loc-type" className={LBL}>
              Type
            </label>
            <select
              id="loc-type"
              value={form.type}
              disabled={!canManage}
              onChange={(e) => set("type", e.target.value)}
              className={INPUT}
            >
              {LOCATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LOCATION_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>

          {(
            [
              [
                "line1",
                "House / flat number and street address",
                "sm:col-span-2",
              ],
              [
                "line2",
                "Area, landmark, unit or floor (optional)",
                "sm:col-span-2",
              ],
              ["city", "City", ""],
              ["state", "State", ""],
              ["postalCode", "Postcode", ""],
            ] as const
          ).map(([key, label, span]) => (
            <div key={key} className={span}>
              <label htmlFor={`loc-${key}`} className={LBL}>
                {label}
              </label>
              <input
                id={`loc-${key}`}
                value={form[key]}
                disabled={!canManage}
                onChange={(e) => set(key, e.target.value)}
                className={INPUT}
              />
            </div>
          ))}
        </div>

        <div className="mt-5 border-t border-[#f0f0f0] pt-4">
          <h3 className="text-sm font-semibold text-[#111827]">
            Tax &amp; receipts
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(
              [
                ["gstin", "GSTIN"],
                ["stateCode", "GST state code"],
                ["receiptPrefix", "Receipt prefix"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label htmlFor={`loc-${key}`} className={LBL}>
                  {label}
                </label>
                <input
                  id={`loc-${key}`}
                  value={form[key]}
                  disabled={!canManage}
                  onChange={(e) => set(key, e.target.value)}
                  className={INPUT}
                />
              </div>
            ))}
          </div>
        </div>

        {canManage && (
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={!addrDirty || savingAddr}
              onClick={() => setForm(initial)}
              className="rounded-lg border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#5b6472] transition-colors hover:bg-[#111827]/5 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!addrDirty || savingAddr}
              onClick={saveDetails}
              className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {savingAddr && <Loader2 className="h-4 w-4 animate-spin" />}
              Save details
            </button>
          </div>
        )}
      </section>

      <section className="mt-5 max-w-2xl rounded-xl border border-[#e5e5e5] bg-white p-5">
        <h2 className="font-semibold text-[#111827]">Capabilities</h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          What this location is allowed to do.
        </p>

        <div className="mt-4 space-y-3">
          {LOCATION_CAPABILITIES.map((cap) => {
            const def = CAPABILITY_REGISTRY[cap];
            const reason = blockedReason(cap);
            // A reason blocks turning it ON; the "only fulfilment location"
            // reason blocks turning it OFF. Both are locks.
            const locked = !canManage || reason !== null;
            return (
              <label
                key={cap}
                className={`flex gap-3 rounded-lg border border-[#e5e5e5] p-3 ${
                  locked
                    ? "opacity-70"
                    : "cursor-pointer hover:bg-[#111827]/[0.02]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={caps[cap]}
                  disabled={locked}
                  onChange={(e) => toggle(cap, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#111827]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-[#111827]">
                    {def.label}
                    {def.minPlan && !planAllows(plan, def.minPlan) && (
                      <Lock
                        className="h-3 w-3 text-[#9aa1ab]"
                        strokeWidth={2}
                      />
                    )}
                  </span>
                  <span className="block text-xs text-[#5b6472]">
                    {def.description}
                  </span>
                  {reason && (
                    <span className="mt-1 block text-xs font-medium text-[#9aa1ab]">
                      {reason}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {caps.pickup && !pickupOfferedAtCheckout && (
          <p className="mt-3 rounded-lg border border-[#f0e2c0] bg-[#fdf8ec] px-3 py-2.5 text-xs text-[#8a6210]">
            This location can hand orders over, but pickup isn&apos;t offered at
            checkout yet.{" "}
            <Link
              href="/dashboard/locations/fulfilment"
              className="font-semibold underline underline-offset-2"
            >
              Turn it on in Online fulfilment &amp; pickup
            </Link>
            .
          </p>
        )}

        {canManage && (
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() => setCaps(location.capabilities)}
              className="rounded-lg border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#5b6472] transition-colors hover:bg-[#111827]/5 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={save}
              className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save capabilities
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
