export type MinkSpeechRecognitionState = "starting" | "listening" | "stopped";

type SpeechAlternativeLike = { transcript: string };
type SpeechResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
};
type SpeechResultListLike = {
  readonly length: number;
  [index: number]: SpeechResultLike;
};
type SpeechResultEventLike = Event & {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
};
type SpeechErrorEventLike = Event & { readonly error?: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export type MinkSpeechRecognitionSession = {
  stop: () => void;
  cancel: () => void;
};

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed":
    "Microphone access was blocked. Allow microphone access for StoreMink in your browser and try again.",
  "service-not-allowed":
    "Speech recognition is blocked by this browser or device policy.",
  "audio-capture":
    "No working microphone was found. Check your device input and try again.",
  network:
    "Live speech recognition could not reach the browser speech service.",
  "language-not-supported":
    "Live speech recognition does not support your current browser language.",
};

/**
 * Start browser-owned live dictation. No raw audio is uploaded to StoreMink and
 * no chat request is sent: the browser recognition service emits editable text.
 */
export function startMinkSpeechRecognition(
  signal: AbortSignal,
  callbacks: {
    onText: (text: string) => void;
    onState: (state: MinkSpeechRecognitionState) => void;
    onError: (message: string) => void;
  },
): MinkSpeechRecognitionSession {
  if (!window.isSecureContext)
    throw new Error("Live dictation needs a secure HTTPS connection.");
  const Recognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition)
    throw new Error(
      "Live dictation is not supported by this browser. Use the latest Chrome or Edge, or type your message.",
    );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang =
    document.documentElement.lang || navigator.language || "en-IN";

  let active = true;
  const timer: { id?: ReturnType<typeof setTimeout> } = {};

  const cleanup = () => {
    clearTimeout(timer.id);
    signal.removeEventListener("abort", cancel);
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  };
  const finish = () => {
    if (!active) return;
    active = false;
    cleanup();
    callbacks.onState("stopped");
  };
  const stop = () => {
    if (!active) return;
    recognition.stop();
  };
  function cancel() {
    if (!active) return;
    recognition.abort();
    finish();
  }

  recognition.onstart = () => callbacks.onState("listening");
  recognition.onresult = (event) => {
    if (!active) return;
    const final: string[] = [];
    const interim: string[] = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result?.[0]?.transcript?.trim();
      if (!transcript) continue;
      (result.isFinal ? final : interim).push(transcript);
    }
    callbacks.onText([...final, ...interim].join(" ").trim());
  };
  recognition.onerror = (event) => {
    if (!active) return;
    const code = event.error ?? "unknown";
    // Chrome may emit no-speech while the user pauses. Keep the existing text
    // and let its following end event finish quietly instead of showing a red
    // failure for an ordinary pause.
    if (code !== "aborted" && code !== "no-speech") {
      callbacks.onError(
        ERROR_MESSAGES[code] ?? "Live speech recognition stopped unexpectedly.",
      );
    }
  };
  recognition.onend = finish;
  signal.addEventListener("abort", cancel, { once: true });
  callbacks.onState("starting");
  recognition.start();
  timer.id = setTimeout(stop, 60_000);

  return { stop, cancel };
}
