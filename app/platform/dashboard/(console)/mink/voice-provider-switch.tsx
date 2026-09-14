"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setMinkVoiceProvider } from "@/app/actions/mink-operator-actions";
import type { MinkVoiceProvider } from "@/lib/mink/voice-provider";

export function VoiceProviderSwitch({
  initialProvider,
  canManage,
}: {
  initialProvider: MinkVoiceProvider;
  canManage: boolean;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [pending, startTransition] = useTransition();
  const sarvam = provider === "saaras_v4";

  function toggle() {
    if (!canManage || pending) return;
    const next: MinkVoiceProvider = sarvam ? "chirp_3" : "saaras_v4";
    setProvider(next);
    startTransition(async () => {
      const result = await setMinkVoiceProvider(next);
      if (result.error || !result.success || !result.provider) {
        setProvider(provider);
        toast.error(result.error || "Could not change the voice model.");
        return;
      }
      setProvider(result.provider);
      toast.success("Global voice model updated.");
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">Voice model</h2>
          <p className="mt-1 text-sm text-slate-500">
            {sarvam ? "Sarvam Saaras v4" : "Google Chirp 3"} is used by Mink for
            every store.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-xs font-medium text-slate-600">
          <span>Google Chirp 3</span>
          <button
            type="button"
            role="switch"
            aria-checked={sarvam}
            aria-label="Use Sarvam Saaras v4 globally"
            disabled={!canManage || pending}
            onClick={toggle}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              sarvam ? "bg-violet-600" : "bg-slate-400"
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                sarvam ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
          <span>Sarvam Saaras v4</span>
        </div>
      </div>
    </section>
  );
}
