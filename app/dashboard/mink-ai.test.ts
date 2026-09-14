// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeMinkSse, useMinkAi } from "./mink-ai";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consumeMinkSse", () => {
  it("parses events split across network chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: sta"));
        controller.enqueue(
          encoder.encode(
            'tus\ndata: {"conversationId":"conversation-1"}\n\nevent: message\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"text":"Ready"}\n\n'));
        controller.close();
      },
    });
    const onEvent = vi.fn();

    await consumeMinkSse(stream, onEvent);

    expect(onEvent).toHaveBeenNthCalledWith(1, "status", {
      conversationId: "conversation-1",
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, "message", { text: "Ready" });
  });

  it("rejects malformed JSON instead of displaying untrusted stream text", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode("event: message\ndata: not-json\n\n"),
        );
        controller.close();
      },
    });

    await expect(consumeMinkSse(stream, vi.fn())).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});

describe("useMinkAi history", () => {
  it("restores the newest retained conversation after refresh", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/conversations") {
        return Response.json({
          conversations: [
            {
              id,
              title: "Published products",
              lastMessageAt: "2026-08-29T10:00:00.000Z",
              createdAt: "2026-08-29T09:59:00.000Z",
            },
          ],
        });
      }
      return Response.json({
        conversation: {
          id,
          title: "Published products",
          messages: [
            { id: "message-1", role: "user", text: "How many?" },
            { id: "message-2", role: "assistant", text: "**14** products." },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() => {
      expect(result.current.activeConversationId).toBe(id);
    });
    expect(result.current.activeConversationTitle).toBe("Published products");
    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.messages).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith("/api/mink/conversations", {
      cache: "no-store",
    });
  });

  it("starts a blank thread without deleting the visible history sidebar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ conversations: [] })),
    );
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));

    act(() => result.current.reset());

    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversations).toEqual([]);
  });

  it("does not reopen history when New conversation wins an initial-load race", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let resolveHistory!: (response: Response) => void;
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations") return history;
      return Promise.resolve(
        Response.json({
          conversation: {
            id,
            title: "Old conversation",
            messages: [],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    act(() => result.current.reset());
    resolveHistory(
      Response.json({
        conversations: [
          {
            id,
            title: "Old conversation",
            lastMessageAt: "2026-08-29T10:00:00.000Z",
            createdAt: "2026-08-29T09:59:00.000Z",
          },
        ],
      }),
    );

    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deletes the active conversation and leaves a blank thread when none remain", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations") {
          return Response.json({
            conversations: [
              {
                id,
                title: "Delete me",
                lastMessageAt: "2026-08-29T10:00:00.000Z",
                createdAt: "2026-08-29T09:59:00.000Z",
              },
            ],
          });
        }
        if (init?.method === "DELETE") {
          return Response.json({ conversations: [] });
        }
        return Response.json({
          conversation: {
            id,
            title: "Delete me",
            messages: [{ id: "message-1", role: "user", text: "Delete this" }],
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.activeConversationId).toBe(id));

    let deleteError: { code: string; message: string } | null = null;
    await act(async () => {
      deleteError = await result.current.deleteConversation(id);
    });

    expect(deleteError).toBeNull();
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.conversations).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(`/api/mink/conversations/${id}`, {
      method: "DELETE",
    });
  });
});
