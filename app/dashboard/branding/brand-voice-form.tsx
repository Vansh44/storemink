"use client";

import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import {
  saveBrandVoice,
  generateBrandVoice,
  type BrandVoiceEditorData,
} from "@/app/actions/brand-voice-actions";
import type { BrandVoiceStructured } from "@/lib/ai/brand-voice";
import "./branding.css";

// Brand voice — guided setup + the brand guide every AI copy feature speaks
// from. The merchant answers five plain questions, optionally lets AI compose
// the guide, reviews/edits it, and saves. Renders below the visual branding
// form on /dashboard/branding.
export function BrandVoiceForm({
  initial,
  canManage,
}: {
  initial: BrandVoiceEditorData;
  canManage: boolean;
}) {
  const [answers, setAnswers] = useState<BrandVoiceStructured>(
    initial.structured,
  );
  const [content, setContent] = useState(initial.content);
  const [usage, setUsage] = useState(initial.usage);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const set = (key: keyof BrandVoiceStructured) => (v: string) =>
    setAnswers((a) => ({ ...a, [key]: v }));

  async function onGenerate() {
    if (!canManage || generating) return;
    setGenerating(true);
    setStatus(null);
    const res = await generateBrandVoice(answers);
    setGenerating(false);
    if (res.error || !res.content) {
      setStatus({ ok: false, msg: res.error ?? "Generation failed." });
      return;
    }
    setContent(res.content);
    // One generation was consumed — reflect it without a refetch.
    setUsage((u) => (u.cap === null ? u : { ...u, used: u.used + 1 }));
    setStatus({
      ok: true,
      msg: "Draft ready — review it below, tweak anything, then save.",
    });
  }

  async function onSave() {
    if (!canManage || saving) return;
    setSaving(true);
    setStatus(null);
    const res = await saveBrandVoice({ content, structured: answers });
    setSaving(false);
    setStatus(
      res.error
        ? { ok: false, msg: res.error }
        : { ok: true, msg: "Brand voice saved — AI copy now speaks in it." },
    );
  }

  const q = (
    key: keyof BrandVoiceStructured,
    label: string,
    placeholder: string,
    full = false,
  ) => (
    <div className={`brandingField${full ? " full" : ""}`}>
      <label htmlFor={`bv-${key}`}>{label}</label>
      <input
        id={`bv-${key}`}
        value={answers[key] ?? ""}
        onChange={(e) => set(key)(e.target.value)}
        placeholder={placeholder}
        disabled={!canManage}
        maxLength={600}
      />
    </div>
  );

  return (
    <div className="brandingPage" style={{ marginTop: 8 }}>
      <div className="brandingSection">
        <h2>Brand voice (AI)</h2>
        <p className="lead" style={{ marginBottom: 16 }}>
          The identity your AI copy speaks from — product descriptions, SEO and
          marketing emails all follow this guide. Answer a few questions and let
          AI draft it, or write your own below.
          {usage.cap !== null && (
            <>
              {" "}
              <strong>
                {Math.min(usage.used, usage.cap)} of {usage.cap}
              </strong>{" "}
              Mink credits used in this plan cycle.
            </>
          )}
        </p>

        <div className="brandingGrid">
          {q(
            "sell",
            "What do you sell?",
            "e.g. Fresh groceries and daily staples, delivered same-day",
            true,
          )}
          {q(
            "audience",
            "Who buys it?",
            "e.g. Busy families who want fresh food without the market trip",
          )}
          {q(
            "personality",
            "Three personality words",
            "e.g. warm, honest, a little playful",
          )}
          {q(
            "why",
            "Why does your brand exist?",
            "e.g. Fresh food shouldn't be a luxury or a chore",
          )}
          {q(
            "avoid",
            "Words or claims to avoid",
            "e.g. cheap, guilt-free, medical claims",
          )}
        </div>

        {canManage && (
          <button
            type="button"
            className="brandingSave"
            style={{
              marginTop: 14,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            onClick={onGenerate}
            disabled={generating || saving}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {generating ? "Writing your brand voice…" : "Generate with AI"}
          </button>
        )}

        <div className="brandingField full" style={{ marginTop: 18 }}>
          <label htmlFor="bv-content">Your brand guide</label>
          <textarea
            id="bv-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Generate a draft above, or write your own brand guide here. Until one is saved, AI copy uses a sensible generic voice built from your store name and tagline."
            disabled={!canManage}
            rows={14}
            style={{ fontFamily: "var(--font-dash-mono, monospace)" }}
          />
        </div>
      </div>

      {canManage && (
        <div className="brandingBar">
          {status && (
            <span
              style={{ color: status.ok ? "#15803d" : "#b91c1c", fontSize: 13 }}
            >
              {status.msg}
            </span>
          )}
          <button
            type="button"
            className="brandingSave"
            onClick={onSave}
            disabled={saving || generating}
          >
            {saving ? "Saving…" : "Save brand voice"}
          </button>
        </div>
      )}
    </div>
  );
}
