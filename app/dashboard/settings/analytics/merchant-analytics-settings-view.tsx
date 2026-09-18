"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  saveMerchantAnalyticsSettings,
  type MerchantAnalyticsSettingsEditor,
} from "@/app/actions/merchant-analytics-settings";
import type { MerchantPixelSettings } from "@/lib/analytics/merchant-pixels";
import { Button } from "@/components/ui/button";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-slate-300"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {/*
        ★ `left-1` IS LOAD-BEARING, not decoration. An absolutely positioned
        box with `left: auto` falls back to its STATIC position, and the UA
        stylesheet sets `text-align: center` on <button> — which Tailwind's
        preflight does not reset. The knob is an empty out-of-flow inline, so
        its static position is the CENTRE of the 44px track (measured: 22px),
        not 0. Without an explicit `left` the knob sat right of centre when
        off and overflowed the track by 18px when on.
        Geometry: 44px track − 16px knob − 4px inset ⇒ travel is 20px.
      */}
      <span
        className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function IntegrationCard({
  kind,
  title,
  description,
  idLabel,
  placeholder,
  value,
  enabled,
  savedValue,
  savedEnabled,
  available,
  platformEnabled,
  plan,
  canManage,
  helpUrl,
  pending,
  onIdChange,
  onEnabledChange,
}: {
  kind: "ga4" | "meta";
  title: string;
  description: string;
  idLabel: string;
  placeholder: string;
  value: string;
  enabled: boolean;
  /** What is actually PERSISTED. The status line and the Active badge are
   *  statements about the server, so they must never be computed from the
   *  edited value — see the note on `status` below. */
  savedValue: string;
  savedEnabled: boolean;
  available: boolean;
  platformEnabled: boolean;
  plan: string;
  canManage: boolean;
  helpUrl: string;
  pending: boolean;
  onIdChange: (value: string) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const lockedByPlan = plan !== "pro";
  const disabled = !available || !canManage || pending;
  // ★★ DERIVED FROM THE SAVED SETTINGS, NEVER THE EDITED ONES. This read
  // `values`, so pasting an ID flipped the line to "Saved, but disabled" and
  // flicking the switch flipped it to "Enabled" — both claims about the
  // server, made about something that had never left the browser. A merchant
  // who believed them and refreshed lost the ID, which is exactly what was
  // reported. The word "Saved" has to mean saved.
  const status = savedEnabled
    ? "Enabled"
    : savedValue
      ? "Saved, but disabled"
      : "Not connected";
  const unsaved = value !== savedValue || enabled !== savedEnabled;

  return (
    <section className="dash-card">
      <div className="dash-card-header items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="dash-card-title">{title}</h2>
            <span className="dash-badge-amber rounded-full px-2 py-0.5 text-[11px] font-semibold">
              Pro
            </span>
            {savedEnabled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                <Check className="h-3 w-3" /> Active
              </span>
            ) : null}
            {unsaved ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unsaved
              </span>
            ) : null}
          </div>
          <p className="dash-card-sub mt-1 max-w-2xl">{description}</p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled || !value}
          label={`${enabled ? "Disable" : "Enable"} ${title}`}
          onChange={onEnabledChange}
        />
      </div>
      <div className="dash-card-body space-y-4">
        {!available ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {lockedByPlan
                ? `${title} requires the Pro plan.`
                : !platformEnabled
                  ? `StoreMink has not enabled ${title} for merchants yet.`
                  : `${title} is currently unavailable.`}
            </span>
          </div>
        ) : null}

        <label className="block max-w-xl">
          <span className="mb-1.5 block text-sm font-semibold text-slate-900">
            {idLabel}
          </span>
          <input
            className="dash-input w-full font-mono uppercase"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode={kind === "meta" ? "numeric" : "text"}
            onChange={(event) => onIdChange(event.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
          <span className="text-slate-500">
            Status: {status}
            {unsaved ? (
              <span className="ml-1 font-semibold text-amber-700">
                — unsaved changes below
              </span>
            ) : null}
          </span>
          <Link
            href={helpUrl}
            target="_blank"
            className="inline-flex items-center gap-1 font-semibold text-violet-700 hover:underline"
          >
            Setup guide <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function MerchantAnalyticsSettingsView({
  initial,
  ga4HelpUrl,
  metaHelpUrl,
}: {
  initial: MerchantAnalyticsSettingsEditor;
  ga4HelpUrl: string;
  metaHelpUrl: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial.settings);
  const [values, setValues] = useState(initial.settings);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  // Nothing on this page autosaves, so a reload discards everything typed —
  // the loss that was reported here.
  useUnsavedChangesWarning(dirty);

  function update(patch: Partial<MerchantPixelSettings>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveMerchantAnalyticsSettings(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setValues(result.settings);
      setSaved(result.settings);
      toast.success("Analytics tracking settings saved.");
      router.refresh();
    });
  }

  return (
    <div className="max-w-4xl space-y-5 p-6">
      <header>
        <h1 className="text-[22px] font-semibold text-slate-950">
          Analytics tracking
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Connect your own Google Analytics and Meta accounts. StoreMink loads
          optional tracking only after the visitor makes a privacy choice.
        </p>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <strong>Consent is enforced automatically.</strong>
          <p className="mt-1 text-violet-800">
            GA4 waits for analytics consent. Meta Pixel waits for marketing
            consent. Rejecting optional tracking keeps both scripts unloaded.
          </p>
        </div>
      </div>

      <IntegrationCard
        kind="ga4"
        title="Google Analytics 4"
        description="Send consenting storefront page views to your GA4 web data stream."
        idLabel="GA4 Measurement ID"
        placeholder="G-XXXXXXXXXX"
        value={values.ga4MeasurementId}
        enabled={values.ga4Enabled}
        savedValue={saved.ga4MeasurementId}
        savedEnabled={saved.ga4Enabled}
        available={initial.ga4Available}
        platformEnabled={initial.ga4PlatformEnabled}
        plan={initial.plan}
        canManage={initial.canManage}
        helpUrl={ga4HelpUrl}
        pending={pending}
        onIdChange={(value) =>
          update({
            ga4MeasurementId: value.toUpperCase(),
            ...(value.trim() ? {} : { ga4Enabled: false }),
          })
        }
        onEnabledChange={(ga4Enabled) => update({ ga4Enabled })}
      />

      <IntegrationCard
        kind="meta"
        title="Meta Pixel"
        description="Send consenting storefront page views to your Meta web dataset."
        idLabel="Meta Pixel ID"
        placeholder="123456789012345"
        value={values.metaPixelId}
        enabled={values.metaPixelEnabled}
        savedValue={saved.metaPixelId}
        savedEnabled={saved.metaPixelEnabled}
        available={initial.metaAvailable}
        platformEnabled={initial.metaPlatformEnabled}
        plan={initial.plan}
        canManage={initial.canManage}
        helpUrl={metaHelpUrl}
        pending={pending}
        onIdChange={(value) =>
          update({
            metaPixelId: value.replace(/\D/g, ""),
            ...(value.trim() ? {} : { metaPixelEnabled: false }),
          })
        }
        onEnabledChange={(metaPixelEnabled) => update({ metaPixelEnabled })}
      />

      {/* ★ STICKY. The Save button sat below the fold under two tall cards, so
          a merchant who had typed an ID could not see that anything was left
          to do — the status line told them it was already saved and the only
          contradicting control was off screen. */}
      <div className="sticky bottom-0 -mx-6 flex items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
        {dirty && initial.canManage ? (
          <span className="mr-auto inline-flex items-center gap-2 text-sm font-semibold text-amber-700">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            Unsaved changes
          </span>
        ) : null}
        {!initial.canManage ? (
          <p className="text-sm text-slate-500">
            You can view these settings but cannot change them.
          </p>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={!dirty || pending}
              onClick={() => setValues(saved)}
            >
              Discard
            </Button>
            <Button disabled={!dirty || pending} onClick={save}>
              {pending ? "Saving…" : "Save tracking settings"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
