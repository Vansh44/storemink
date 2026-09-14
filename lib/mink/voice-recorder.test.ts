// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMinkRecording } from "./voice-recorder";
const h = {
  stop: vi.fn(),
  close: vi.fn(),
  mic: vi.fn(),
  addModule: vi.fn(),
  resume: vi.fn(),
  node: null as unknown as {
    port: {
      onmessage: ((event: unknown) => void) | null;
      close: ReturnType<typeof vi.fn>;
    };
    disconnect: ReturnType<typeof vi.fn>;
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: h.mic },
  });
  h.mic.mockResolvedValue({ getTracks: () => [{ stop: h.stop }] });
  h.addModule.mockResolvedValue(undefined);
  h.resume.mockResolvedValue(undefined);
  h.close.mockResolvedValue(undefined);
  const connect = () => ({ connect });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16000;
      state = "running";
      destination = {};
      audioWorklet = { addModule: h.addModule };
      close = h.close;
      resume = h.resume;
      createGain() {
        return { gain: { value: 1 }, connect };
      }
      createMediaStreamSource() {
        return { connect };
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null, close: vi.fn() };
      disconnect = vi.fn();
      constructor() {
        h.node = this;
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("microphone privacy lifecycle", () => {
  it("finishes cleanly when the browser delivers no audio samples", async () => {
    const done = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      vi.fn(),
    );
    stop();
    expect(done).toHaveBeenCalledWith(null);
    expect(h.stop).toHaveBeenCalled();
  });
  it("does not capture in insecure/unsupported contexts", async () => {
    vi.stubGlobal("isSecureContext", false);
    await expect(
      startMinkRecording(new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow();
    expect(h.mic).not.toHaveBeenCalled();
  });
  it("stops tracks and context on explicit stop and emits only canonical local WAV", async () => {
    const done = vi.fn();
    const progress = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      progress,
    );
    h.node.port.onmessage?.({ data: new Float32Array(16000) });
    stop();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "voice-note.wav",
        type: "audio/wav",
        size: 32044,
      }),
    );
    expect(progress).toHaveBeenCalledWith(1);
  });
  it("discards all samples on abort without a completion callback", async () => {
    const controller = new AbortController();
    const done = vi.fn();
    await startMinkRecording(controller.signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(128) });
    controller.abort();
    expect(h.stop).toHaveBeenCalled();
    expect(h.node.port.onmessage).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });
  it("cleans up when loading the worklet fails", async () => {
    h.addModule.mockRejectedValue(new Error("CSP blocked"));
    await expect(
      startMinkRecording(new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow();
    expect(h.stop).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });
  it("stops a late permission grant after the user cancelled", async () => {
    let grant!: (stream: unknown) => void;
    h.mic.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const controller = new AbortController();
    const done = vi.fn();
    const pending = startMinkRecording(controller.signal, done, vi.fn());
    controller.abort();
    grant({ getTracks: () => [{ stop: h.stop }] });
    await expect(pending).rejects.toThrow();
    expect(h.stop).toHaveBeenCalled();
    expect(h.addModule).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
  it("automatically stops by wall time even if audio delivery stalls", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(128) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.stop).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
