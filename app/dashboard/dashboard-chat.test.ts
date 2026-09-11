import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampMinkPanelWidth,
  DashboardChat,
  isMinkScrollNearBottom,
  latestMinkUserMessageId,
  minkComposerHeight,
  minkHistoryStartsOpen,
  minkTurnAnchorSpace,
  shouldSubmitMinkComposer,
} from "./dashboard-chat";
import { useChat } from "./chat-context";

vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
}));

const baseChatState = {
  isChatOpen: true,
  isExpanded: true,
  closeChat: vi.fn(),
  toggleExpand: vi.fn(),
  messages: [],
  conversations: [],
  activeConversationId: null,
  activeConversationTitle: null,
  input: "",
  setInput: vi.fn(),
  isReplying: false,
  isHistoryLoading: false,
  deletingConversationId: null,
  statusText: null,
  error: null,
  feedbackSubmittingRunId: null,
  send: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  loadConversation: vi.fn(),
  deleteConversation: vi.fn(),
  submitFeedback: vi.fn(),
};

const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  // ⚠ jsdom reports 0 for every clientHeight, and the tail room is now measured
  // from the scroller rather than expressed as a percentage — so without this
  // the reservation is a truthful "0px" and the assertion below proves nothing.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 600,
  });
  vi.mocked(useChat).mockReturnValue(
    baseChatState as unknown as ReturnType<typeof useChat>,
  );
});

describe("Mink full view", () => {
  it("keeps the Builder panel above the fixed canvas without changing ordinary dashboard layout", () => {
    const css = readFileSync(
      join(process.cwd(), "app/dashboard/dashboard.css"),
      "utf8",
    );
    const rule = css.match(
      /\.dashboard-shell:has\(\.sm-builder\) \.dash-chat\s*\{([^}]+)\}/,
    )?.[1];
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("top: 56px");
    expect(rule).toContain("right: 0");
    expect(rule).toContain("bottom: 0");
    expect(rule).toContain("z-index: 45");
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      isExpanded: false,
      input: "Make this look better on mobile",
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "panel" }));
    expect(screen.getByTestId("mink-chat-surface")).toHaveClass("dash-chat");
    expect(screen.getByLabelText("Message Mink AI")).toHaveValue(
      "Make this look better on mobile",
    );
    expect(
      screen.getByRole("separator", { name: "Resize Mink AI panel" }),
    ).toBeInTheDocument();
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      isChatOpen: false,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "panel" }));
    expect(screen.queryByTestId("mink-chat-surface")).not.toBeInTheDocument();
  });

  it("covers the entire viewport above the dashboard chrome", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByTestId("mink-chat-surface")).toHaveClass(
      "fixed",
      "inset-0",
      "z-[90]",
      "h-[100dvh]",
      "max-w-full",
    );
  });

  it("starts without the in-flow history column on a phone", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    render(createElement(DashboardChat, { variant: "overlay" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show conversation sidebar" }),
      ).toHaveAttribute("aria-expanded", "false"),
    );
    expect(
      screen.queryByRole("complementary", {
        name: "Mink AI conversations",
      }),
    ).not.toBeInTheDocument();
  });

  it("uses a contained message scroller and a no-zoom mobile composer", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [{ id: "user-1", role: "user", text: "Hi" }],
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByTestId("mink-message-scroller")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByLabelText("Message Mink AI")).toHaveClass(
      "min-w-0",
      "text-base",
      "sm:text-sm",
    );
  });

  it("keeps a submitted question at the top while a long answer grows below it", async () => {
    const send = vi.fn();
    const previousMessages = [
      { id: "user-1", role: "user" as const, text: "Hi" },
      {
        id: "assistant-1",
        role: "assistant" as const,
        text: "How can I help?",
      },
    ];
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: previousMessages,
      input: "How can I add my own domain?",
      send,
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "overlay" }));

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).toHaveBeenCalledTimes(1);

    const submittedMessages = [
      ...previousMessages,
      {
        id: "user-2",
        role: "user" as const,
        text: "How can I add my own domain?",
      },
    ];
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: submittedMessages,
      input: "",
      isReplying: true,
      statusText: "Thinking…",
      send,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));

    const submittedRow = screen
      .getByText("How can I add my own domain?")
      .closest<HTMLElement>('[data-mink-message-role="user"]');
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "smooth",
      }),
    );
    expect(scrollIntoView.mock.instances.at(-1)).toBe(submittedRow);
    // ★★ A REAL PIXEL RESERVATION, not `calc(100% - 5rem)`. That percentage
    // resolved against the message column, whose height is its own content, so
    // it behaved as `auto` — 0 — and the tail room the anchor depends on never
    // existed. This assertion used to pin that broken string, proving only that
    // a string had been written. 600px scroller − 5rem (80px) = 520px.
    expect(screen.getByTestId("mink-turn-anchor-space")).toHaveStyle({
      minHeight: "520px",
    });

    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        ...submittedMessages,
        {
          id: "assistant-2",
          role: "assistant" as const,
          text: "Start in Settings, then open Domain.",
        },
      ],
      input: "",
      isReplying: false,
      send,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));

    await waitFor(() =>
      expect(screen.getByTestId("mink-turn-anchor-space")).toHaveStyle({
        minHeight: "0px",
      }),
    );
    expect(scrollIntoView.mock.instances).toContain(submittedRow);
  });
});

