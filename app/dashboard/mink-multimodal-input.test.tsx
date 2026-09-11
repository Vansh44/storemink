import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { useState } from "react";
import { MinkMultimodalInput } from "./mink-multimodal-input";
const speech = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  callbacks: null as null | {
    onText: (text: string) => void;
    onState: (state: "starting" | "listening" | "stopped") => void;
    onError: (message: string) => void;
  },
}));
vi.mock("@/lib/mink/speech-recognition", () => ({
  startMinkSpeechRecognition: speech.start,
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  speech.start.mockReset();
  speech.stop.mockReset();
  speech.cancel.mockReset();
  speech.callbacks = null;
  speech.start.mockImplementation((_signal, callbacks) => {
    speech.callbacks = callbacks;
    callbacks.onState("starting");
    callbacks.onState("listening");
    return { stop: speech.stop, cancel: speech.cancel };
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ enabled: true, text: "Echos grocery banner" }),
  });
  URL.createObjectURL = vi.fn(() => "blob:local");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Add image or document" }),
  );
  expect(fetchMock).not.toHaveBeenCalled();
}
async function choose() {
  const file = new File(["source"], "echos.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("source").buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose image or document"), {
    target: { files: [file] },
  });
  await screen.findByText("Process for review");
}

function LiveComposer({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MinkMultimodalInput message={value} onAdd={setValue} disabled={false}>
      {({ attach, voice }) => (
        <div>
          {attach}
          <textarea
            aria-label="Message"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {voice}
          <button type="button" disabled={!value.trim()}>
            Send message
          </button>
        </div>
      )}
    </MinkMultimodalInput>
  );
}

