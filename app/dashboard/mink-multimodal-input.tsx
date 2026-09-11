"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inputKind, MINK_INPUT_BYTES } from "@/lib/mink/input-policy";
import { Plus, Mic, Square, X, Upload, FileText, Loader2 } from "lucide-react";
import {
  decodeMinkDocument,
  DOCUMENT_BYTES,
  addReviewedMinkDocument,
} from "@/lib/mink/document-input";
import {
  startMinkSpeechRecognition,
  type MinkSpeechRecognitionSession,
  type MinkSpeechRecognitionState,
} from "@/lib/mink/speech-recognition";

const COMPOSER_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

export function MinkMultimodalInput({
  message,
  onAdd,
  disabled,
  children,
}: {
  message: string;
  onAdd: (message: string) => void;
  disabled: boolean;
  children?: (controls: { attach: ReactNode; voice: ReactNode }) => ReactNode;
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
  const [dictationState, setDictationState] =
    useState<MinkSpeechRecognitionState | null>(null);
  const dictationSession = useRef<MinkSpeechRecognitionSession | null>(null);
  const dictationOriginal = useRef("");
  const dictationBefore = useRef("");
  const dictationAfter = useRef("");
  const lastEmittedMessage = useRef("");
  const lastDictationText = useRef("");
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
    dictationSession.current?.cancel();
    dictationSession.current = null;
    setBusy(false);
    setDragging(false);
    dragDepth.current = 0;
    setDictationState(null);
    setFile(null);
    setText(null);
    setConsent(false);
    setReviewed(false);
    setError("");
  }
  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
      dictationSession.current?.cancel();
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
  // Starting a chat turn must not allow a late extraction to overwrite its composer.
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
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
    setOpen(true);
    const id = generation.current;
    try {
      if (/\.(txt|md)$/i.test(next.name)) {
        if (next.size > DOCUMENT_BYTES)
          throw new Error("Choose a text file up to 8 KiB.");
        setBusy(true);
        const decoded = decodeMinkDocument(next.name, await next.arrayBuffer());
        if (id !== generation.current) return;
        setLocalText(true);
        setText(decoded);
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
        if (await show()) setFile(next);
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
  function startDictation() {
    if (disabled || busy || dictationState) return;
    cancel();
    setOpen(false);
    setError("");
    const original = latestMessage.current.message;
    dictationOriginal.current = original;
    dictationBefore.current = original.trimEnd();
    if (dictationBefore.current) dictationBefore.current += " ";
    dictationAfter.current = "";
    lastEmittedMessage.current = original;
    lastDictationText.current = "";
    const controller = new AbortController();
    operation.current = controller;
    try {
      dictationSession.current = startMinkSpeechRecognition(controller.signal, {
        onState(state) {
          if (state === "stopped") {
            dictationSession.current = null;
            operation.current = null;
            setDictationState(null);
          } else {
            setDictationState(state);
          }
        },
        onText(speech) {
          const current = latestMessage.current;
          const previous = lastDictationText.current;
          let insert = speech;

          // The parent owns the textarea value, so reconcile any user typing
          // that happened between recognition events around the live phrase.
          // If the user edited the phrase itself, keep that edit and add only
          // newly recognised trailing words instead of restoring old speech.
          if (
            current.message !== lastEmittedMessage.current &&
            current.message !== dictationOriginal.current
          ) {
            const position = previous
              ? current.message.lastIndexOf(previous)
              : -1;
            if (position >= 0) {
              dictationBefore.current = current.message.slice(0, position);
              dictationAfter.current = current.message.slice(
                position + previous.length,
              );
            } else {
              const edited = current.message.trimEnd();
              dictationBefore.current = edited ? `${edited} ` : "";
              dictationAfter.current = "";
              insert = speech.startsWith(previous)
                ? speech.slice(previous.length).trimStart()
                : "";
            }
          }
          const combined = `${dictationBefore.current}${insert}${dictationAfter.current}`;
          if (combined.length > 4000) {
            dictationSession.current?.stop();
            setError(
              "Dictation stopped at the 4,000-character message limit. Shorten the message before continuing.",
            );
            return;
          }
          lastDictationText.current = speech;
          lastEmittedMessage.current = combined;
          current.onAdd(combined);
        },
        onError(message) {
          setError(message);
        },
      });
    } catch (e) {
      operation.current = null;
      setDictationState(null);
      setError(e instanceof Error ? e.message : "Microphone unavailable.");
    }
  }
  function stopDictation() {
    dictationSession.current?.stop();
  }
  function cancelDictation() {
    const original = dictationOriginal.current;
    dictationSession.current?.cancel();
    dictationSession.current = null;
    operation.current = null;
    setDictationState(null);
    latestMessage.current.onAdd(original);
  }
  async function processFile(source = file) {
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
      setFile(null);
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
      aria-label={dictationState ? "Stop dictation" : "Dictate message"}
      title={dictationState ? "Stop dictation" : "Dictate message"}
      disabled={disabled || busy}
      className={iconButton + (dictationState ? " bg-red-50 text-red-600" : "")}
      onClick={() => {
        if (dictationState) stopDictation();
        else startDictation();
      }}
    >
      {dictationState ? (
        <Square className="h-4 w-4 fill-current" aria-hidden="true" />
      ) : (
        <Mic className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );
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
          {file && (
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
              <button
                type="button"
                disabled={disabled || busy || !consent}
                onClick={() => void processFile()}
                className="rounded-full bg-[#6d4dff] px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                Process for review
              </button>
              <details className="text-xs leading-5 text-[#777]">
                <summary className="cursor-pointer">Privacy and limits</summary>
                One file up to 2 MiB: PNG/JPEG/WebP up to 12 MP or a plain PDF
                up to 10 pages. Text and Markdown documents are read locally up
                to 8 KiB. Remove secrets and customer details. Beta extraction
                deducts no AI credits but incurs provider usage and shared
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
                    onAdd(addReviewedMinkDocument(message, text));
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
              : "Listening — speech appears in the message box"}
          </span>
          <button
            type="button"
            className={iconButton}
            aria-label="Cancel dictation"
            title="Cancel and remove dictated text"
            onClick={cancelDictation}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={iconButton + " bg-white text-[#6d4dff]"}
            aria-label="Finish dictation"
            title="Finish dictation and keep text"
            onClick={stopDictation}
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
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
        children({ attach, voice })
      ) : (
        <div className="flex items-center justify-between">
          {attach}
          {voice}
        </div>
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
