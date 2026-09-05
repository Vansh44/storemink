"use client";

import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import type { CustomCodeConfig } from "@/lib/sections/registry";
import type { MinkStorefrontCodeActionResult } from "@/lib/mink/storefront-code-action-types";
import {
  MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
  MINK_STOREFRONT_BROWSER_WIDTHS,
  minkStorefrontBrowserIdentity,
  type MinkStorefrontBrowserFrameResult,
  type MinkStorefrontBrowserValidation,
  type MinkStorefrontPublicationApproval,
  type MinkStorefrontPublicationResult,
  type MinkStorefrontPublicationValues,
} from "@/lib/mink/storefront-publication-types";

export function MinkStorefrontPublicationControls({
  draftId,
  patchDigest,
  config,
  savedAction,
  initialResult,
}: {
  draftId: string;
  patchDigest: string;
  config: CustomCodeConfig;
  savedAction: MinkStorefrontCodeActionResult | null;
  initialResult: MinkStorefrontPublicationResult | null;
}) {
  const [validationRun, setValidationRun] = useState<string | null>(null);
  const [frames, setFrames] = useState<{
    desktop?: MinkStorefrontBrowserFrameResult;
    mobile?: MinkStorefrontBrowserFrameResult;
  }>({});
  const [browserValidation, setBrowserValidation] =
    useState<MinkStorefrontBrowserValidation | null>(null);
  const [approval, setApproval] =
    useState<MinkStorefrontPublicationApproval | null>(null);
  const [publicationResult, setPublicationResult] =
    useState<MinkStorefrontPublicationResult | null>(initialResult);
  const [busy, setBusy] = useState<
    "checks" | "preview_publish" | "preview_rollback" | "execute" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPublicationResult(initialResult), [initialResult]);

  useEffect(() => {
    if (!validationRun || !frames.desktop || !frames.mobile) return;
    const desktop = withoutToken(frames.desktop);
    const mobile = withoutToken(frames.mobile);
    setBrowserValidation({
      schemaVersion: MINK_STOREFRONT_BROWSER_VALIDATION_VERSION,
      patchDigest,
      checkedAt: new Date().toISOString(),
      browser: minkStorefrontBrowserIdentity(navigator.userAgent),
      viewports: { desktop, mobile },
    });
    setBusy(null);
  }, [frames.desktop, frames.mobile, patchDigest, validationRun]);

  useEffect(() => {
    if (
      !validationRun ||
      busy !== "checks" ||
      (frames.desktop && frames.mobile)
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setBusy(null);
      setError(
        "The isolated browser checks did not finish. Reload the proposal and run them again.",
      );
    }, 8_000);
    return () => window.clearTimeout(timeout);
  }, [busy, frames.desktop, frames.mobile, validationRun]);

  if (!savedAction && !publicationResult) return null;

  const checksPassed = Boolean(
    browserValidation?.browser.supported &&
    browserValidation.viewports.desktop.passed &&
    browserValidation.viewports.mobile.passed,
  );
  const published = publicationResult?.approval.operation === "apply";
  const rolledBack = publicationResult?.approval.operation === "rollback";

  function runChecks() {
    setError(null);
    setApproval(null);
    setBrowserValidation(null);
    setFrames({});
    setValidationRun(crypto.randomUUID());
    setBusy("checks");
  }

  function receiveFrame(result: MinkStorefrontBrowserFrameResult) {
    if (result.token !== validationRun) return;
    setFrames((current) => ({ ...current, [result.viewport]: result }));
  }

  async function reviewPublication() {
    if (!savedAction || !browserValidation || !checksPassed) return;
    setBusy("preview_publish");
    setError(null);
    try {
      const response = await requestPublication(draftId, {
        action: "preview_publish",
        sourceApprovalId: savedAction.approval.id,
        idempotencyKey: crypto.randomUUID(),
        browserValidation,
      });
      setApproval(response.approval ?? null);
    } catch (requestError) {
      setError(
        messageOf(
          requestError,
          "The storefront publication could not be reviewed.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function reviewRollback() {
    if (!publicationResult || publicationResult.approval.operation !== "apply")
      return;
    setBusy("preview_rollback");
    setError(null);
    try {
      const response = await requestPublication(draftId, {
        action: "preview_rollback",
        sourceApprovalId: publicationResult.approval.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setApproval(response.approval ?? null);
    } catch (requestError) {
      setError(
        messageOf(requestError, "The exact rollback could not be reviewed."),
      );
    } finally {
      setBusy(null);
    }
  }

  async function execute() {
    if (!approval) return;
    const active = approval;
    setBusy("execute");
    setError(null);
    try {
      const response = await requestPublication(draftId, {
        action: "execute",
        approvalId: active.id,
      });
      if (!response.result)
        throw new Error("The publication response was incomplete.");
      setPublicationResult(response.result);
      setApproval(null);
    } catch (requestError) {
      if (
        requestError instanceof PublicationRequestError &&
        requestError.outcome === "unknown"
      ) {
        const reconciled = await reconcilePublication(draftId, active.id);
        if (reconciled) {
          setPublicationResult(reconciled);
          setApproval(null);
        } else {
          setError(
            "StoreMink couldn't confirm the publication outcome. Approve this same request again—repeating it is safe and reports the committed result.",
          );
        }
      } else {
        setApproval(null);
        setError(
          messageOf(requestError, "The storefront action was not applied."),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-[#d9d0ff] bg-[#faf8ff] p-3">
      <div className="flex items-start gap-2 text-[10px] leading-4 text-[#4d426d]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#5d3fe3]" />
        <div>
          <p className="font-semibold">Phase 7D · checked publication</p>
          <p className="mt-0.5">
            Publication uses a new approval and never reuses the Builder
            draft-save approval.
          </p>
        </div>
      </div>

      {rolledBack && publicationResult ? (
        <Outcome
          result={publicationResult}
          title="Exact prior storefront restored"
        />
      ) : published && publicationResult ? (
        <>
          <Outcome result={publicationResult} title="Storefront published" />
          {approval?.operation === "rollback" ? (
            <ApprovalBox approval={approval} busy={busy} onExecute={execute} />
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void reviewRollback()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[9px] font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-60"
            >
              {busy === "preview_rollback" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Review exact rollback
            </button>
          )}
        </>
      ) : approval?.operation === "apply" ? (
        <ApprovalBox approval={approval} busy={busy} onExecute={execute} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-lg text-[9px] leading-4 text-[#625b72]">
              Run the exact proposed section in isolated 1,280 px desktop and
              390 px mobile frames before requesting publication.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={runChecks}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#6d4dff] bg-white px-3 py-1.5 text-[9px] font-semibold text-[#5132d2] hover:bg-[#f5f1ff] disabled:opacity-60"
            >
              {busy === "checks" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              Run publication checks
            </button>
          </div>

          {validationRun ? (
            <div
              className="space-y-2"
              aria-label="Storefront publication browser checks"
            >
              {(["desktop", "mobile"] as const).map((viewport) => (
                <div
                  key={viewport}
                  className="overflow-auto rounded-lg border border-[#e6e0f4] bg-[#efedf4] p-1.5"
                >
                  <div
                    style={{ width: MINK_STOREFRONT_BROWSER_WIDTHS[viewport] }}
                    className="max-w-none overflow-hidden rounded bg-white"
                  >
                    <CustomCodeFrame
                      config={config}
                      strictNetworkIsolation
                      title={`${viewport} storefront publication validation`}
                      validation={{
                        token: validationRun,
                        viewport,
                        width: MINK_STOREFRONT_BROWSER_WIDTHS[viewport],
                        onResult: receiveFrame,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {browserValidation ? (
            <div
              className={`rounded-lg border p-2.5 text-[9px] leading-4 ${
                checksPassed
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
            >
              {checksPassed
                ? `Desktop, mobile, runtime, CSP and accessibility checks passed in ${browserValidation.browser.family} ${browserValidation.browser.major}.`
                : browserValidation.browser.supported
                  ? "One or more publication checks failed. Correct the proposal and generate a new one."
                  : "This browser is below the supported publication-check floor. Use a current Chrome, Edge, Firefox or Safari browser."}
            </div>
          ) : null}

          <button
            type="button"
            disabled={!checksPassed || busy !== null}
            onClick={() => void reviewPublication()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-[#4e32ca] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy === "preview_publish" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            Review storefront publication
          </button>
        </>
      )}

      {error ? (
        <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[9px] leading-4 text-rose-800">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalBox({
  approval,
  busy,
  onExecute,
}: {
  approval: MinkStorefrontPublicationApproval;
  busy: string | null;
  onExecute: () => Promise<void>;
}) {
  const rollback = approval.operation === "rollback";
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[9px] leading-4 text-amber-950">
      <div className="flex items-start gap-2">
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <p className="font-semibold">
            {rollback ? "Rollback" : "Publication"} approval expires{" "}
            {formatExpiry(approval.expiresAt)}
          </p>
          <p className="mt-1">
            {rollback
              ? "This restores only the exact prior published snapshot. The private Builder draft stays unchanged."
              : "This publishes the exact checked Builder draft snapshot. Any intervening change blocks execution."}
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void onExecute()}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 font-semibold text-white hover:bg-[#4e32ca] disabled:opacity-60"
          >
            {busy === "execute" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : rollback ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {rollback
              ? "Approve exact rollback"
              : "Approve and publish storefront"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Outcome({
  result,
  title,
}: {
  result: MinkStorefrontPublicationResult;
  title: string;
}) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-[9px] leading-4 text-emerald-900">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-1">Audit reference: {result.auditId}.</p>
          <a
            href={result.approval.resource.publicPath}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-semibold underline"
          >
            Open storefront <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

type PublicationMutation =
  | {
      action: "preview_publish";
      sourceApprovalId: string;
      idempotencyKey: string;
      browserValidation: MinkStorefrontBrowserValidation;
    }
  | {
      action: "preview_rollback";
      sourceApprovalId: string;
      idempotencyKey: string;
    }
  | { action: "execute"; approvalId: string };

async function requestPublication(
  draftId: string,
  mutation: PublicationMutation,
): Promise<{
  approval?: MinkStorefrontPublicationApproval;
  result?: MinkStorefrontPublicationResult;
}> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-publication`,
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
    throw new PublicationRequestError(
      "StoreMink couldn't reach Mink AI. Check your connection and try again.",
      "unknown",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new PublicationRequestError(
      response.status >= 500
        ? "StoreMink couldn't confirm the storefront publication outcome."
        : (readError(body) ?? "The storefront publication was rejected."),
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  try {
    if (!isRecord(body))
      throw new Error("The publication response was malformed.");
    if (mutation.action === "execute") {
      const result = readPublicationResult(body.result, draftId);
      if (result.approval.id !== mutation.approvalId)
        throw new Error("The publication result belongs to another approval.");
      return { result };
    }
    const approval = readPublicationApproval(body.approval, draftId);
    if (
      approval.status !== "pending" ||
      approval.sourceApprovalId !== mutation.sourceApprovalId ||
      approval.operation !==
        (mutation.action === "preview_publish" ? "apply" : "rollback")
    )
      throw new Error("The publication review does not match this request.");
    return { approval };
  } catch (error) {
    // A malformed success response can arrive after a committed write. Keep
    // the approval for reconciliation and idempotent replay in that case.
    if (mutation.action === "execute")
      throw new PublicationRequestError(
        "StoreMink couldn't confirm the storefront publication outcome.",
        "unknown",
      );
    throw error;
  }
}

async function reconcilePublication(draftId: string, approvalId: string) {
  try {
    const response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-code-preview`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isRecord(body) || !body.lastPublication) return null;
    const result = readPublicationResult(body.lastPublication, draftId);
    return result.approval.id === approvalId ? result : null;
  } catch {
    return null;
  }
}

export function readPublicationResult(
  value: unknown,
  draftId: string,
): MinkStorefrontPublicationResult {
  if (
    !isRecord(value) ||
    typeof value.auditId !== "string" ||
    !UUID_PATTERN.test(value.auditId) ||
    typeof value.repeated !== "boolean"
  ) {
    throw new Error("The storefront publication result failed validation.");
  }
  const approval = readPublicationApproval(value.approval, draftId);
  if (approval.status !== "executed")
    throw new Error("The storefront publication has not completed.");
  return {
    approval,
    auditId: value.auditId,
    repeated: value.repeated,
  };
}

function readPublicationApproval(
  value: unknown,
  draftId: string,
): MinkStorefrontPublicationApproval {
  if (
    !isRecord(value) ||
    !isRecord(value.resource) ||
    !isRecord(value.checks)
  ) {
    throw new Error("The storefront publication approval failed validation.");
  }
  const before = readValues(value.before);
  const after = readValues(value.after);
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.sourceApprovalId !== "string" ||
    !UUID_PATTERN.test(value.sourceApprovalId) ||
    value.toolName !== "publish_storefront_code" ||
    (value.operation !== "apply" && value.operation !== "rollback") ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      String(value.status),
    ) ||
    value.draftId !== draftId ||
    value.draftVersion !== 0 ||
    value.resource.type !== "storefront_page" ||
    typeof value.resource.id !== "string" ||
    !UUID_PATTERN.test(value.resource.id) ||
    !boundedText(value.resource.label, 200) ||
    typeof value.resource.dashboardPath !== "string" ||
    !value.resource.dashboardPath.startsWith("/dashboard/builder?") ||
    value.resource.publicPath !==
      (before.page_slug === "home" ? "/" : `/${before.page_slug}`) ||
    before.page_slug !== after.page_slug ||
    before.page_title !== after.page_title ||
    before.target_section_id !== after.target_section_id ||
    value.checks.staticChecksPassed !== true ||
    value.checks.browserChecksPassed !== true ||
    !validApprovalChecks(value.operation, value.checks) ||
    !boundedText(value.expiresAt, 40) ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    (value.executedAt !== null &&
      (typeof value.executedAt !== "string" ||
        Number.isNaN(Date.parse(value.executedAt)))) ||
    (value.status === "executed") !== (value.executedAt !== null)
  ) {
    throw new Error("The storefront publication approval failed validation.");
  }
  return {
    ...(value as unknown as MinkStorefrontPublicationApproval),
    before,
    after,
  };
}

function validApprovalChecks(
  operation: unknown,
  checks: Record<string, unknown>,
) {
  if (operation === "rollback") {
    return (
      checks.desktopWidth === 0 &&
      checks.mobileWidth === 0 &&
      checks.browserFamily === null &&
      checks.browserMajor === null
    );
  }
  return (
    checks.desktopWidth === MINK_STOREFRONT_BROWSER_WIDTHS.desktop &&
    checks.mobileWidth === MINK_STOREFRONT_BROWSER_WIDTHS.mobile &&
    ["chromium", "firefox", "webkit"].includes(String(checks.browserFamily)) &&
    Number.isInteger(checks.browserMajor) &&
    Number(checks.browserMajor) > 0
  );
}

function readValues(value: unknown): MinkStorefrontPublicationValues {
  if (!isRecord(value))
    throw new Error("The page checkpoint failed validation.");
  const keys = [
    "page_slug",
    "page_title",
    "page_status",
    "published_at",
    "sections_digest",
    "target_section_id",
    "target_section_digest",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    !boundedText(value.page_slug, 60) ||
    !/^(?:home|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value.page_slug) ||
    !boundedText(value.page_title, 120) ||
    (value.page_status !== "draft" && value.page_status !== "published") ||
    !(
      value.published_at === null ||
      (typeof value.published_at === "string" &&
        !Number.isNaN(Date.parse(value.published_at)))
    ) ||
    typeof value.sections_digest !== "string" ||
    !SHA256_PATTERN.test(value.sections_digest) ||
    !boundedText(value.target_section_id, 128) ||
    typeof value.target_section_digest !== "string" ||
    !SHA256_PATTERN.test(value.target_section_digest)
  ) {
    throw new Error("The page checkpoint failed validation.");
  }
  return value as unknown as MinkStorefrontPublicationValues;
}

function withoutToken(result: MinkStorefrontBrowserFrameResult) {
  return {
    viewport: result.viewport,
    width: result.width,
    passed: result.passed,
    issues: result.issues,
    runtimeErrorCount: result.runtimeErrorCount,
    cspViolationCount: result.cspViolationCount,
    horizontalOverflow: result.horizontalOverflow,
  };
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function readError(value: unknown) {
  return isRecord(value) && typeof value.error === "string"
    ? value.error.slice(0, 300)
    : null;
}

function formatExpiry(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

class PublicationRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
    this.name = "PublicationRequestError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
