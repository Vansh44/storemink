"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Loader2, Mic, Plus, Upload, X } from "lucide-react";
import {
  deleteMediaAsset,
  uploadMediaAsset,
  type MediaAsset,
} from "@/app/actions/media-actions";
import {
  addReviewedMinkDocument,
  decodeMinkDocument,
  DOCUMENT_BYTES,
} from "@/lib/mink/document-input";
import {
  inputKind,
  MINK_INPUT_BYTES,
  MINK_INPUT_FILES,
  MINK_MESSAGE_MAX_CHARS,
} from "@/lib/mink/input-policy";
import { addSavedMinkMediaReference } from "@/lib/mink/media-attachment";
import { startMinkRecording } from "@/lib/mink/voice-recorder";

const COMPOSER_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

type ComposerAttachment = {
  id: string;
  file: File;
  preview: string;
  localText: string | null;
  asset: MediaAsset | null;
  uploadState: "local" | "uploading" | "ready" | "error";
};

export function MinkMultimodalInput({
  message,
  onAdd,
  onSubmit,
  disabled,
  canSaveMedia = false,
  children,
}: {
  message: string;
  onAdd: (message: string) => void;
  onSubmit?: (message: string) => void;
  disabled: boolean;
  /** Resolved server-side; the upload action rechecks this permission. */
  canSaveMedia?: boolean;
  children?: (controls: {
    attach: ReactNode;
    attachment: ReactNode;
    voice: ReactNode;
    submit: () => Promise<void>;
  }) => ReactNode;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const uploadPromises = useRef(new Map<string, Promise<MediaAsset | null>>());
  const removedAttachmentIds = useRef(new Set<string>());
  const [submitting, setSubmitting] = useState(false);
  const [dictationState, setDictationState] = useState<
    "starting" | "listening" | "processing" | null
  >(null);
  const [error, setError] = useState("");
  const latestMessage = useRef({ message, onAdd });
  const operation = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    latestMessage.current = { message, onAdd };
  }, [message, onAdd]);

  function updateAttachments(
    updater: (current: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }

  function removeAttachment(id: string) {
    const attachment = attachmentsRef.current.find((item) => item.id === id);
    if (!attachment) return;
    removedAttachmentIds.current.add(id);
    updateAttachments((current) => current.filter((item) => item.id !== id));
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    if (attachment.asset) void deleteMediaAsset(attachment.asset.id);
    if (previewId === id) setPreviewId(null);
  }

  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
      for (const attachment of attachmentsRef.current) {
        removedAttachmentIds.current.add(attachment.id);
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        if (attachment.asset) void deleteMediaAsset(attachment.asset.id);
      }
    },
    [],
  );

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!dictationState) return;
    const hide = () => {
      if (document.hidden) cancelDictation();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [dictationState]);

  // A missed file drop must not navigate away from the dashboard.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files"))
        event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        !Array.from(event.dataTransfer?.types ?? []).includes("Files")
      )
        return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!disabled && !submitting && !dictationState) {
        setError(
          `Drop up to ${MINK_INPUT_FILES} files onto the message box, or use the plus button.`,
        );
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [disabled, submitting, dictationState]);

  async function choose(nextFiles: File[]) {
    if (disabled || submitting || dictationState || !nextFiles.length) return;
    setError("");
    const remaining = MINK_INPUT_FILES - attachmentsRef.current.length;
    if (nextFiles.length > remaining) {
      setError(
        `Attach up to ${MINK_INPUT_FILES} files at a time. Remove a file before adding another.`,
      );
      return;
    }
    const staged: ComposerAttachment[] = [];
    try {
      for (const next of nextFiles) {
        let localText: string | null = null;
        const image = /\.(png|jpe?g|webp)$/i.test(next.name);
        if (/\.(txt|md)$/i.test(next.name)) {
          if (next.size > DOCUMENT_BYTES)
            throw new Error("Choose a text file up to 8 KiB.");
          localText = decodeMinkDocument(next.name, await next.arrayBuffer());
        } else {
          let kind;
          try {
            kind = inputKind(next.name);
          } catch {
            throw new Error(
              "Attach a PNG, JPEG, WebP or PDF, or a .txt or .md file.",
            );
          }
          if (kind === "audio")
            throw new Error(
              "Use the microphone button for speech to text. Attach a PNG, JPEG, WebP or PDF here.",
            );
          if (!next.size || next.size > MINK_INPUT_BYTES)
            throw new Error("Choose a non-empty file up to 5 MiB.");
        }
        staged.push({
          id: crypto.randomUUID(),
          file: next,
          preview: image ? URL.createObjectURL(next) : "",
          localText,
          asset: null,
          uploadState: image && canSaveMedia ? "uploading" : "local",
        });
      }
      updateAttachments((current) => [...current, ...staged]);
      for (const attachment of staged) {
        if (attachment.preview && canSaveMedia)
          void startUpload(attachment.id).catch((cause) =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not upload this image.",
            ),
          );
      }
    } catch (e) {
      for (const attachment of staged) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      setError(e instanceof Error ? e.message : "Unsupported file.");
    }
  }

  async function startUpload(id: string): Promise<MediaAsset | null> {
    const pending = uploadPromises.current.get(id);
    if (pending) return pending;
    const attachment = attachmentsRef.current.find((item) => item.id === id);
    if (!attachment?.preview || !canSaveMedia) return attachment?.asset ?? null;
    if (attachment.asset) return attachment.asset;
    updateAttachments((current) =>
      current.map((item) =>
        item.id === id ? { ...item, uploadState: "uploading" } : item,
      ),
    );
    const promise = (async () => {
      const form = new FormData();
      form.set("file", attachment.file);
      const result = await uploadMediaAsset(form);
      if (result.error || !result.asset)
        throw new Error(result.error || "Could not upload this image.");
      if (removedAttachmentIds.current.has(id)) {
        await deleteMediaAsset(result.asset.id);
        return null;
      }
      updateAttachments((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, asset: result.asset!, uploadState: "ready" }
            : item,
        ),
      );
      return result.asset;
    })();
    uploadPromises.current.set(id, promise);
    try {
      return await promise;
    } catch (cause) {
      updateAttachments((current) =>
        current.map((item) =>
          item.id === id ? { ...item, uploadState: "error" } : item,
        ),
      );
      throw cause;
    } finally {
      uploadPromises.current.delete(id);
    }
  }

  async function startDictation() {
    if (disabled || submitting || dictationState) return;
    setError("");
    const id = generation.current;
    const controller = new AbortController();
    operation.current = controller;
    setDictationState("starting");
    try {
      await startMinkRecording(
        controller.signal,
        (recording) => {
          if (id !== generation.current || controller.signal.aborted) return;
          if (!recording) {
            operation.current = null;
            setDictationState(null);
            setError("No speech was recorded. Try again or type your message.");
            return;
          }
          setDictationState("processing");
          void transcribeRecording(recording, id, controller);
        },
        () => {
          if (id === generation.current) setDictationState("listening");
        },
      );
      if (id === generation.current) setDictationState("listening");
    } catch (e) {
      if (id === generation.current) {
        operation.current = null;
        setDictationState(null);
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Microphone unavailable.");
      }
    }
  }

  async function transcribeRecording(
    recording: File,
    id: number,
    controller: AbortController,
  ) {
    try {
      const response = await fetch("/api/mink/voice", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Mink-Request-Key": crypto.randomUUID(),
        },
        body: recording,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (id !== generation.current) return;
      if (!response.ok || typeof data.text !== "string" || !data.text.trim())
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Voice transcription failed. Try again or type your message.",
        );
      const current = latestMessage.current;
      const before = current.message.trimEnd();
      const transcript = data.text.trim();
      const combined = before ? `${before} ${transcript}` : transcript;
      if (combined.length > MINK_MESSAGE_MAX_CHARS)
        throw new Error(
          `The transcript does not fit in the ${MINK_MESSAGE_MAX_CHARS.toLocaleString()}-character message limit. Shorten the message and try again.`,
        );
      current.onAdd(combined);
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Voice transcription failed. Try again or type your message.",
        );
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setDictationState(null);
      }
    }
  }

  function cancelDictation() {
    generation.current++;
    operation.current?.abort();
    operation.current = null;
    setDictationState(null);
  }

  async function extractAttachment(
    source: File,
    mode: "extract" | "design",
    id: number,
    controller: AbortController,
    maxCharacters: number,
  ) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    if (id !== generation.current)
      throw new DOMException("Aborted", "AbortError");
    const response = await fetch("/api/mink/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      cache: "no-store",
      body: JSON.stringify({
        name: source.name,
        data: btoa(binary),
        requestKey: crypto.randomUUID(),
        // Send is explicit permission to process this visible attachment. It
        // never counts as approval for a product/storefront mutation.
        confirmed: true,
        maxCharacters,
        ...(mode === "design" ? { mode } : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Could not process this attachment.",
      );
    if (
      typeof data.text !== "string" ||
      !data.text.trim() ||
      data.text.length > maxCharacters
    )
      throw new Error("The attachment returned an invalid result.");
    return data.text.trim();
  }

  async function submit() {
    const current = latestMessage.current.message.trim();
    if (dictationState || !current || disabled || submitting || !onSubmit)
      return;
    const staged = attachmentsRef.current;
    if (!staged.length) {
      onSubmit(current);
      return;
    }

    setSubmitting(true);
    setError("");
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    try {
      if (
        staged.some((attachment) => Boolean(attachment.preview)) &&
        shouldUseMinkImageOnStorefront(current) &&
        !canSaveMedia
      )
        throw new Error(
          "You need permission to add Media Library images before Mink can use this image for a product or storefront change.",
        );

      let prepared = current;
      const providerCount = staged.filter(
        (attachment) => attachment.localText === null,
      ).length;
      const maxCharacters = Math.min(
        2200,
        Math.max(200, Math.floor(7500 / Math.max(1, providerCount))),
      );
      for (const attachment of staged) {
        const image = Boolean(attachment.preview);
        const asset =
          attachment.asset ??
          (image && canSaveMedia ? await startUpload(attachment.id) : null);
        if (id !== generation.current) return;
        if (asset)
          prepared = addSavedMinkMediaReference(prepared, {
            url: asset.url,
            filename: asset.filename || attachment.file.name,
          });

        const extracted =
          attachment.localText ??
          (await extractAttachment(
            attachment.file,
            image && shouldReadMinkImageAsStorefrontDesign(current)
              ? "design"
              : "extract",
            id,
            controller,
            maxCharacters,
          ));
        prepared = addReviewedMinkDocument(prepared, extracted, {
          filename: attachment.file.name,
          kind: image ? "image" : "document",
        });
      }
      if (id !== generation.current) return;
      for (const attachment of staged) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      attachmentsRef.current = [];
      setAttachments([]);
      setPreviewId(null);
      latestMessage.current.onAdd(prepared);
      onSubmit(prepared);
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Could not process this attachment.",
        );
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setSubmitting(false);
      }
    }
  }

  const iconButton =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#666] transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] disabled:cursor-not-allowed disabled:opacity-40";
  const attach = (
    <button
      type="button"
      aria-label="Add image or document"
      title="Add image or document"
      disabled={
        disabled ||
        submitting ||
        Boolean(dictationState) ||
        attachments.length >= MINK_INPUT_FILES
      }
      className={iconButton}
      onClick={() => fileRef.current?.click()}
    >
      <Plus className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  const voice = (
    <button
      type="button"
      aria-label={dictationState ? "Dictation in progress" : "Dictate message"}
      title={dictationState ? "Dictation in progress" : "Dictate message"}
      disabled={disabled || submitting || Boolean(dictationState)}
      className={iconButton}
      onClick={() => void startDictation()}
    >
      <Mic className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  const attachment = attachments.length ? (
    <div className="mb-2 flex max-w-full flex-wrap gap-2">
      {attachments.map((item) =>
        item.preview ? (
          <div key={item.id} className="relative h-16 w-16">
            <button
              type="button"
              className="h-16 w-16 overflow-hidden rounded-xl border border-[#dedede] bg-[#f7f7f8] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
              aria-label={`View ${item.file.name}`}
              onClick={() => setPreviewId(item.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.preview}
                alt=""
                className="h-full w-full object-cover"
              />
              {(item.uploadState === "uploading" || submitting) && (
                <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white">
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              title="Remove attachment"
              disabled={submitting}
              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[#d7d7d7] bg-white text-[#555] shadow-sm hover:bg-[#f3f3f3] disabled:opacity-40"
              onClick={() => removeAttachment(item.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div
            key={item.id}
            className="flex min-w-52 max-w-full items-center gap-2 rounded-2xl border border-[#dedede] bg-[#f7f7f8] p-2 pr-2.5 text-left shadow-sm"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-label={`View ${item.file.name}`}
              onClick={() => setPreviewId(item.id)}
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-[#6d4dff]">
                {submitting ? (
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FileText className="h-5 w-5" aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[#252525]">
                  {item.file.name}
                </span>
                <span className="block text-xs text-[#777]">
                  {submitting
                    ? "Processing attachment…"
                    : `${Math.max(1, Math.round(item.file.size / 1024))} KiB`}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              title="Remove attachment"
              disabled={submitting}
              className={iconButton}
              onClick={() => removeAttachment(item.id)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ),
      )}
    </div>
  ) : null;

  const previewAttachment = attachments.find((item) => item.id === previewId);

  return (
    <div
      className="relative min-w-0"
      aria-label="Mink AI composer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && dictationState) {
          event.stopPropagation();
          cancelDictation();
        } else if (event.key === "Escape" && previewId) {
          event.stopPropagation();
          setPreviewId(null);
        }
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        if (!disabled && !submitting && !dictationState) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          disabled || submitting || dictationState ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (disabled || submitting || dictationState) return;
        void choose(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={COMPOSER_FILE_ACCEPT}
        aria-label="Choose image or document"
        className="sr-only"
        tabIndex={-1}
        disabled={
          disabled ||
          submitting ||
          Boolean(dictationState) ||
          attachments.length >= MINK_INPUT_FILES
        }
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void choose(files);
        }}
      />
      {previewAttachment && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Attachment preview: ${previewAttachment.file.name}`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewId(null)}
        >
          <div
            className="relative max-h-[90dvh] max-w-4xl overflow-auto rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close attachment preview"
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white"
              onClick={() => setPreviewId(null)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            {previewAttachment.preview ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={previewAttachment.preview}
                alt={previewAttachment.file.name}
                className="max-h-[78dvh] max-w-full rounded-xl object-contain"
              />
            ) : (
              <div className="flex min-h-52 min-w-64 flex-col items-center justify-center gap-3 rounded-xl bg-[#f6f4fb] p-8 text-center">
                <FileText
                  className="h-10 w-10 text-[#6d4dff]"
                  aria-hidden="true"
                />
                <p className="max-w-sm break-all text-sm font-medium text-[#252525]">
                  {previewAttachment.file.name}
                </p>
                <p className="text-xs text-[#777]">
                  {Math.max(1, Math.round(previewAttachment.file.size / 1024))}{" "}
                  KiB
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      {dictationState && (
        <div
          role="status"
          aria-live="polite"
          className="mb-3 flex items-center gap-3 rounded-2xl border border-[#e5e5e5] bg-[#f7f7f7] px-4 py-3 text-sm text-[#333]"
        >
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
          </span>
          <span className="min-w-0 flex-1">
            {dictationState === "starting"
              ? "Starting microphone…"
              : dictationState === "processing"
                ? "Converting speech to editable text…"
                : "Listening… pause when you are finished."}
          </span>
          <button
            type="button"
            className={iconButton}
            aria-label="Cancel dictation"
            title="Cancel dictation"
            onClick={cancelDictation}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}
      {children ? (
        children({ attach, attachment, voice, submit })
      ) : (
        <>
          {attachment}
          <div className="flex items-center justify-between">
            {attach}
            {voice}
          </div>
        </>
      )}
      {dragging && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#6d4dff] bg-[#f6f2ff]/95 p-4 text-sm font-medium text-[#6d4dff]"
        >
          <Upload className="h-5 w-5" aria-hidden="true" />
          Drop up to five images or documents here
        </div>
      )}
    </div>
  );
}

/** Product images and storefront placements need a durable exact URL. */
export function shouldUseMinkImageOnStorefront(message: string) {
  const destination =
    /\b(?:home\s?page|storefront|website|web\s?page|hero|banner|carousel|gallery|section)\b/i;
  const placement =
    /\b(?:use|add|put|place|show|feature|create|make|build|design|update|replace)\b/i;
  const directImageHandoff =
    /\b(?:(?:this|here)(?:\s+is|'s)|attached|uploaded|provided)\b.{0,40}\b(?:product\s+)?(?:image|photo|picture)\b|\b(?:use|take|keep|save|add|place|show|feature)\s+(?:this|the|my)\s+(?:product\s+)?(?:image|photo|picture)\b/i;
  const productCreation =
    /\b(?:create|add|make|set\s*up)\b.{0,60}\b(?:new\s+)?product\b|\bproduct\b.{0,60}\b(?:create|add|make|set\s*up)\b/i;
  return (
    (destination.test(message) && placement.test(message)) ||
    directImageHandoff.test(message) ||
    productCreation.test(message)
  );
}

/** Exact style requests benefit from the validated design-token reader. */
export function shouldReadMinkImageAsStorefrontDesign(message: string) {
  return (
    /\b(?:storefront|website|web\s?page|home\s?page|landing\s?page)\b/i.test(
      message,
    ) &&
    /\b(?:design|redesign|restyle|style|colou?r|palette|font|typeface|radius|rounded|look\s+like|match)\b/i.test(
      message,
    )
  );
}
