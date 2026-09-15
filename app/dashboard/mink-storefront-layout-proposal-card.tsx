"use client";

import {
  ArrowUpDown,
  CheckCircle2,
  ExternalLink,
  LayoutTemplate,
  LoaderCircle,
  Minus,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SECTION_TYPE_META } from "@/lib/sections/registry";
import type {
  MinkStorefrontLayoutActionApproval,
  MinkStorefrontLayoutActionResult,
} from "@/lib/mink/storefront-layout-action-types";
import type {
  MinkArtifact,
  MinkStorefrontLayoutSectionRef,
} from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "storefront_layout_proposal" }>;

/**
 * The Phase 9B review card.
 *
 * ★★ IT SHOWS THE CHANGE, NOT A RENDERED PAGE, and that is the deliberate
 * difference from the 7B card beside it. A code proposal has to be previewed
 * in an isolated iframe because its output is arbitrary and nothing else can
 * say what it will do. A section list is rendered by our own components, so
 * the honest preview of it is the Website Builder — which this card links to,
 * and which the merchant already knows. Reimplementing the storefront's
 * seventeen renderers inside a chat card would produce a second, drifting
 * answer to "what will my page look like".
 *
 * So what a merchant needs here is what they are about to LOSE: an approval
 * that quietly deletes a section is the failure mode of a whole-list replace,
 * and removals lead the card for that reason.
 */
export function MinkStorefrontLayoutProposalCard({
  proposal,
}: {
  proposal: Proposal;
}) {
  const [approval, setApproval] =
    useState<MinkStorefrontLayoutActionApproval | null>(null);
  const [result, setResult] = useState<MinkStorefrontLayoutActionResult | null>(
    null,
  );
  const [busy, setBusy] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { summary } = proposal;

  // A card restored from conversation history has no idea what its proposal
  // already did. Asked once, on mount; a failure leaves the card exactly as it
  // renders today rather than replacing a working control with an error.
  useEffect(() => {
    const controller = new AbortController();
    void readLatestLayoutAction(proposal.draftId, controller.signal)
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
      // One merchant click performs both server-side safety checks. The first
      // request still creates the exact short-lived approval and the second
      // consumes it; collapsing the UI does not weaken either revalidation or
      // the audit trail. An approval retained after an unknown outcome is
      // retried directly and remains idempotent.
      let exactApproval = approval;
      if (!exactApproval) {
        const previewResponse = await requestLayoutAction(proposal.draftId, {
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

      const response = await requestLayoutAction(proposal.draftId, {
        action: "execute",
        approvalId: exactApproval.id,
      });
      if (!response.result)
        throw new Error("The save response was incomplete.");
      setResult(response.result);
      setApproval(null);
    } catch (requestError) {
      if (
        requestError instanceof LayoutActionRequestError &&
        requestError.outcome === "unknown"
      ) {
        setError(UNKNOWN_LAYOUT_OUTCOME);
      } else {
        setApproval(null);
        setError(messageOf(requestError, "The layout was not saved."));
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
              <LayoutTemplate className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.title}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private Builder draft · {proposal.expectedCredits} Mink credits
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
          <Badge>Page: {proposal.target.pageSlug}</Badge>
          <Badge>{proposal.sectionCount} sections after</Badge>
          {summary.reordered ? <Badge>Order changed</Badge> : null}
        </div>
        <p className="text-[11px] leading-5 text-[#39363f]">
          {proposal.explanation}
        </p>

        {/* Removals first: they are the only irreversible-looking part of a
            whole-list replace, and the thing a merchant must not approve
            without noticing. */}
        <details className="rounded-xl border border-[#e7e3ef] bg-[#fbfaff] px-3 py-2.5">
          <summary className="cursor-pointer text-[10px] font-semibold text-[#4a4260]">
            Review page changes · {summary.added.length} added,{" "}
            {summary.removed.length} removed
          </summary>
          <div className="mt-2 space-y-2">
            <ChangeGroup
              tone="removed"
              icon={<Minus className="h-3 w-3" />}
              label="Removed from the page"
              refs={summary.removed}
              empty="Nothing is removed."
            />
            <ChangeGroup
              tone="added"
              icon={<Plus className="h-3 w-3" />}
              label="Added"
              refs={summary.added}
              empty="Nothing new is added."
            />
            <ChangeGroup
              tone="kept"
              icon={<ArrowUpDown className="h-3 w-3" />}
              label={summary.reordered ? "Kept, in a new order" : "Kept"}
              refs={summary.kept}
              empty="No existing section is kept."
            />
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
            <p>Page version: {proposal.target.expectedPageVersion}</p>
            <p>
              Current list SHA-256: {proposal.target.expectedSectionsDigest}
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

function ChangeGroup({
  tone,
  icon,
  label,
  refs,
  empty,
}: {
  tone: "added" | "removed" | "kept";
  icon: ReactNode;
  label: string;
  refs: MinkStorefrontLayoutSectionRef[];
  empty: string;
}) {
  const palette =
    tone === "removed"
      ? "border-rose-200 bg-rose-50 text-rose-900"
      : tone === "added"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : "border-[#e7e3ef] bg-[#f8f7fa] text-[#54505c]";
  return (
    <div className={`rounded-xl border p-2.5 text-[9px] leading-4 ${palette}`}>
      <p className="flex items-center gap-1.5 font-semibold">
        {icon}
        {label} ({refs.length})
      </p>
      {refs.length === 0 ? (
        <p className="mt-1 opacity-80">{empty}</p>
      ) : (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {refs.map((section) => (
            <li
              key={section.id}
              className="rounded-full bg-white/70 px-2 py-0.5"
              title={section.id}
            >
              {sectionLabel(section)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * ★ THE TYPE IS THE NAME. A section carries no merchant-authored title of its
 * own, and its id is opaque, so the registry label is the only wording a
 * merchant recognises — the same one the Builder outline shows. An unknown
 * type falls back to its raw value rather than to "Section", which would hide
 * exactly the case worth seeing.
 */
function sectionLabel(section: MinkStorefrontLayoutSectionRef): string {
  return SECTION_TYPE_META[section.type]?.label ?? section.type;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-2 py-1 font-medium text-[#564a70]">
      {children}
    </span>
  );
}

const UNKNOWN_LAYOUT_OUTCOME =
  "We could not confirm whether the layout was saved. Check Website Builder, or retry here — the same save cannot apply twice.";

class LayoutActionRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}

type LayoutMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

async function requestLayoutAction(
  draftId: string,
  body: LayoutMutation,
): Promise<{
  approval?: MinkStorefrontLayoutActionApproval;
  result?: MinkStorefrontLayoutActionResult;
}> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-layout-action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
  } catch {
    throw new LayoutActionRequestError(UNKNOWN_LAYOUT_OUTCOME, "unknown");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    approval?: MinkStorefrontLayoutActionApproval;
    result?: MinkStorefrontLayoutActionResult;
  } | null;
  if (!response.ok) {
    throw new LayoutActionRequestError(
      payload?.error ?? "This layout action could not be completed.",
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  return payload ?? {};
}

async function readLatestLayoutAction(
  draftId: string,
  signal: AbortSignal,
): Promise<MinkStorefrontLayoutActionResult | null> {
  const response = await fetch(
    `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-layout-action`,
    { cache: "no-store", signal },
  );
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    result?: MinkStorefrontLayoutActionResult | null;
  } | null;
  return payload?.result ?? null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
