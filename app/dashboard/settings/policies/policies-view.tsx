"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Check, AlertCircle } from "lucide-react";
import {
  saveStorePolicy,
  type StorePolicyState,
} from "@/app/actions/store-policy-actions";
import { htmlToPlain, plainToHtml } from "@/lib/legal/policy-text";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

export function PoliciesView({
  policies,
  prompts,
}: {
  policies: StorePolicyState[];
  prompts: Record<string, string[]>;
}) {
  return (
    <div className="dash-page">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Policies</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          Your store&apos;s own policies. Each one is published as a page on
          your storefront and linked in the footer. Customers accept your Terms
          and Refund Policy at checkout.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {policies.map((policy) => (
          <PolicyCard
            key={policy.kind}
            policy={policy}
            prompts={prompts[policy.kind] ?? []}
          />
        ))}
      </div>
    </div>
  );
}

function PolicyCard({
  policy,
  prompts,
}: {
  policy: StorePolicyState;
  prompts: string[];
}) {
  // null = richer than paragraphs, so this editor must not touch it.
  const initialPlain = htmlToPlain(policy.html);
  const [text, setText] = useState(initialPlain ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const editable = initialPlain !== null;
  const dirty = editable && text !== (initialPlain ?? "");

  // A whole policy document lives in this textarea until Save publishes it.
  useUnsavedChangesWarning(dirty);

  const save = () => {
    setError("");
    setSaved(false);
    startTransition(async () => {
      try {
        const result = await saveStorePolicy(policy.kind, plainToHtml(text));
        if (result.error) {
          setError(result.error);
          return;
        }
        setSaved(true);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <section className="dash-card p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {policy.title}
            {policy.live ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                Live
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Not written
              </span>
            )}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {policy.description}
          </p>
        </div>
        {policy.live && (
          <a
            href={`/${policy.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-xs"
          >
            /{policy.slug}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {editable ? (
        <>
          {!policy.live && prompts.length > 0 && (
            // Prompts, not pre-written prose. A generated policy someone
            // never read is worse than a blank one — it looks authoritative
            // and says things the merchant hasn't agreed to.
            <div className="mb-3 rounded-md border border-dashed px-3 py-2.5">
              <p className="mb-1.5 text-xs font-medium">Cover at least:</p>
              <ul className="text-muted-foreground list-inside list-disc space-y-0.5 text-xs">
                {prompts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          <textarea
            className="dash-input min-h-[180px] w-full resize-y font-normal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder="Write your policy here. Leave a blank line between paragraphs."
          />

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={pending || !dirty}
              className="dash-btn dash-btn-primary"
            >
              {pending ? "Saving…" : "Save and publish"}
            </button>
            {saved && !dirty && (
              <span className="flex items-center gap-1 text-xs text-emerald-700">
                <Check className="h-3.5 w-3.5" />
                Published
              </span>
            )}
            {error && <span className="text-destructive text-xs">{error}</span>}
          </div>
        </>
      ) : (
        // The page has headings/lists/images — richer than a textarea can
        // round-trip. Editing it here would silently destroy that.
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-700" />
          <p className="flex-1 text-xs text-amber-900">
            This page has formatting beyond plain paragraphs, so it&apos;s
            edited in the website builder to avoid losing it.
          </p>
          <a
            href={`/dashboard/builder`}
            target="_blank"
            rel="noopener noreferrer"
            className="dash-btn dash-btn-outline shrink-0 text-xs"
          >
            Open in builder
          </a>
        </div>
      )}
    </section>
  );
}
