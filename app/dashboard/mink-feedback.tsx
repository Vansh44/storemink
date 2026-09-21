"use client";

import {
  Check,
  Copy,
  LoaderCircle,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useState } from "react";
import type { MinkFeedbackIssue, MinkFeedbackRating } from "@/lib/mink/types";
import type { MinkMessage, MinkUiError } from "./mink-ai";

const ISSUES: Array<{ id: MinkFeedbackIssue; label: string }> = [
  { id: "incorrect", label: "Incorrect" },
  { id: "missing_context", label: "Missing context" },
  { id: "privacy", label: "Privacy concern" },
  { id: "slow", label: "Too slow" },
  { id: "other", label: "Other" },
];

export function MinkFeedbackControls({
  message,
  submitting,
  submit,
}: {
  message: MinkMessage;
  submitting: boolean;
  submit: (input: {
    runId: string;
    rating: MinkFeedbackRating;
    issueCategory?: MinkFeedbackIssue | null;
    details?: string;
  }) => Promise<MinkUiError | null>;
}) {
  const [reporting, setReporting] = useState(false);
  const [issue, setIssue] = useState<MinkFeedbackIssue>("incorrect");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!message.runId) return null;
  const selected = message.feedback?.rating;

  const sendHelpful = async () => {
    setError(null);
    const failure = await submit({ runId: message.runId!, rating: "helpful" });
    if (failure) setError(failure.message);
    else setReporting(false);
  };
  const sendReport = async () => {
    setError(null);
    const failure = await submit({
      runId: message.runId!,
      rating: "unhelpful",
      issueCategory: issue,
      details,
    });
    if (failure) setError(failure.message);
    else setReporting(false);
  };

  return (
    <div className="mink-feedback mt-1.5">
      <div className="flex items-center gap-1 text-[#8c9196]">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            } catch {
              setCopied(false);
            }
          }}
          aria-label="Copy answer"
          className="rounded-md p-1.5 hover:bg-[#f1f1f1]"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-700" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void sendHelpful()}
          aria-label="Helpful answer"
          className={`rounded-md p-1.5 hover:bg-[#f1f1f1] ${selected === "helpful" ? "bg-emerald-50 text-emerald-700" : ""}`}
        >
          {submitting && selected !== "unhelpful" ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : selected === "helpful" ? (
            <Check className="h-3 w-3" />
          ) : (
            <ThumbsUp className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => setReporting((value) => !value)}
          aria-label="Report an issue with this answer"
          className={`rounded-md p-1.5 hover:bg-[#f1f1f1] ${selected === "unhelpful" ? "bg-rose-50 text-rose-700" : ""}`}
        >
          <ThumbsDown className="h-3 w-3" />
        </button>
        {selected ? (
          <span className="ml-1 text-[10px]">Feedback saved</span>
        ) : null}
      </div>
      {reporting ? (
        <div className="mt-2 rounded-xl border border-[#e4e0ef] bg-white p-3 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-[#3e3262]">
            What went wrong?
            <button
              type="button"
              onClick={() => setReporting(false)}
              aria-label="Close issue report"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ISSUES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setIssue(item.id)}
                className={`rounded-full border px-2 py-1 text-[10px] ${issue === item.id ? "border-[#6d4dff] bg-[#f4f0ff] text-[#4d2db7]" : "border-[#dedede] text-[#6d7175]"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Optional details—do not include passwords, OTPs, or customer data"
            className="mt-2 w-full resize-none rounded-lg border border-[#dedede] px-2.5 py-2 text-xs outline-none focus:border-[#6d4dff]"
          />
          {error ? (
            <div role="alert" className="mt-1 text-[10px] text-rose-700">
              {error}
            </div>
          ) : null}
          <button
            type="button"
            disabled={submitting}
            onClick={() => void sendReport()}
            className="mt-2 inline-flex items-center gap-1 rounded-lg bg-[#6d4dff] px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {submitting ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : null}{" "}
            Send report
          </button>
        </div>
      ) : null}
    </div>
  );
}
