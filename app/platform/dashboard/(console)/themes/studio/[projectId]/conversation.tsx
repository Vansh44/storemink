"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import {
  queueThemeStudioGenerationAction,
  reviseThemeStudioVersionAction,
  submitThemeStudioDetailsAction,
  removeThemeStudioReferenceAction,
} from "@/app/actions/theme-studio-actions";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import { studioDate } from "../studio-ui";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";
const referenceUrl = (id: string) =>
  `/api/platform/theme-studio/references/${id}`;

export function ThemeConversation({
  project,
  generationEnabled,
  referenceLimit,
  target,
  canRevise,
  onSelectVersion,
  composerRef,
}: {
  project: ThemeStudioProjectDetail;
  generationEnabled: boolean;
  referenceLimit: number;
  target: ThemeStudioVersionView | null;
  canRevise: boolean;
  onSelectVersion: (id: string | null) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const router = useRouter();
  const latestRun = project.runs[0];
  const answering =
    project.status === "blocked" && Boolean(latestRun?.questions.length);
  const creating = project.status === "draft";
  const working = project.status === "generating";
  const [body, setBody] = useState(creating ? project.draftBrief : "");
  const [selected, setSelected] = useState<string[]>(() => {
    const previous = answering
      ? (project.messages.filter((message) => message.kind !== "images").at(-1)
          ?.referenceAssetIds ?? [])
      : [];
    return [
      ...new Set([
        ...previous,
        ...(creating
          ? project.references.filter((ref) => !ref.cited).map((ref) => ref.id)
          : []),
      ]),
    ].slice(0, referenceLimit);
  });
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [submittedRevision, setSubmittedRevision] = useState<number | null>(
    null,
  );
  const key = useRef(crypto.randomUUID());
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const editable =
    generationEnabled &&
    (creating || answering || canRevise) &&
    !working &&
    submittedRevision !== project.revision;
  const disabled = !editable || sending || uploading;
  const library = [
    ...new Set([...project.references.map((ref) => ref.id), ...uploaded]),
  ];

  useEffect(() => {
    // Keep the latest response in view without jumping the entire workspace.
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [project.messages.length, project.versions.length, project.status]);

  async function upload(files: File[]) {
    if (busy.current || disabled || files.length === 0) return;
    const room = referenceLimit - selected.length;
    if (files.length > room) {
      toast.error(
        `Attach up to ${referenceLimit} screenshots per message. Remove an attachment first.`,
      );
      return;
    }
    busy.current = true;
    setUploading(true);
    try {
      for (const file of files) {
        if (
          !ACCEPT.split(",").includes(file.type) ||
          file.size > 10 * 1024 * 1024
        ) {
          toast.error(
            `${file.name}: use a JPEG, PNG, WebP or AVIF image up to 10 MB.`,
          );
          continue;
        }
        try {
          const response = await fetch(
            `/api/platform/theme-studio/projects/${project.id}/references`,
            {
              method: "POST",
              body: file,
              headers: { "Content-Type": "application/octet-stream" },
            },
          );
          const result = (await response.json()) as {
            id?: string;
            error?: string;
          };
          if (!response.ok || !result.id)
            throw new Error(result.error ?? "Upload failed.");
          const id = result.id;
          setUploaded((ids) => [...new Set([...ids, id])]);
          setSelected((ids) => [...new Set([...ids, id])]);
        } catch (error) {
          toast.error(
            `${file.name}: ${error instanceof Error ? error.message : "Upload failed. Try again."}`,
          );
        }
      }
    } finally {
      busy.current = false;
      setUploading(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  async function send() {
    if (busy.current || disabled || !body.trim()) return;
    busy.current = true;
    setSending(true);
    try {
      const common = {
        projectId: project.id,
        expectedRevision: project.revision,
        body: body.trim(),
        referenceAssetIds: selected,
        idempotencyKey: key.current,
      };
      const result = creating
        ? await queueThemeStudioGenerationAction(common)
        : answering
          ? await submitThemeStudioDetailsAction(common)
          : target
            ? await reviseThemeStudioVersionAction({
                ...common,
                versionId: target.id,
                expectedPackageDigest: target.packageDigest ?? "",
              })
            : { ok: false, error: "Choose a version to change." };
      if (!result.ok) {
        toast.error(result.error ?? "Your message couldn't be sent.");
        return;
      }
      setSubmittedRevision(project.revision);
      setBody("");
      setSelected([]);
      key.current = crypto.randomUUID();
      onSelectVersion(null);
      router.refresh();
    } catch {
      toast.error(
        "Your message couldn't be confirmed. Try again; the same request won't run twice.",
      );
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  const timeline = [
    ...project.messages
      .filter((message) => message.kind !== "images" && !message.automatic)
      .map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        content: (
          <div className="ml-auto max-w-[90%] break-words rounded-2xl rounded-br-md bg-indigo-600 p-4 text-white">
            <p className="mb-1 text-xs text-indigo-100">
              You · {studioDate(message.createdAt)}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {message.body}
            </p>
            {message.referenceAssetIds?.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {message.referenceAssetIds.map((id, index) => (
                  <a
                    key={id}
                    href={referenceUrl(id)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open screenshot ${index + 1}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                    <img
                      src={referenceUrl(id)}
                      alt={`Attached screenshot ${index + 1}`}
                      className="h-20 w-28 rounded-lg border border-white/20 bg-white object-contain"
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ),
      })),
    ...project.versions
      .filter((version) => version.hasPackage)
      .map((version) => ({
        id: version.id,
        createdAt: version.createdAt,
        content: (
          <div className="mr-auto max-w-[90%] break-words rounded-2xl rounded-bl-md border border-slate-200 bg-white p-4">
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold text-indigo-700">
              <Sparkles className="h-3.5 w-3.5" />
              Theme Studio · Version {version.versionNumber}
            </p>
            <p className="text-sm leading-relaxed text-slate-700">
              {version.summary}
            </p>
            {version.qaStatus === "failed" ? (
              <p className="mt-2 text-xs text-amber-800">
                This draft needs attention: automatic QA did not pass. Review it
                and describe what to fix.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-3 text-sm font-medium">
              <Link
                href={`/dashboard/themes/studio/${project.id}/versions/${version.id}`}
                className="text-indigo-700 underline underline-offset-4"
              >
                Preview version {version.versionNumber}
              </Link>
              {canRevise ? (
                <button
                  type="button"
                  className="text-slate-600 underline underline-offset-4"
                  onClick={() => {
                    onSelectVersion(version.id);
                    composerRef.current?.focus();
                  }}
                >
                  Change this version
                </button>
              ) : null}
            </div>
          </div>
        ),
      })),
    ...project.runs
      .filter(
        (run) =>
          run.questions.length ||
          run.declineReason ||
          run.status === "failed" ||
          run.status === "cancelled",
      )
      .map((run) => ({
        id: `response-${run.id}`,
        createdAt: run.finishedAt ?? run.createdAt,
        content: (
          <div className="mr-auto max-w-[90%] break-words rounded-2xl rounded-bl-md border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <p className="mb-2 text-xs font-semibold text-indigo-700">
              Theme Studio
            </p>
            {run.questions.length ? (
              <>
                <p>I need a little more detail to continue:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {run.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                {run.declineReason ??
                  (run.status === "cancelled"
                    ? "This request was cancelled. Your previous versions are still available."
                    : "This request couldn't finish. Your previous versions are still available. See Runs below to retry or inspect the failure.")}
              </p>
            )}
          </div>
        ),
      })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section
      aria-label="Theme conversation"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          Build with Theme Studio
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Describe your theme, share screenshots, and keep refining it here.
        </p>
      </div>
      <div
        ref={log}
        className="max-h-[36rem] min-h-48 space-y-4 overflow-y-auto bg-slate-50/70 p-5"
        role="log"
        aria-label="Conversation history"
      >
        {timeline.length ? (
          timeline.map((entry) => <div key={entry.id}>{entry.content}</div>)
        ) : (
          <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700">
            Tell me what you want to build. You can attach inspiration
            screenshots now, then send screenshots of anything you want changed
            after the first version.
          </div>
        )}
        {working || submittedRevision === project.revision ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-indigo-700"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Working on your theme, images, and quality checks. You can leave
            this page and come back.
          </p>
        ) : null}
      </div>
      <form
        className="space-y-3 border-t border-slate-200 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            void upload(Array.from(event.dataTransfer.files));
          }
        }}
      >
        {canRevise && target ? (
          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            Editing
            <select
              aria-label="Version to change"
              value={target.id}
              disabled={disabled}
              onChange={(event) => onSelectVersion(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1"
            >
              {project.versions
                .filter((version) => version.hasPackage)
                .map((version) => (
                  <option key={version.id} value={version.id}>
                    Version {version.versionNumber}
                    {version.id === project.currentVersionId
                      ? " (current)"
                      : ""}
                  </option>
                ))}
            </select>
            <span>Each message creates a new version.</span>
          </label>
        ) : null}
        <textarea
          ref={composerRef}
          aria-label="Message Theme Studio"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={12000}
          disabled={disabled}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter(
              (file) => file.type.startsWith("image/"),
            );
            if (images.length) {
              event.preventDefault();
              void upload(images);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            answering
              ? "Reply to the questions above. You can attach screenshots too."
              : "Describe what to build or change. Paste or drop screenshots here…"
          }
          className="block min-h-28 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
        />
        {selected.length ? (
          <ul className="flex flex-wrap gap-2" aria-label="Message attachments">
            {selected.map((id, index) => (
              <li key={id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                <img
                  src={referenceUrl(id)}
                  alt={`Screenshot ${index + 1} to send`}
                  className="h-20 w-28 rounded-lg border border-slate-200 bg-slate-50 object-contain"
                />
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove screenshot ${index + 1} from message`}
                  className="absolute -right-1 -top-1 rounded-full border border-slate-200 bg-white p-1 text-slate-600"
                  onClick={() =>
                    setSelected((ids) => ids.filter((item) => item !== id))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            aria-label="Upload screenshots"
            className="sr-only"
            disabled={disabled}
            onChange={(event) =>
              void upload(Array.from(event.target.files ?? []))
            }
          />
          <button
            type="button"
            disabled={disabled || selected.length >= referenceLimit}
            onClick={() => input.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImagePlus className="h-4 w-4" />
            )}
            Attach screenshots{" "}
            <span className="text-xs text-slate-400">
              {selected.length}/{referenceLimit}
            </span>
          </button>
          <button
            type="submit"
            disabled={disabled || !body.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send message
          </button>
        </div>
        <p className="text-xs text-slate-500">
          JPEG, PNG, WebP or AVIF · 10 MB each · 40 MB per message. Ctrl/⌘ +
          Enter to send.
        </p>
        {!editable && !working && submittedRevision !== project.revision ? (
          <p className="text-xs text-amber-800">
            {!generationEnabled
              ? "Generation is currently switched off."
              : "This project cannot accept a new message right now. See Runs and Versions below for recovery options."}
          </p>
        ) : null}
        {library.length ? (
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer py-2">
              Reuse screenshots from this conversation ({library.length})
            </summary>
            <ul className="mt-2 grid max-h-60 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
              {library.map((id, index) => (
                <li key={id} className="rounded-lg border border-slate-200 p-2">
                  <label className="block cursor-pointer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                    <img
                      src={referenceUrl(id)}
                      alt={`Saved screenshot ${index + 1}`}
                      loading="lazy"
                      className="mb-2 h-20 w-full object-contain"
                    />
                    <input
                      type="checkbox"
                      checked={selected.includes(id)}
                      disabled={
                        disabled ||
                        (!selected.includes(id) &&
                          selected.length >= referenceLimit)
                      }
                      onChange={(event) =>
                        setSelected((ids) =>
                          event.target.checked
                            ? [...ids, id]
                            : ids.filter((item) => item !== id),
                        )
                      }
                    />{" "}
                    Attach screenshot {index + 1}
                  </label>
                  {project.references.some(
                    (ref) => ref.id === id && !ref.cited,
                  ) ? (
                    <button
                      type="button"
                      disabled={disabled}
                      className="mt-2 text-red-700 underline"
                      onClick={async () => {
                        if (busy.current) return;
                        busy.current = true;
                        setUploading(true);
                        try {
                          const result = await removeThemeStudioReferenceAction(
                            { projectId: project.id, assetId: id },
                          );
                          if (!result.ok) {
                            toast.error(
                              result.error ?? "Could not delete screenshot.",
                            );
                            return;
                          }
                          setSelected((ids) =>
                            ids.filter((item) => item !== id),
                          );
                          setUploaded((ids) =>
                            ids.filter((item) => item !== id),
                          );
                          router.refresh();
                        } catch {
                          toast.error("Could not delete screenshot.");
                        } finally {
                          busy.current = false;
                          setUploading(false);
                        }
                      }}
                    >
                      Delete unused upload
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </form>
    </section>
  );
}
