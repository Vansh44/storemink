"use client";

import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Palette,
  ShieldCheck,
  TriangleAlert,
  Type,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type {
  MinkStorefrontDesignActionApproval,
  MinkStorefrontDesignActionResult,
} from "@/lib/mink/storefront-design-action-types";
import type {
  MinkArtifact,
  MinkStorefrontDesignSummary,
} from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "storefront_design_proposal" }>;

/**
 * The Phase 9C review card.
 *
 * ★★ IT SHOWS THE COLOURS, NOT A DESCRIPTION OF THEM. This is the one
 * proposal card whose entire subject is visual, and "accent: #b91c1c" is not
 * something a merchant can judge -- so every palette change renders as a
 * before/after pair of real swatches. The honest full preview is still the
 * Website Builder, which the card links to, for 9B's reason: the storefront's
 * own renderers are the only thing that can say what a design looks like, and
 * a second implementation in a chat card would drift.
 *
 * ★ AND IT SHOWS WHAT AN UNSET TOKEN FALLS BACK TO. A design proposal clears
 * as often as it sets -- `null` means "inherit the pinned theme" -- and a
 * cleared token rendered as an empty swatch labelled "theme" tells a merchant
 * nothing about what their shop will actually look like. The theme's own
 * colour is drawn in its place.
 */
