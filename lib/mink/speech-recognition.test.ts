import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMinkSpeechRecognition } from "./speech-recognition";

const h = {
  instance: null as null | {
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    lang: string;
    onstart: ((event: Event) => void) | null;
    onresult: ((event: Event & { results: unknown }) => void) | null;
    onerror: ((event: Event & { error?: string }) => void) | null;
    onend: ((event: Event) => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  },
};

class Recognition {
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  lang = "";
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: Event & { results: unknown }) => void) | null = null;
  onerror: ((event: Event & { error?: string }) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    h.instance = this;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  h.instance = null;
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: Recognition,
  });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
});

function results(...entries: Array<{ text: string; final: boolean }>) {
  return entries.map(({ text, final }) =>
    Object.assign([{ transcript: text }], { isFinal: final }),
  );
}

describe("live browser speech recognition", () => {
  it("streams replaceable interim and final text without uploading audio", () => {
    const onText = vi.fn();
    const onState = vi.fn();
    startMinkSpeechRecognition(new AbortController().signal, {
      onText,
      onState,
      onError: vi.fn(),
    });
    expect(h.instance).toMatchObject({
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
    });
    expect(h.instance?.start).toHaveBeenCalledOnce();
    h.instance?.onstart?.(new Event("start"));
    h.instance?.onresult?.(
      Object.assign(new Event("result"), {
        resultIndex: 0,
        results: results(
          { text: "check Delhi", final: true },
          { text: "stock", final: false },
        ),
      }),
    );
    expect(onText).toHaveBeenLastCalledWith("check Delhi stock");
    h.instance?.onresult?.(
      Object.assign(new Event("result"), {
        resultIndex: 1,
        results: results(
          { text: "check Delhi", final: true },
          { text: "stock today", final: false },
        ),
      }),
    );
    expect(onText).toHaveBeenLastCalledWith("check Delhi stock today");
    expect(onState).toHaveBeenCalledWith("listening");
  });

  it("stops after 60 seconds and cancels immediately on abort", async () => {
    const first = startMinkSpeechRecognition(new AbortController().signal, {
      onText: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.instance?.stop).toHaveBeenCalledOnce();
    first.cancel();

    const controller = new AbortController();
    startMinkSpeechRecognition(controller.signal, {
      onText: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
    });
    const second = h.instance;
    controller.abort();
    expect(second?.abort).toHaveBeenCalledOnce();
  });

  it("reports permission failures and fails clearly in unsupported browsers", () => {
    const onError = vi.fn();
    const onText = vi.fn();
    startMinkSpeechRecognition(new AbortController().signal, {
      onText,
      onState: vi.fn(),
      onError,
    });
    h.instance?.onerror?.(
      Object.assign(new Event("error"), { error: "not-allowed" }),
    );
    h.instance?.onend?.(new Event("end"));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("blocked"));
    expect(onText).not.toHaveBeenCalledWith("");

    delete window.SpeechRecognition;
    expect(() =>
      startMinkSpeechRecognition(new AbortController().signal, {
        onText: vi.fn(),
        onState: vi.fn(),
        onError: vi.fn(),
      }),
    ).toThrow(/not supported/i);
  });
});
