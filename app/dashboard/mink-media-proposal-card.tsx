"use client";

import {
  CheckCircle2,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { saveMinkGeneratedImage } from "@/app/actions/mink-media-actions";
import type { MinkArtifact } from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "media_image_proposal" }>;

/**
 * The Phase 9E review card.
 *
 * ★★ THE CARD IS THE IMAGE. Every other proposal card describes a change to
 * something the merchant can already see; here the artefact is a picture, and
 * a card that described the prompt would ask somebody to approve an image
 * nobody had looked at. 9C's rule -- show the colours, not a description of
 * them -- one step further.
 *
 * ★ SAVING IS ONE BUTTON, NOT AN APPROVAL, matching 9D's own save in the
 * composer: a Media Library row changes nothing a shopper can see, and the
 * only route from that library onto a live page is a layout proposal the
 * merchant separately approves.
 *
 * ★ THE ALT TEXT IS SHOWN AND NOT HIDDEN BEHIND A DISCLOSURE. Proposal time
 * is the only moment anything in this product asks for it, so a merchant who
 * never reads it here never reads it at all.
 */
export function MinkMediaProposalCard({ proposal }: { proposal: Proposal }) {
  const [saved, setSaved] = useState(proposal.saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy || saved) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveMinkGeneratedImage(proposal.draftId);
      if (result.error) throw new Error(result.error);
      setSaved(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "This image could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]">
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <ImagePlus className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.destinationLabel}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private image · {proposal.expectedCredits} AI credits ·{" "}
                {proposal.aspectRatio}
              </p>
            </div>
          </div>
          <a
            href={proposal.destinationPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#5d3fe3] hover:underline"
          >
            Media Library <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      <div className="space-y-3 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated
            object URL under the store's own bucket prefix; next/image would
            add a proxy hop for one card-sized preview. */}
        <img
          src={proposal.url}
          alt={proposal.alt}
          className="w-full rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] object-cover"
        />

        <div className="flex flex-wrap gap-1.5 text-[9px]">
          <Badge>For {proposal.placement}</Badge>
          <Badge>Not on your storefront</Badge>
        </div>

        <dl className="space-y-1.5 rounded-xl border border-[#eeeaf8] bg-[#fbfaff] px-3 py-2 text-[9px] leading-4">
          <div>
            <dt className="font-semibold text-[#4a4260]">Alt text</dt>
            <dd className="text-[#5f5969]">{proposal.alt}</dd>
          </div>
          <div>
            <dt className="font-semibold text-[#4a4260]">Described as</dt>
            <dd className="text-[#5f5969]">{proposal.prompt}</dd>
          </div>
        </dl>

        {saved ? (
          <div className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Saved to your Media Library</p>
              <p className="mt-1">
                It is not on your storefront yet. Ask Mink to place it, or add
                it to a section yourself in Website Builder.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#ded8f4] bg-[#faf8ff] p-3">
            <p className="max-w-lg text-[9px] leading-4 text-[#5f5969]">
              Saving keeps this image in your Media Library so Mink can propose
              it on a page. Placing it on your storefront is a separate step you
              approve on its own.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#6d4dff] bg-white px-3 py-1.5 text-[9px] font-semibold text-[#5132d2] hover:bg-[#f5f1ff] disabled:cursor-not-allowed disabled:border-[#d7d2df] disabled:text-[#9a95a0]"
            >
              {busy ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              Save to Media Library
            </button>
          </div>
        )}

        {error ? (
          <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="rounded-xl border border-[#e5e1eb] bg-[#f8f7fa] px-3 py-2 text-[9px] leading-4 text-[#65616b]">
          This image was generated by AI and carries an invisible SynthID
          watermark. It is decoration, not a photograph of your goods: Mink
          cannot use it as a product photo, and it reaches a page only through a
          layout change you approve separately.
        </div>
      </div>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[#ded8f4] bg-[#f6f3ff] px-2 py-0.5 font-medium text-[#5132d2]">
      {children}
    </span>
  );
}