describe("★★ minkTurnAnchorSpace", () => {
  it("reserves the scroller's height less the kept strip", () => {
    expect(minkTurnAnchorSpace({ viewportHeight: 600, reservePx: 80 })).toBe(
      "520px",
    );
    // A larger root font keeps proportionally more of the question in view.
    expect(minkTurnAnchorSpace({ viewportHeight: 600, reservePx: 100 })).toBe(
      "500px",
    );
  });

  it("★ never returns a negative reservation", () => {
    // A panel shorter than the kept strip, or one measured while hidden, must
    // reserve nothing rather than emit an invalid negative min-height.
    expect(minkTurnAnchorSpace({ viewportHeight: 40, reservePx: 80 })).toBe(
      "0px",
    );
    expect(minkTurnAnchorSpace({ viewportHeight: 0, reservePx: 80 })).toBe(
      "0px",
    );
  });

  it("★ emits whole pixels, so a fractional font size cannot produce junk", () => {
    expect(
      minkTurnAnchorSpace({ viewportHeight: 611.5, reservePx: 82.5 }),
    ).toBe("529px");
  });
});

describe("minkHistoryStartsOpen", () => {
  it("keeps history closed on compact screens and open beside desktop chat", () => {
    expect(minkHistoryStartsOpen(390)).toBe(false);
    expect(minkHistoryStartsOpen(767)).toBe(false);
    expect(minkHistoryStartsOpen(768)).toBe(true);
    expect(minkHistoryStartsOpen(1440)).toBe(true);
  });
});

describe("isMinkScrollNearBottom", () => {
  it("follows streaming output only while the reader remains near the end", () => {
    expect(
      isMinkScrollNearBottom({
        scrollHeight: 1200,
        scrollTop: 744,
        clientHeight: 400,
      }),
    ).toBe(true);
    expect(
      isMinkScrollNearBottom({
        scrollHeight: 1200,
        scrollTop: 500,
        clientHeight: 400,
      }),
    ).toBe(false);
  });
});

describe("latestMinkUserMessageId", () => {
  it("selects the question that owns the newest answer", () => {
    expect(
      latestMinkUserMessageId([
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        { id: "a2", role: "assistant" },
      ]),
    ).toBe("u2");
    expect(latestMinkUserMessageId([])).toBeNull();
  });
});

describe("Mink compact scroll ownership", () => {
  it("pins the phone drawer to the viewport and locks the dashboard behind it", () => {
    const css = readFileSync(
      join(process.cwd(), "app/dashboard/dashboard.css"),
      "utf8",
    );

    expect(css).toContain("@media (max-width: 639px)");
    expect(css).toContain("width: 100vw;");
    expect(css).toContain("height: 100dvh;");
    expect(css).toContain(
      ".dashboard-frame:has(.mink-chat-surface) .dash-content",
    );
    expect(css).toContain(".dashboard-shell .mink-message-scroll");
    expect(css).toContain("overscroll-behavior-y: contain;");
  });
});

describe("clampMinkPanelWidth", () => {
  it("keeps desktop resizing within the usable dashboard range", () => {
    expect(clampMinkPanelWidth(100, 1920)).toBe(320);
    expect(clampMinkPanelWidth(900, 1920)).toBe(720);
    expect(clampMinkPanelWidth(512, 1920)).toBe(512);
  });

  it("keeps the overlay inside a small viewport", () => {
    expect(clampMinkPanelWidth(720, 390)).toBe(358);
    expect(clampMinkPanelWidth(100, 300)).toBe(276);
  });
});

describe("Mink composer", () => {
  it("grows with wrapped content and caps before becoming scrollable", () => {
    expect(minkComposerHeight(8)).toBe(24);
    expect(minkComposerHeight(96.2)).toBe(97);
    expect(minkComposerHeight(400)).toBe(160);
  });

  it("submits on Enter while preserving Shift+Enter and IME composition", () => {
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});
