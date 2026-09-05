"use client";

import {
  CheckCircle2,
  Clock3,
  Code2,
  ExternalLink,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import { validateConfig, type CustomCodeConfig } from "@/lib/sections/registry";
import type { MinkStorefrontCodePreviewDto } from "@/lib/mink/storefront-code-preview-types";
import type {
  MinkStorefrontCodeActionApproval,
  MinkStorefrontCodeActionResult,
  MinkStorefrontCodeActionValues,
} from "@/lib/mink/storefront-code-action-types";
import type { MinkStorefrontPublicationResult } from "@/lib/mink/storefront-publication-types";
import type { MinkArtifact } from "@/lib/mink/types";
import {
  MinkStorefrontPublicationControls,
  readPublicationResult,
} from "./mink-storefront-publication-controls";

type Proposal = Extract<MinkArtifact, { type: "storefront_code_proposal" }>;
type SourceField = "html" | "css" | "js";

export function MinkStorefrontCodeProposalCard({
  proposal,
}: {
  proposal: Proposal;
}) {
  const [result, setResult] = useState<{
    draftId: string;
    preview: MinkStorefrontCodePreviewDto | null;
    error: string | null;
  } | null>(null);
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [tab, setTab] = useState<"preview" | SourceField>("preview");
  const [approval, setApproval] =
    useState<MinkStorefrontCodeActionApproval | null>(null);
  const [actionResult, setActionResult] =
    useState<MinkStorefrontCodeActionResult | null>(null);
  const [publicationResult, setPublicationResult] =
    useState<MinkStorefrontPublicationResult | null>(null);
  const [actionBusy, setActionBusy] = useState<"preview" | "execute" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void requestPreview(proposal.draftId, controller.signal)
      .then((loaded) => {
        setResult({
          draftId: proposal.draftId,
          preview: loaded.preview,
          error: null,
        });
        setActionResult(loaded.lastAction);
        setPublicationResult(loaded.lastPublication);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setResult({
          draftId: proposal.draftId,
          preview: null,
          error:
            requestError instanceof Error
              ? requestError.message
              : "This private preview could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [proposal.draftId]);

  const loading = result?.draftId !== proposal.draftId;
  const preview = loading ? null : result.preview;
  const error = loading ? null : result.error;
  const targetTone = preview?.targetState ?? "current";
  const changedLabel = proposal.changedFields.length
    ? proposal.changedFields.join(", ")
    : "none";

  async function reviewDraftSave() {
    if (!preview) return;
    setActionBusy("preview");
    setActionError(null);
    try {
      const response = await requestStorefrontAction(proposal.draftId, {
        action: "preview",
        expectedDraftVersion: preview.draftVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      setApproval(response.approval ?? null);
      setActionResult(null);
    } catch (requestError) {
      setActionError(
        requestError instanceof Error
          ? requestError.message
          : "The Builder draft save could not be reviewed.",
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function approveDraftSave() {
    if (!approval) return;
    setActionBusy("execute");
    setActionError(null);
    try {
      const response = await requestStorefrontAction(proposal.draftId, {
        action: "execute",
        approvalId: approval.id,
      });
      if (!response.result)
        throw new Error("The save response was incomplete.");
      setActionResult(response.result);
      setApproval(null);
    } catch (requestError) {
      // A 4xx is a definite refusal, but a transport error or 5xx may arrive
      // after the transaction committed. Reconcile once, then preserve the
      // same approval ID so a retry stays idempotent.
      if (
        !(requestError instanceof StorefrontActionRequestError) ||
        requestError.outcome !== "unknown"
      ) {
        setApproval(null);
        setActionError(
          requestError instanceof Error
            ? requestError.message
            : "The Builder draft save was not applied.",
        );
        void refreshPreview();
        return;
      }
      const settled = await reconcileUnknownSave(approval.id);
      if (settled) {
        setActionResult(settled);
        setApproval(null);
        return;
      }
      setActionError(UNKNOWN_STOREFRONT_ACTION_OUTCOME);
    } finally {
      setActionBusy(null);
    }
  }

  async function refreshPreview() {
    const controller = new AbortController();
    try {
      const loaded = await requestPreview(proposal.draftId, controller.signal);
      setResult({
        draftId: proposal.draftId,
        preview: loaded.preview,
        error: null,
      });
      setActionResult(loaded.lastAction);
      setPublicationResult(loaded.lastPublication);
    } catch {
      // Keep the actionable server refusal already shown. A manual card reload
      // will retry the private preview without replacing that verdict.
    }
  }

  async function reconcileUnknownSave(approvalId: string) {
    const controller = new AbortController();
    try {
      const loaded = await requestPreview(proposal.draftId, controller.signal);
      setResult({
        draftId: proposal.draftId,
        preview: loaded.preview,
        error: null,
      });
      setPublicationResult(loaded.lastPublication);
      return loaded.lastAction?.approval.id === approvalId
        ? loaded.lastAction
        : null;
    } catch {
      return null;
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]">
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <Code2 className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.title}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private proposal · {proposal.expectedCredits} AI credits · draft
                save needs approval
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
          <Badge>Changed: {changedLabel}</Badge>
          <Badge>
            {proposal.beforeCharacters.toLocaleString("en-IN")} →{" "}
            {proposal.afterCharacters.toLocaleString("en-IN")} chars
          </Badge>
        </div>
        <p className="text-[11px] leading-5 text-[#39363f]">
          {proposal.explanation}
        </p>

        {loading ? (
          <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-[#eeeaf8] bg-[#faf9fc] text-[10px] text-[#716d78]">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Validating private preview…
          </div>
        ) : error ? (
          <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : preview ? (
          <>
            <div
              className={`flex gap-2 rounded-xl border p-2.5 text-[9px] leading-4 ${
                targetTone === "current"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {targetTone === "current" ? (
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span>{preview.targetMessage}</span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex rounded-lg border border-[#e7e3ef] bg-[#f7f6f9] p-0.5">
                {(["preview", "html", "css", "js"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    className={`rounded-md px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${
                      tab === item
                        ? "bg-white text-[#4f35c8] shadow-sm"
                        : "text-[#77727f]"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {tab === "preview" ? (
                <div className="flex rounded-lg border border-[#e7e3ef] p-0.5">
                  <ViewportButton
                    active={view === "desktop"}
                    label="Desktop"
                    onClick={() => setView("desktop")}
                    icon={<Monitor className="h-3 w-3" />}
                  />
                  <ViewportButton
                    active={view === "mobile"}
                    label="Mobile"
                    onClick={() => setView("mobile")}
                    icon={<Smartphone className="h-3 w-3" />}
                  />
                </div>
              ) : null}
            </div>

            {tab === "preview" ? (
              <div className="overflow-auto rounded-xl border border-[#ded9e8] bg-[#f1eff4] p-2">
                <div
                  data-testid="mink-storefront-preview-viewport"
                  data-viewport={view}
                  className={`mx-auto overflow-hidden rounded-lg bg-white shadow-sm transition-[width] ${
                    view === "mobile" ? "w-[390px] max-w-full" : "w-full"
                  }`}
                >
                  <CustomCodeFrame
                    config={preview.proposedConfig}
                    title={`${proposal.destinationLabel} private Mink preview`}
                    strictNetworkIsolation
                  />
                </div>
              </div>
            ) : (
              <SourceCompare
                field={tab}
                before={preview.beforeConfig}
                after={preview.proposedConfig}
              />
            )}

            <details className="rounded-xl border border-[#eeeaf8] bg-[#fbfaff] px-3 py-2">
              <summary className="cursor-pointer text-[9px] font-semibold text-[#4a4260]">
                Security and validation details
              </summary>
              <ul className="mt-2 space-y-1 text-[9px] leading-4 text-[#696471]">
                {preview.validationChecks.map((check) => (
                  <li key={check} className="flex gap-1.5">
                    <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 break-all font-mono text-[8px] text-[#8a8490]">
                Patch SHA-256: {preview.patchDigest}
              </div>
            </details>

            {actionResult ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">
                      Saved to the private Website Builder draft
                    </p>
                    <p className="mt-1">
                      The live storefront was not published or changed. Audit
                      reference: {actionResult.auditId}.
                    </p>
                    <a
                      href={actionResult.approval.resource.dashboardPath}
                      className="mt-2 inline-flex items-center gap-1 font-semibold text-emerald-800 underline"
                    >
                      Open Builder to review{" "}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              </div>
            ) : approval ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[10px] leading-4 text-amber-950">
                <div className="flex items-start gap-2">
                  <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      Approval expires{" "}
                      {formatApprovalExpiry(approval.expiresAt)}
                    </p>
                    <p className="mt-1">
                      This replaces only the exact custom-code section shown
                      above. It does not publish the page.
                    </p>
                    <button
                      type="button"
                      disabled={actionBusy !== null}
                      onClick={() => void approveDraftSave()}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 font-semibold text-white hover:bg-[#4e32ca] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {actionBusy === "execute" ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      Approve and save Builder draft
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#ded8f4] bg-[#faf8ff] p-3">
                <p className="max-w-lg text-[9px] leading-4 text-[#5f5969]">
                  Create a short-lived approval from the latest exact page and
                  section before saving this code to Website Builder.
                </p>
                <button
                  type="button"
                  disabled={
                    actionBusy !== null ||
                    preview.targetState !== "current" ||
                    !preview.authority.canSaveBuilderDraft
                  }
                  onClick={() => void reviewDraftSave()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#6d4dff] bg-white px-3 py-1.5 text-[9px] font-semibold text-[#5132d2] hover:bg-[#f5f1ff] disabled:cursor-not-allowed disabled:border-[#d7d2df] disabled:text-[#9a95a0]"
                >
                  {actionBusy === "preview" ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  Review Builder draft save
                </button>
              </div>
            )}

            {actionError ? (
              <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {actionError}
              </div>
            ) : null}

            <MinkStorefrontPublicationControls
              draftId={proposal.draftId}
              patchDigest={preview.patchDigest}
              config={preview.proposedConfig}
              savedAction={actionResult}
              initialResult={publicationResult}
            />
          </>
        ) : null}

        <div className="rounded-xl border border-[#e5e1eb] bg-[#f8f7fa] px-3 py-2 text-[9px] leading-4 text-[#65616b]">
          This proposal is immutable. Phase 7C can save its exact code to the
          private Builder draft. Phase 7D requires separate checks and approval
          to publish or roll back; neither phase can access repository code, run
          shell commands, commit or deploy.
        </div>
      </div>
    </section>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-2 py-1 font-medium text-[#564a70]">
      {children}
    </span>
  );
}

function ViewportButton({
  active,
  label,
  onClick,
  icon,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[9px] font-semibold ${
        active ? "bg-[#eee9ff] text-[#4f35c8]" : "text-[#77727f]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SourceCompare({
  field,
  before,
  after,
}: {
  field: SourceField;
  before: CustomCodeConfig;
  after: CustomCodeConfig;
}) {
  const beforeSource = before[field];
  const afterSource = after[field];
  const changed = beforeSource !== afterSource;
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <SourcePanel title="Current builder code" source={beforeSource} />
      <SourcePanel
        title={changed ? "Proposed code" : "Proposed code · unchanged"}
        source={afterSource}
      />
    </div>
  );
}

function SourcePanel({ title, source }: { title: string; source: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-[#e5e1eb] bg-[#17151b]">
      <div className="border-b border-white/10 px-2.5 py-1.5 text-[8px] font-semibold uppercase tracking-wide text-[#c8c2d2]">
        {title} · {source.length.toLocaleString("en-IN")} chars
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2.5 text-[9px] leading-4 text-[#f3eff8]">
        <code>{source || "(empty)"}</code>
      </pre>
    </div>
  );
}

async function requestPreview(
  draftId: string,
  signal: AbortSignal,
): Promise<{
  preview: MinkStorefrontCodePreviewDto;
  lastAction: MinkStorefrontCodeActionResult | null;
  lastPublication: MinkStorefrontPublicationResult | null;
}> {
  const response = await fetch(
    `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-code-preview`,
    { signal, cache: "no-store", headers: { Accept: "application/json" } },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      readError(body) ?? "This private preview could not be loaded.",
    );
  }
  return {
    preview: readPreview(body, draftId),
    lastAction:
      isRecord(body) &&
      body.lastAction !== null &&
      body.lastAction !== undefined
        ? readActionResult(body.lastAction, draftId)
        : null,
    lastPublication:
      isRecord(body) &&
      body.lastPublication !== null &&
      body.lastPublication !== undefined
        ? readPublicationResult(body.lastPublication, draftId)
        : null,
  };
}

async function requestStorefrontAction(
  draftId: string,
  mutation:
    | {
        action: "preview";
        expectedDraftVersion: number;
        idempotencyKey: string;
      }
    | { action: "execute"; approvalId: string },
): Promise<{
  approval?: MinkStorefrontCodeActionApproval;
  result?: MinkStorefrontCodeActionResult;
}> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-code-action`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(mutation),
      },
    );
  } catch {
    throw new StorefrontActionRequestError(
      "StoreMink couldn't reach Mink AI. Check your connection and try again.",
      "unknown",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new StorefrontActionRequestError(
      response.status >= 500
        ? "StoreMink couldn't confirm the Builder draft save."
        : (readError(body) ??
            "The storefront draft action could not be completed."),
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  if (!isRecord(body)) throw new Error("The save response was malformed.");
  if (body.approval !== undefined) {
    return { approval: readActionApproval(body.approval, draftId) };
  }
  if (body.result !== undefined) {
    return { result: readActionResult(body.result, draftId) };
  }
  throw new Error("The save response was incomplete.");
}

function readPreview(
  value: unknown,
  expectedId: string,
): MinkStorefrontCodePreviewDto {
  if (!isRecord(value) || !isRecord(value.preview)) {
    throw new Error("The private preview response was malformed.");
  }
  const preview = value.preview;
  const before = validateConfig("custom_code", preview.beforeConfig, "draft");
  const proposed = validateConfig(
    "custom_code",
    preview.proposedConfig,
    "draft",
  );
  if (
    preview.id !== expectedId ||
    preview.draftVersion !== 0 ||
    !boundedText(preview.title, 120) ||
    !boundedText(preview.destinationLabel, 180) ||
    typeof preview.destinationPath !== "string" ||
    preview.destinationPath.length > 400 ||
    !preview.destinationPath.startsWith("/dashboard/builder") ||
    !boundedText(preview.explanation, 1_000) ||
    !isRecord(preview.target) ||
    !boundedText(preview.target.pageSlug, 60) ||
    !boundedText(preview.target.sectionId, 128) ||
    !boundedText(preview.target.expectedPageVersion, 40) ||
    Number.isNaN(Date.parse(preview.target.expectedPageVersion)) ||
    typeof preview.target.expectedSectionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.target.expectedSectionDigest) ||
    (preview.targetState !== "current" &&
      preview.targetState !== "stale" &&
      preview.targetState !== "unavailable") ||
    !boundedText(preview.targetMessage, 300) ||
    typeof preview.patchDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.patchDigest) ||
    !Array.isArray(preview.changedFields) ||
    !preview.changedFields.every((field) =>
      ["html", "css", "js", "height"].includes(String(field)),
    ) ||
    !Array.isArray(preview.validationChecks) ||
    preview.validationChecks.length > 10 ||
    !preview.validationChecks.every(
      (check) => typeof check === "string" && check.length <= 200,
    ) ||
    !isRecord(preview.sandbox) ||
    !isRecord(preview.sandbox.iframe) ||
    preview.sandbox.iframe.sandboxAttribute !== "allow-scripts" ||
    preview.sandbox.iframe.opaqueOrigin !== true ||
    preview.sandbox.iframe.sameOrigin !== false ||
    preview.sandbox.iframe.topNavigation !== false ||
    !isRecord(preview.authority) ||
    preview.authority.canPreview !== true ||
    preview.authority.canEditProposal !== false ||
    typeof preview.authority.canSaveBuilderDraft !== "boolean" ||
    preview.authority.canPublish !== false ||
    "error" in before ||
    "error" in proposed
  ) {
    throw new Error("The private preview response failed validation.");
  }
  return {
    ...(preview as unknown as MinkStorefrontCodePreviewDto),
    beforeConfig: before.config as CustomCodeConfig,
    proposedConfig: proposed.config as CustomCodeConfig,
  };
}

function readError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string"
    ? value.error.slice(0, 300)
    : null;
}

function readActionResult(
  value: unknown,
  draftId: string,
): MinkStorefrontCodeActionResult {
  if (
    !isRecord(value) ||
    typeof value.repeated !== "boolean" ||
    typeof value.auditId !== "string" ||
    !UUID_PATTERN.test(value.auditId)
  ) {
    throw new Error("The storefront action result failed validation.");
  }
  return {
    approval: readActionApproval(value.approval, draftId),
    auditId: value.auditId,
    repeated: value.repeated,
  };
}

function readActionApproval(
  value: unknown,
  draftId: string,
): MinkStorefrontCodeActionApproval {
  if (!isRecord(value) || !isRecord(value.resource)) {
    throw new Error("The storefront approval failed validation.");
  }
  const before = readActionValues(value.before);
  const after = readActionValues(value.after);
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    value.sourceApprovalId !== null ||
    value.toolName !== "apply_storefront_code" ||
    value.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      String(value.status),
    ) ||
    value.draftId !== draftId ||
    value.draftVersion !== 0 ||
    value.resource.type !== "storefront_section" ||
    typeof value.resource.id !== "string" ||
    !UUID_PATTERN.test(value.resource.id) ||
    !boundedText(value.resource.label, 200) ||
    typeof value.resource.dashboardPath !== "string" ||
    value.resource.dashboardPath !==
      `/dashboard/builder?page=${encodeURIComponent(before.page_slug)}&section=${encodeURIComponent(before.section_id)}` ||
    before.page_slug !== after.page_slug ||
    before.page_title !== after.page_title ||
    before.section_id !== after.section_id ||
    !boundedText(value.expiresAt, 40) ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    (value.executedAt !== null &&
      (typeof value.executedAt !== "string" ||
        Number.isNaN(Date.parse(value.executedAt)))) ||
    (value.status === "executed") !== (value.executedAt !== null)
  ) {
    throw new Error("The storefront approval failed validation.");
  }
  return {
    ...(value as unknown as MinkStorefrontCodeActionApproval),
    before,
    after,
  };
}

function readActionValues(value: unknown): MinkStorefrontCodeActionValues {
  if (!isRecord(value)) {
    throw new Error("The storefront code diff failed validation.");
  }
  const config = validateConfig(
    "custom_code",
    {
      html: value.html,
      css: value.css,
      js: value.js,
      height_mode: value.height_mode,
      fixed_height: Number(value.fixed_height),
    },
    "draft",
  );
  const normalized =
    "error" in config ? null : (config.config as CustomCodeConfig);
  if (
    "error" in config ||
    !boundedText(value.page_slug, 60) ||
    !boundedText(value.page_title, 120) ||
    !boundedText(value.section_id, 128) ||
    typeof value.section_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.section_digest) ||
    Object.keys(value).some(
      (key) =>
        ![
          "page_slug",
          "page_title",
          "section_id",
          "section_digest",
          "html",
          "css",
          "js",
          "height_mode",
          "fixed_height",
        ].includes(key),
    ) ||
    !normalized ||
    normalized.html !== value.html ||
    normalized.css !== value.css ||
    normalized.js !== value.js ||
    normalized.height_mode !== value.height_mode ||
    String(normalized.fixed_height) !== value.fixed_height
  ) {
    throw new Error("The storefront code diff failed validation.");
  }
  return value as unknown as MinkStorefrontCodeActionValues;
}

const UNKNOWN_STOREFRONT_ACTION_OUTCOME =
  "StoreMink couldn't confirm whether the Builder draft was saved, so nothing was assumed. Approve this same request again—repeating it is safe and reports what actually happened.";

class StorefrontActionRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
    this.name = "StorefrontActionRequestError";
  }
}

function formatApprovalExpiry(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}
