"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { savePlatformAnalyticsSettings } from "@/app/actions/platform-analytics-settings";
import {
  ANALYTICS_FEATURE_IDS,
  ANALYTICS_FEATURES,
  type AnalyticsFeatureId,
  type AnalyticsFeatureSettings,
} from "@/lib/analytics/features";

export function AnalyticsSettingsPanel({
  initialSettings,
  canManage,
}: {
  initialSettings: AnalyticsFeatureSettings;
  canManage: boolean;
}) {
  const [settings, setSettings] =
    useState<AnalyticsFeatureSettings>(initialSettings);
  const [saved, setSaved] = useState(initialSettings);
  const [pending, startTransition] = useTransition();
  const changed = ANALYTICS_FEATURE_IDS.some(
    (id) => settings[id] !== saved[id],
  );

  function toggle(id: AnalyticsFeatureId) {
    if (!canManage) return;
    setSettings((current) => ({ ...current, [id]: !current[id] }));
  }

  function save() {
    startTransition(async () => {
      const result = await savePlatformAnalyticsSettings(settings);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setSettings(result.settings);
      setSaved(result.settings);
      toast.success("Analytics availability updated.");
    });
  }

  return (
    <section className="stq-card">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Analytics modules</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--stq-muted)]">
            Turning off a shipped module removes its merchant entry points.
            Planned modules can be prepared here, but do nothing until their
            storefront or dashboard implementation is deployed.
          </p>
        </div>
        {!canManage ? (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            Read only
          </span>
        ) : null}
      </header>

      <div className="divide-y divide-[var(--stq-line)] rounded-xl border border-[var(--stq-line)]">
        {ANALYTICS_FEATURE_IDS.map((id) => {
          const feature = ANALYTICS_FEATURES[id];
          return (
            <div
              key={id}
              className="flex items-start justify-between gap-5 px-4 py-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-950">
                    {feature.label}
                  </h3>
                  {feature.minPlan === "pro" ? (
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                      Pro only
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                      All plans
                    </span>
                  )}
                  {feature.status === "planned" ? (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      Planned
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-[var(--stq-muted)]">
                  {feature.description}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings[id]}
                aria-label={`${settings[id] ? "Disable" : "Enable"} ${feature.label}`}
                disabled={!canManage || pending}
                onClick={() => toggle(id)}
                className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
                  settings[id] ? "bg-violet-600" : "bg-slate-300"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {/* `left-0.5` is required — see the note on the merchant
                    analytics switch: <button> is text-align:center, so an
                    absolute knob with no `left` starts from the track's
                    centre and overflows when on. 44px − 20px − 2px ⇒ 20px. */}
                <span
                  className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    settings[id] ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      {canManage ? (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            className="stq-btn stq-btn-primary"
            disabled={pending || !changed}
            onClick={save}
          >
            {pending ? "Saving…" : "Save Analytics settings"}
          </button>
          {changed ? (
            <button
              type="button"
              className="stq-btn"
              disabled={pending}
              onClick={() => setSettings(saved)}
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