export function MinkStorefrontDesignProposalCard({
  proposal,
}: {
  proposal: Proposal;
}) {
  const [approval, setApproval] =
    useState<MinkStorefrontDesignActionApproval | null>(null);
  const [result, setResult] = useState<MinkStorefrontDesignActionResult | null>(
    null,
  );
  const [busy, setBusy] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { summary } = proposal;
  const changeCount =
    summary.palette.length + summary.fonts.length + summary.shape.length;

  // A card restored from conversation history has no idea what its proposal
  // already did. Asked once, on mount; a failure leaves the card exactly as it
  // renders today rather than replacing a working control with an error.
  useEffect(() => {
    const controller = new AbortController();
    void readLatestDesignAction(proposal.draftId, controller.signal)
      .then((saved) => {
        if (saved) setResult(saved);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [proposal.draftId]);

  async function applyDraftSave() {
    setBusy(approval ? "execute" : "preview");
    setError(null);
    try {
      let exactApproval = approval;
      if (!exactApproval) {
        const previewResponse = await requestDesignAction(proposal.draftId, {
          action: "preview",
          expectedDraftVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        });
        exactApproval = previewResponse.approval ?? null;
        if (!exactApproval)
          throw new Error("The draft safety check returned no approval.");
        setApproval(exactApproval);
        setBusy("execute");
      }
      const response = await requestDesignAction(proposal.draftId, {
        action: "execute",
        approvalId: exactApproval.id,
      });
      if (!response.result)
        throw new Error("The save response was incomplete.");
      setResult(response.result);
      setApproval(null);
    } catch (requestError) {
      // ★ AN UNKNOWN OUTCOME IS NOT A FAILURE -- §26's refund rule, as in 9B.
      //   The approval is KEPT and the same id retried, which the
      //   executed-approval branch answers idempotently.
      if (
        requestError instanceof DesignActionRequestError &&
        requestError.outcome === "unknown"
      ) {
        setError(UNKNOWN_DESIGN_OUTCOME);
      } else {
        setApproval(null);
        setError(messageOf(requestError, "The design was not saved."));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]">
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <Palette className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.destinationLabel}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private Builder draft · {proposal.expectedCredits} AI credits
              </p>
            </div>
          </div>
          <a
            href={proposal.destinationPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#5d3fe3] hover:underline"
          >
            Open Builder <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap gap-1.5 text-[9px]">
          <Badge>
            {changeCount} change{changeCount === 1 ? "" : "s"}
          </Badge>
          <Badge>Storefront-wide</Badge>
        </div>
        <p className="text-[11px] leading-5 text-[#39363f]">
          {proposal.explanation}
        </p>

        {/* ★ CONTRAST LEADS WHEN IT FAILS. The contract refuses an illegible
            palette outright, so this is empty on any proposal Mink just made
            — it can only appear on a card restored after the store changed
            theme underneath it, which is exactly when the merchant needs to
            see it before pressing anything. */}
        {summary.contrastIssues.length > 0 ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[9px] leading-4 text-rose-900">
            <p className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="h-3 w-3" />
              Hard to read against the store&rsquo;s current theme
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {summary.contrastIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <details className="rounded-xl border border-[#e7e3ef] bg-[#fbfaff] px-3 py-2.5">
          <summary className="cursor-pointer text-[10px] font-semibold text-[#4a4260]">
            Review {changeCount} design change{changeCount === 1 ? "" : "s"}
          </summary>
          <div className="mt-2 space-y-2">
            <PaletteChanges palette={summary.palette} />
            <TypeChanges fonts={summary.fonts} shape={summary.shape} />
          </div>
        </details>

        {result ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">
                  Saved to the private Website Builder draft
                </p>
                <p className="mt-1">
                  The live storefront was not published or changed. Audit
                  reference: {result.auditId}.
                </p>
                <a
                  href={result.approval.resource.dashboardPath}
                  className="mt-2 inline-flex items-center gap-1 font-semibold text-emerald-800 underline"
                >
                  Open Builder <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#ded8f4] bg-[#faf8ff] p-3">
            <div className="max-w-lg text-[9px] leading-4 text-[#5f5969]">
              <p className="font-semibold text-[#403753]">
                Apply this to your private Builder draft
              </p>
              <p>
                Nothing is published. You can keep editing before you go live.
              </p>
              {approval ? (
                <p className="mt-1 text-amber-800">
                  The last save could not be confirmed. Retry is safe and cannot
                  apply twice.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void applyDraftSave()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-[#4e32ca] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {busy
                ? "Applying…"
                : approval
                  ? "Retry applying to draft"
                  : "Apply to Website Builder draft"}
            </button>
          </div>
        )}

        {error ? (
          <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        <details className="rounded-xl border border-[#eeeaf8] bg-[#fbfaff] px-3 py-2">
          <summary className="cursor-pointer text-[9px] font-semibold text-[#4a4260]">
            Integrity details
          </summary>
          <div className="mt-2 space-y-1 break-all font-mono text-[8px] text-[#8a8490]">
            <p>Proposal SHA-256: {proposal.patchDigest}</p>
            <p>
              Current design SHA-256: {proposal.target.expectedDesignDigest}
            </p>
          </div>
        </details>

        <div className="rounded-xl border border-[#e5e1eb] bg-[#f8f7fa] px-3 py-2 text-[9px] leading-4 text-[#65616b]">
          Applying here changes only your private Website Builder draft.
          Publishing remains a separate step in Website Builder.
        </div>
      </div>
    </section>
  );
}

function PaletteChanges({
  palette,
}: {
  palette: MinkStorefrontDesignSummary["palette"];
}) {
  if (palette.length === 0) {
    return (
      <p className="rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] p-2.5 text-[9px] leading-4 text-[#54505c]">
        No colour changes.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] p-2.5">
      <p className="flex items-center gap-1.5 text-[9px] font-semibold text-[#54505c]">
        <Palette className="h-3 w-3" />
        Colours ({palette.length})
      </p>
      <ul className="mt-2 space-y-1.5">
        {palette.map((change) => (
          <li
            key={change.token}
            className="flex items-center gap-2 text-[9px] text-[#54505c]"
          >
            <span className="w-20 shrink-0 font-medium">
              {PALETTE_LABELS[change.token] ?? change.token}
            </span>
            <Swatch value={change.before} fallback={change.themeDefault} />
            <span aria-hidden>→</span>
            <Swatch value={change.after} fallback={change.themeDefault} />
            <span className="truncate font-mono text-[8px] text-[#8a8490]">
              {colourLabel(change.after, change.themeDefault)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TypeChanges({
  fonts,
  shape,
}: {
  fonts: MinkStorefrontDesignSummary["fonts"];
  shape: MinkStorefrontDesignSummary["shape"];
}) {
  if (fonts.length === 0 && shape.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] p-2.5 text-[9px] leading-4 text-[#54505c]">
      <p className="flex items-center gap-1.5 font-semibold">
        <Type className="h-3 w-3" />
        Typefaces and corners
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {fonts.map((change) => (
          <li key={change.slot}>
            {change.slot === "body" ? "Body text" : "Headings"}:{" "}
            {textOrTheme(change.before, change.themeDefault)} →{" "}
            <strong className="font-semibold">
              {textOrTheme(change.after, change.themeDefault)}
            </strong>
          </li>
        ))}
        {shape.map((change) => (
          <li key={change.key}>
            {SHAPE_LABELS[change.key] ?? change.key} corners:{" "}
            {pxOrTheme(change.before, change.themeDefault)} →{" "}
            <strong className="font-semibold">
              {pxOrTheme(change.after, change.themeDefault)}
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ★ A CLEARED TOKEN DRAWS THE THEME'S COLOUR, NOT AN EMPTY BOX. `null` means
 * inherit, so the theme value IS what the storefront will paint; a blank
 * swatch would hide the only fact this row exists to show. A theme that
 * supplies no value for the token has nothing honest to draw, so that -- and
 * only that -- renders as a dashed placeholder.
 */
function Swatch({
  value,
  fallback,
}: {
  value: string | null;
  fallback: string | null;
}) {
  const colour = value ?? fallback;
  if (!colour) {
    return (
      <span className="h-4 w-4 shrink-0 rounded border border-dashed border-[#c8c3d2]" />
    );
  }
  return (
    <span
      className="h-4 w-4 shrink-0 rounded border border-[#d5d0de]"
      style={{ backgroundColor: colour }}
      title={value ? colour : `${colour} (from the theme)`}
    />
  );
}

const PALETTE_LABELS: Record<string, string> = {
  cream: "Page",
  creamDeep: "Page deep",
  surface: "Cards",
  ink: "Body text",
  inkSoft: "Muted text",
  inkFaint: "Faint text",
  border: "Borders",
  accent: "Accent",
};

const SHAPE_LABELS: Record<string, string> = {
  card: "Card",
  control: "Button",
  sm: "Small",
  pill: "Pill",
};

function colourLabel(value: string | null, fallback: string | null): string {
  if (value) return value;
  return fallback ? `${fallback} · theme` : "theme";
}

function textOrTheme(value: string | null, fallback: string | null): string {
  if (value) return value;
  return fallback ? `${fallback} (theme)` : "theme";
}

function pxOrTheme(value: number | null, fallback: number | null): string {
  if (value !== null) return `${value}px`;
  return fallback !== null ? `${fallback}px (theme)` : "theme";
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-2 py-1 font-medium text-[#564a70]">
      {children}
    </span>
  );
}

const UNKNOWN_DESIGN_OUTCOME =
  "We could not confirm whether the design was saved. Check Website Builder, or retry here — the same save cannot apply twice.";

class DesignActionRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}

type DesignMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

async function requestDesignAction(
  draftId: string,
  body: DesignMutation,
): Promise<{
  approval?: MinkStorefrontDesignActionApproval;
  result?: MinkStorefrontDesignActionResult;
}> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-design-action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
  } catch {
    throw new DesignActionRequestError(UNKNOWN_DESIGN_OUTCOME, "unknown");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    approval?: MinkStorefrontDesignActionApproval;
    result?: MinkStorefrontDesignActionResult;
  } | null;
  if (!response.ok) {
    throw new DesignActionRequestError(
      payload?.error ?? "This design action could not be completed.",
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  return payload ?? {};
}

async function readLatestDesignAction(
  draftId: string,
  signal: AbortSignal,
): Promise<MinkStorefrontDesignActionResult | null> {
  const response = await fetch(
    `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-design-action`,
    { cache: "no-store", signal },
  );
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    result?: MinkStorefrontDesignActionResult | null;
  } | null;
  return payload?.result ?? null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
