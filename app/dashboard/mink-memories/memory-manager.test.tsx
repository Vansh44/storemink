// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MinkMemoryManager } from "./memory-manager";
const fetcher = vi.fn();
beforeEach(() => {
  fetcher
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify({ memories: [] })),
    );
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("approved memory controls", () => {
  it("requires review and resets consent when exact text changes", async () => {
    render(<MinkMemoryManager />);
    await screen.findByText("No active memories saved.");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Echos language" },
    });
    fireEvent.change(screen.getByLabelText("Memory"), {
      target: { value: "Use simple Hindi" },
    });
    const save = screen.getByRole("button", {
      name: "Approve and save memory",
    });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Memory"), {
      target: { value: "Use simple English" },
    });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await screen.findByText("Memory approved for future chat turns.");
    const post = fetcher.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(post![1].body)).toMatchObject({
      action: "save",
      confirmed: true,
      content: "Use simple English",
      version: 0,
      days: 90,
    });
  });
  it("keeps failed saves retryable with the same request key", async () => {
    render(<MinkMemoryManager />);
    await screen.findByText("No active memories saved.");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Style" },
    });
    fireEvent.change(screen.getByLabelText("Memory"), {
      target: { value: "Short answers" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fetcher.mockRejectedValueOnce(new Error("Lost connection"));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and save memory" }),
    );
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and save memory" }),
    );
    await screen.findByText("Memory approved for future chat turns.");
    const calls = fetcher.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(calls[0][1].body).toBe(calls[1][1].body);
  });
  it("clears stored content when a refresh denies access", async () => {
    fetcher.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            memories: [
              {
                id: "id",
                title: "Private",
                content: "Private notes",
                kind: "preference",
                version: 1,
                expiresAt: "2099-01-01",
                usable: true,
              },
            ],
          }),
        ),
    );
    render(<MinkMemoryManager />);
    await screen.findByText("Private notes");
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Access denied" }), { status: 403 }),
    );
    fireEvent.click(screen.getByText("Refresh memories"));
    await waitFor(() =>
      expect(screen.queryByText("Private notes")).not.toBeInTheDocument(),
    );
  });
});