describe("review-first multimodal input", () => {
  it("shows only accessible plus and mic controls at rest", () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Add image or document" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Dictate message" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("region", { name: "Review attachment" }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("starts immediately and streams speech into editable message text without Vertex or auto-send", async () => {
    render(<LiveComposer initial="Please" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    expect(speech.start).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/speech appears in the message box/i),
    ).toBeVisible();
    act(() => speech.callbacks?.onText("check Echos"));
    expect(screen.getByLabelText("Message")).toHaveValue("Please check Echos");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    act(() => speech.callbacks?.onText("check Echos inventory"));
    expect(screen.getByLabelText("Message")).toHaveValue(
      "Please check Echos inventory",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(speech.stop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message")).not.toHaveValue(
      expect.stringContaining("untrusted source text"),
    );
  });
  it("preserves words typed around a live interim phrase", () => {
    render(<LiveComposer initial="Please" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    act(() => speech.callbacks?.onText("check Shop stock"));
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Please check Shop stock today" },
    });
    act(() => speech.callbacks?.onText("check Shop stock now"));
    expect(screen.getByLabelText("Message")).toHaveValue(
      "Please check Shop stock now today",
    );
  });
  it("cancels live dictation and restores the text that existed before listening", () => {
    const add = vi.fn();
    render(
      <MinkMultimodalInput message="Existing" onAdd={add} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    act(() => speech.callbacks?.onText("temporary words"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(speech.cancel).toHaveBeenCalledOnce();
    expect(add).toHaveBeenLastCalledWith("Existing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("supports local text drops and a stable nested drag target without uploading", async () => {
    const add = vi.fn();
    render(
      <MinkMultimodalInput message="Read this" onAdd={add} disabled={false} />,
    );
    const zone = screen.getByLabelText("Mink AI composer");
    const file = new File(["Echos delivery notes"], "echos.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () =>
        new TextEncoder().encode("Echos delivery notes").buffer,
    });
    const dataTransfer = { types: ["Files"], files: [file] };
    fireEvent.dragEnter(zone, { dataTransfer });
    fireEvent.dragEnter(
      screen.getByRole("button", { name: "Add image or document" }),
      { dataTransfer },
    );
    fireEvent.dragLeave(zone, { dataTransfer });
    expect(
      screen.getByText("Drop one image or document here"),
    ).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer });
    expect(await screen.findByLabelText("Document text")).toHaveValue(
      "Echos delivery notes",
    );
    expect(screen.queryByText("Drop one image or document here")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Add reviewed reference to message"));
    expect(add).toHaveBeenCalledWith(
      expect.stringContaining("Echos delivery notes"),
    );
  });
  it("rejects multiple files, unsupported files and oversized local text", async () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    const zone = screen.getByLabelText("Mink AI composer");
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x"], "a.txt"), new File(["x"], "b.txt")],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("one file");
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x"], "attack.html")],
      },
    });
    // ★ IT MUST NOT OFFER WAV. `inputKind` is shared with the input API, which
    // still validates one, so its throw names a "mono 16 kHz PCM WAV" file —
    // and this control refuses every audio file. Surfacing that told a merchant
    // to attach something they would then be refused.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /PNG, JPEG, WebP or PDF/,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/WAV/i);
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x".repeat(8193)], "large.txt")],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("8 KiB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("★ sends an audio file to the microphone, never to the attachment path", async () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    fireEvent.drop(screen.getByLabelText("Mink AI composer"), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x"], "note.wav")],
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/microphone button/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prevents file navigation while disabled and ignores text/URL drags", () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled />);
    const zone = screen.getByLabelText("Mink AI composer");
    expect(
      fireEvent.drop(zone, {
        dataTransfer: { types: ["Files"], files: [new File(["x"], "a.png")] },
      }),
    ).toBe(false);
    expect(
      fireEvent.drop(zone, {
        dataTransfer: { types: ["text/uri-list"], files: [] },
      }),
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Review attachment" }),
    ).toBeNull();
  });
  it("discards a pending local read with Escape", async () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    let complete!: (value: ArrayBuffer) => void;
    const file = new File(["x"], "echos.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          complete = resolve;
        }),
    });
    fireEvent.drop(screen.getByLabelText("Mink AI composer"), {
      dataTransfer: { types: ["Files"], files: [file] },
    });
    fireEvent.keyDown(screen.getByLabelText("Mink AI composer"), {
      key: "Escape",
    });
    await act(async () =>
      complete(new TextEncoder().encode("Late text").buffer),
    );
    expect(screen.queryByLabelText("Document text")).toBeNull();
  });
  it("sends no file without consent and requires separate editable-result approval", async () => {
    const add = vi.fn();
    render(
      <MinkMultimodalInput
        message="Improve this"
        onAdd={add}
        disabled={false}
      />,
    );
    await open();
    await choose();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Process for review")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Process for review"));
    await screen.findByLabelText("Extracted reference");
    expect(add).not.toHaveBeenCalled();
    expect(
      screen.getByText("Add reviewed reference to message"),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Extracted reference"), {
      target: { value: "Corrected description" },
    });
    expect(
      screen.getByText("Add reviewed reference to message"),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Add reviewed reference to message"));
    expect(add).toHaveBeenCalledWith(
      expect.stringContaining("untrusted source text"),
    );
    expect(add).toHaveBeenCalledWith(
      expect.stringContaining("Corrected description"),
    );
  });
  it("discards locally and revokes the blob URL without uploading", async () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    await open();
    await choose();
    fireEvent.click(screen.getByText("Discard input"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
  });
  it("ignores a late response after close", async () => {
    const add = vi.fn();
    render(<MinkMultimodalInput message="" onAdd={add} disabled={false} />);
    await open();
    await choose();
    let complete!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Process for review"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Close input" }));
    await act(async () =>
      complete({
        ok: true,
        json: async () => ({ text: "Late private result" }),
      }),
    );
    expect(
      screen.queryByLabelText("Extracted reference"),
    ).not.toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
  });
  it("fails closed when availability is off", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false }),
    });
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    fireEvent.change(screen.getByLabelText("Choose image or document"), {
      target: { files: [new File(["x"], "echos.png")] },
    });
    await screen.findByRole("alert");
    expect(screen.queryByText("Process for review")).not.toBeInTheDocument();
  });
});
