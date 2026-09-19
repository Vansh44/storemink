"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inputKind, MINK_INPUT_BYTES } from "@/lib/mink/input-policy";
import {
  Plus,
  Mic,
  X,
  Upload,
  FileText,
  Loader2,
  Image as ImageIcon,
  Palette,
} from "lucide-react";
import {
  decodeMinkDocument,
  DOCUMENT_BYTES,
  addReviewedMinkDocument,
} from "@/lib/mink/document-input";
import {
  addSavedMinkMediaReference,
  readSavedMinkMediaReference,
} from "@/lib/mink/media-attachment";
import { uploadMediaAsset } from "@/app/actions/media-actions";
import { startMinkRecording } from "@/lib/mink/voice-recorder";

const COMPOSER_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

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
  /**
   * Whether this admin may add to the store's Media Library (`media` manage).
   *
   * ★ RESOLVED SERVER-SIDE AND PASSED DOWN, so the control is simply absent
   *   for someone who cannot use it. `uploadMediaAsset` re-checks the same
   *   permission and is the real boundary; this only stops a button that would
   *   always fail from being on screen -- CODEBASE.md §23's rule.
   */
  canSaveMedia?: boolean;
  children?: (controls: {
    attach: ReactNode;
    attachment: ReactNode;
    voice: ReactNode;
    submit: () => Promise<void>;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [localText, setLocalText] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>("");
  const [dictationState, setDictationState] = useState<
    "starting" | "listening" | "processing" | null
  >(null);
  const latestMessage = useRef({ message, onAdd });
  useEffect(() => {
    latestMessage.current = { message, onAdd };
  }, [message, onAdd]);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  function cancel() {
    generation.current++;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setOpen(false);
    setDragging(false);
    dragDepth.current = 0;
    setDictationState(null);
    setFile(null);
    setText(null);
    setConsent(false);
    setReviewed(false);
    setSaved("");
    setError("");
  }
  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!file || !/\.(png|jpe?g|webp)$/i.test(file.name)) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!dictationState) return;
    const hide = () => {
      if (document.hidden) cancelDictation();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [dictationState]);
  // A missed drop must not navigate away from the dashboard with unsaved work.
  // Other real drop targets keep ownership when they already handled the event.
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
      if (!disabled && !busy && !dictationState) {
        cancel();
        setOpen(true);
        setError("Drop one file onto the message box, or use the plus button.");
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [disabled, busy, dictationState]);
  async function choose(next: File) {
    if (disabled || busy || dictationState) return;
    cancel();
    const id = generation.current;
    try {
      if (/\.(txt|md)$/i.test(next.name)) {
        if (next.size > DOCUMENT_BYTES)
          throw new Error("Choose a text file up to 8 KiB.");
        setBusy(true);
        const decoded = decodeMinkDocument(next.name, await next.arrayBuffer());
        if (id !== generation.current) return;
        setFile(next);
        setLocalText(true);
        setText(decoded);
        setOpen(false);
      } else {
        // ★ THE COMPOSER MUST NOT OFFER WAV IN ITS OWN ERROR. `inputKind` is
        // shared with the input API, which still validates a WAV (compatibility
        // code), so its throw names one — and this control refuses every audio
        // file. Surfacing that message told a merchant to attach something they
        // would then be refused: the same mismatch the published guide had.
        // The classifier stays shared; only the wording is ours.
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
          throw new Error("Choose one non-empty file up to 2 MiB.");
        setLocalText(false);
        // An admin who may add Media does not need the extraction provider in
        // order to attach an image to a storefront task. Stage it immediately,
        // like a normal chat attachment; the Send path below uploads it only
        // when the message identifies it as an image to use. Opening the card
        // remains available for optional OCR/review.
        if (kind === "image" && canSaveMedia) {
          setFile(next);
          setOpen(false);
          return;
        }
        if (await show()) {
          setFile(next);
          setOpen(false);
        }
      }
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : "Unsupported file.");
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  async function show() {
    setOpen(true);
    setError("");
    setBusy(true);
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    try {
      const response = await fetch("/api/mink/input", {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (id !== generation.current) return;

      if (!response.ok || data.enabled !== true)
        setError(
          "Image and PDF processing is not enabled for this store or deployment. Text documents still work.",
        );
      return response.ok && data.enabled === true;
    } catch {
      if (id === generation.current)
        setError("Could not check input availability.");
      return false;
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  async function startDictation() {
    if (disabled || busy || dictationState) return;
    cancel();
    setOpen(false);
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
      if (combined.length > 4_000)
        throw new Error(
          "The transcript does not fit in the 4,000-character message limit. Shorten the message and try again.",
        );
      // A completed recording produces one final transcript and one composer
      // update. There are no cumulative interim events to append repeatedly.
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
  /**
   * ★ `mode` picks WHAT is read, not whether it is sent. Both go through the
   * same consented, size-capped, rate-limited endpoint and the same isolated
   * reader; "design" returns exact validated colours, typefaces and radii
   * instead of prose, which is what the chat needs to actually propose a
   * design rather than guess at one from a description.
   */
  async function processFile(
    source = file,
    mode: "extract" | "design" = "extract",
  ) {
    if (!source || !consent || busy || disabled) return;
    setBusy(true);
    setError("");
    setText(null);
    setReviewed(false);
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    try {
      const bytes = new Uint8Array(await source.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      if (id !== generation.current) return;
      const response = await fetch("/api/mink/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          name: source.name,
          data: btoa(binary),
          requestKey: crypto.randomUUID(),
          confirmed: true,
          ...(mode === "design" ? { mode } : {}),
        }),
      });
      const data = await response.json();
      if (id !== generation.current) return;
      if (!response.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Could not process this input.",
        );
      if (
        typeof data.text !== "string" ||
        !data.text.trim() ||
        data.text.length > 3000
      )
        throw new Error("The input returned an invalid result.");
      setText(data.text);
    } catch (e) {
      if (id === generation.current)
        setError(
          e instanceof Error ? e.message : "Could not process this input.",
        );
    } finally {
      if (id === generation.current) {
        setBusy(false);
        setConsent(false);
      }
    }
  }
  /**
   * Save the staged image into the store's Media Library.
   *
   * ★ SEPARATE FROM EXTRACTION IN BOTH DIRECTIONS. It does not need the Vertex
   *   consent (nothing is sent to a provider) and it does not consume the
   *   attachment (the merchant may still extract text from it afterwards), so
   *   `file` is deliberately left in place. Only the SAVED banner changes.
   *
   * ★ THE REFERENCE GOES INTO THE COMPOSER, not just a toast: the exact URL is
   *   what a layout proposal has to cite, and re-finding it costs the model a
   *   Media Library read and a guess.
   */
  async function saveToMediaLibrary() {
    if (!file || busy || disabled || !canSaveMedia) return;
    setBusy(true);
    setError("");
    const id = ++generation.current;
    try {
      const form = new FormData();
      form.set("file", file);
      const result = await uploadMediaAsset(form);
      if (id !== generation.current) return;
      if (result.error || !result.asset) {
        throw new Error(result.error || "Could not save this image.");
      }
      const asset = result.asset;
      setSaved(asset.url);
      // A message too long to hold the reference must not read as a failed
      // upload: the image IS saved, so the banner stands and only the append
      // is reported as the thing that did not happen.
      try {
        latestMessage.current.onAdd(
          addSavedMinkMediaReference(latestMessage.current.message, {
            url: asset.url,
            filename: asset.filename || file.name,
          }),
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Saved, but the reference could not be added to your message.",
        );
      }
    } catch (e) {
      if (id === generation.current) {
        setError(e instanceof Error ? e.message : "Could not save this image.");
      }
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }

  /**
   * Send like a chat composer: a staged attachment participates in this turn.
   * An image plus an explicit storefront placement request is merchant intent
   * to keep and use that image, so save it through the ordinary Media Library
   * action and give Mink its exact URL. Other attachments still require the
   * established review/consent step before their extracted text is sent.
   */
  async function submit() {
    const current = latestMessage.current.message.trim();
    if (dictationState) return;
    if (!current || disabled || busy || !onSubmit) return;
    if (!file) {
      onSubmit(current);
      return;
    }

    const image = /\.(png|jpe?g|webp)$/i.test(file.name);
    if (!image || !shouldUseMinkImageOnStorefront(current)) {
      setOpen(true);
      setError(
        image
          ? "Review this image before sending, or say where on your storefront Mink should use it."
          : "Review this attachment and add its reference before sending.",
      );
      return;
    }
    if (!canSaveMedia) {
      setOpen(true);
      setError(
        "You need permission to add Media Library images before Mink can use this attachment on the storefront.",
      );
      return;
    }

    setBusy(true);
    setError("");
    const source = file;
    const id = ++generation.current;
    try {
      let asset = { url: saved, filename: source.name };
      if (!saved) {
        const form = new FormData();
        form.set("file", source);
        const result = await uploadMediaAsset(form);
        if (id !== generation.current) return;
        if (result.error || !result.asset)
          throw new Error(result.error || "Could not save this image.");
        asset = {
          url: result.asset.url,
          filename: result.asset.filename || source.name,
        };
        setSaved(asset.url);
      }
      const prepared = readSavedMinkMediaReference(current)
        ? current
        : addSavedMinkMediaReference(current, asset);
      cancel();
      setOpen(false);
      latestMessage.current.onAdd(prepared);
      onSubmit(prepared);
    } catch (e) {
      if (id === generation.current) {
        setOpen(true);
        setError(e instanceof Error ? e.message : "Could not save this image.");
      }
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  const iconButton =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#666] transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] disabled:cursor-not-allowed disabled:opacity-40";
  const attach = (
    <button
      type="button"
      aria-label="Add image or document"
      title="Add image or document"
      disabled={disabled || busy || Boolean(dictationState)}
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
      disabled={disabled || busy || Boolean(dictationState)}
      className={iconButton}
      onClick={() => {
        void startDictation();
      }}
    >
      <Mic className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  const attachment = file ? (
    <div className="mb-2 flex max-w-full items-center gap-2 rounded-2xl border border-[#dedede] bg-[#f7f7f8] p-2 pr-2.5 text-left shadow-sm">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        aria-label={`Review ${file.name}`}
        onClick={() => setOpen(true)}
      >
        {preview ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={preview}
            alt=""
            className="h-12 w-12 shrink-0 rounded-xl object-cover"
          />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-[#6d4dff]">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-[#252525]">
            {file.name}
          </span>
          <span className="block text-xs text-[#777]">
            {saved
              ? "Saved to Media Library"
              : `${Math.max(1, Math.round(file.size / 1024))} KiB`}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        title="Remove attachment"
        className={iconButton}
        onClick={cancel}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  ) : null;
  return (
    <div
      className="relative min-w-0"
      aria-label="Mink AI composer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && dictationState) {
          event.stopPropagation();
          cancelDictation();
        } else if (event.key === "Escape" && open) {
          event.stopPropagation();
          cancel();
          setOpen(false);
        }
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        if (!disabled && !busy && !dictationState) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          disabled || busy || dictationState ? "none" : "copy";
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
        if (disabled || busy || dictationState) return;
        if (event.dataTransfer.files.length !== 1) {
          cancel();
          setOpen(true);
          setError("Add one file at a time.");
          return;
        }
        void choose(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept={COMPOSER_FILE_ACCEPT}
        aria-label="Choose image or document"
        className="sr-only"
        tabIndex={-1}
        disabled={disabled || busy || Boolean(dictationState)}
        onChange={(event) => {
          const files = event.target.files;
          const next = files?.[0];
          const count = files?.length ?? 0;
          event.target.value = "";
          if (count > 1) {
            cancel();
            setOpen(true);
            setError("Add one file at a time.");
          } else if (next) void choose(next);
        }}
      />
      {open && (
        <section
          aria-label="Review attachment"
          className="mb-3 max-h-[min(24rem,45dvh)] space-y-3 overflow-y-auto rounded-2xl border border-[#e5e5e5] bg-[#fafafa] p-4 text-sm text-[#444]"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 font-medium text-[#222]">
              <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {file?.name ?? "Review attachment"}
              </span>
            </span>
            <button
              type="button"
              aria-label="Close input"
              title="Discard and close"
              className={iconButton}
              onClick={() => {
                cancel();
                setOpen(false);
              }}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {busy && (
            <p role="status" className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Processing…
            </p>
          )}
          {file && text === null && (
            <>
              <p className="text-xs text-[#777]">
                {(file.size / 1024).toFixed(0)} KiB · Not uploaded yet
              </p>
              {preview && inputKind(file.name) === "image" && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={preview}
                  alt="Selected reference"
                  className="max-h-32 max-w-full rounded-lg object-contain"
                />
              )}
              <label className="flex items-start gap-2 text-xs leading-5">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  className="mt-1 accent-[#6d4dff]"
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I approve sending this file to Vertex AI for extraction.
                StoreMink will not save the raw file. Provider retention rules
                apply.
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={disabled || busy || !consent}
                  onClick={() => void processFile()}
                  className="rounded-full bg-[#6d4dff] px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
                >
                  Process for review
                </button>
                {inputKind(file.name) === "image" && (
                  <button
                    type="button"
                    disabled={disabled || busy || !consent}
                    onClick={() => void processFile(file, "design")}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#d5d5d5] bg-white px-4 py-2 text-xs font-medium text-[#333] hover:bg-[#f4f4f4] disabled:opacity-40"
                  >
                    <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                    Read design from image
                  </button>
                )}
                {canSaveMedia && inputKind(file.name) === "image" && (
                  <button
                    type="button"
                    disabled={disabled || busy || Boolean(saved)}
                    onClick={() => void saveToMediaLibrary()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#d5d5d5] bg-white px-4 py-2 text-xs font-medium text-[#333] hover:bg-[#f4f4f4] disabled:opacity-40"
                  >
                    <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {saved ? "Saved to Media Library" : "Save to Media Library"}
                  </button>
                )}
              </div>
              {inputKind(file.name) === "image" && (
                <p className="text-xs leading-5 text-[#777]">
                  <strong>Read design from image</strong> pulls the exact
                  colours, closest typefaces and corner radii out of a
                  screenshot so Mink can propose them. It reads the design only
                  — never the words, and never as instructions.
                </p>
              )}
              {canSaveMedia && inputKind(file.name) === "image" && !saved && (
                <p className="text-xs leading-5 text-[#777]">
                  Saving keeps this image in your Media Library so Mink can use
                  it on your storefront. It is a separate step from processing:
                  neither one requires the other.
                </p>
              )}
              {saved && (
                <p role="status" className="text-xs leading-5 text-emerald-700">
                  Saved to your Media Library and added to your message. Mink
                  can now place it on a page.
                </p>
              )}
              <details className="text-xs leading-5 text-[#777]">
                <summary className="cursor-pointer">Privacy and limits</summary>
                One file up to 2 MiB: PNG/JPEG/WebP up to 12 MP or a plain PDF
                up to 10 pages. Text and Markdown documents are read locally up
                to 8 KiB. Remove secrets and customer details. Beta extraction
                deducts no Mink credits but incurs provider usage and shared
                limits. Sending the reviewed text is a separate chat request.
              </details>
            </>
          )}
          {text !== null && (
            <>
              <p className="text-xs leading-5">
                {localText
                  ? "Read locally. Review before adding. Only this text is sent when you send your message; it is not saved as a memory or media file."
                  : "Check and correct the extracted text. Your chat will receive this text, not the original file."}{" "}
                Remove secrets and customer details.
              </p>
              <label className="block text-xs font-medium">
                {localText ? "Document text" : "Extracted reference"}
                <textarea
                  className="mt-1 block w-full rounded-xl border border-[#ddd] bg-white p-3 text-sm font-normal focus:outline-none focus:ring-2 focus:ring-[#6d4dff]"
                  rows={4}
                  maxLength={3000}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={reviewed}
                  className="accent-[#6d4dff]"
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed and corrected this text.
              </label>
              <button
                type="button"
                disabled={disabled || !reviewed}
                className="rounded-full bg-[#6d4dff] px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
                onClick={() => {
                  try {
                    onAdd(
                      addReviewedMinkDocument(message, text, {
                        filename: file?.name,
                        kind:
                          file && /\.(png|jpe?g|webp)$/i.test(file.name)
                            ? "image"
                            : "document",
                      }),
                    );
                    cancel();
                    setOpen(false);
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : "Shorten the reference.",
                    );
                  }
                }}
              >
                Add reviewed reference to message
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              cancel();
              setOpen(false);
            }}
            className="ml-2 text-xs text-[#777] hover:text-[#222]"
          >
            Discard input
          </button>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
        </section>
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
      {!open && error && (
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
          Drop one image or document here
        </div>
      )}
    </div>
  );
}

/**
 * Keep auto-persistence narrow: the message must both ask to place something
 * and name a storefront destination. Generic “what is in this image?” still
 * follows review-first extraction and never stores the raw attachment.
 */
export function shouldUseMinkImageOnStorefront(message: string) {
  const destination =
    /\b(?:home\s?page|storefront|website|web\s?page|hero|banner|carousel|gallery|section)\b/i;
  const placement =
    /\b(?:use|add|put|place|show|feature|create|make|build|design|update|replace)\b/i;
  const directImageHandoff =
    /\b(?:(?:this|here)(?:\s+is|'s)|attached|uploaded|provided)\b.{0,40}\b(?:product\s+)?(?:image|photo|picture)\b|\b(?:use|take|keep|save|add|place|show|feature)\s+(?:this|the|my)\s+(?:product\s+)?(?:image|photo|picture)\b/i;
  return (
    (destination.test(message) && placement.test(message)) ||
    directImageHandoff.test(message)
  );
}
