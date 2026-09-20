"use client";
import Link from "next/link";

import {
  ArrowDown,
  ArrowUp,
  FileText,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useChat } from "./chat-context";
import { MinkAnswer } from "./mink-answer";
import { ASSISTANT_NAME, type MinkConversationSummary } from "./mink-ai";
import { MinkMark } from "./mink-mark";
import { MinkMultimodalInput } from "./mink-multimodal-input";
import { MinkArtifacts } from "./mink-artifacts";
import { MinkFeedbackControls } from "./mink-feedback";
import { estimateMinkDraftIntent } from "@/lib/mink/draft-types";
import { readReviewedMinkDocument } from "@/lib/mink/document-input";
import { readSavedMinkMediaReference } from "@/lib/mink/media-attachment";
import { BrandMark } from "@/app/platform/brand-mark";
import type { MinkCreditSummary } from "./chat-context";

const PANEL_WIDTH_KEY = "storemink:mink-panel-width";
const DEFAULT_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 720;
const MAX_COMPOSER_HEIGHT = 160;
const HISTORY_SIDEBAR_BREAKPOINT = 768;

export function clampMinkPanelWidth(width: number, viewportWidth: number) {
  const safeViewport = Math.max(280, viewportWidth);
  const min = Math.min(320, Math.floor(safeViewport * 0.92));
  const max =
    safeViewport < 1200
      ? Math.floor(safeViewport * 0.92)
      : Math.min(MAX_PANEL_WIDTH, Math.floor(safeViewport * 0.62));
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

export function minkComposerHeight(scrollHeight: number) {
  return Math.min(Math.max(Math.ceil(scrollHeight), 24), MAX_COMPOSER_HEIGHT);
}

export function minkHistoryStartsOpen(viewportWidth: number) {
  return viewportWidth >= HISTORY_SIDEBAR_BREAKPOINT;
}

export function isMinkScrollNearBottom(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  threshold?: number;
}) {
  const distance = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distance <= (input.threshold ?? 56);
}

export function latestMinkUserMessageId(
  messages: Array<{ id: number | string; role: "user" | "assistant" }>,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
  return null;
}

/** How much of the viewport the anchored question is allowed to keep. */
export const MINK_TURN_ANCHOR_RESERVE_REM = 5;

/**
 * The temporary tail room under a newly submitted question, IN PIXELS.
 *
 * ★★ PIXELS, BECAUSE THE PERCENTAGE RESOLVED TO NOTHING. This was written as
 * `min-height: calc(100% - 5rem)`, and the spacer's containing block is the
 * message column — a plain block whose height is its own content. A percentage
 * min-height against an indefinite containing-block height behaves as `auto`,
 * which is 0 for a block box (CSS Sizing 3; CSS 2.1 §10.7). So the reserved
 * space the anchor depends on never existed: `scrollIntoView({block:"start"})`
 * just clamped at the end of the content, and a question submitted into a short
 * conversation stayed wherever it was — the exact case the reservation is for
 * ("the browser cannot place a newly submitted question at the top while only
 * the Thinking row exists"). The SCROLLER has a definite height, because it is
 * a flex child with `min-h-0 flex-1`, so measuring that is what makes the
 * reservation real.
 *
 * ⚠ A TEST MUST STUB `clientHeight`: jsdom reports 0 for every element, so it
 * yields "0px" there. Asserting the old `calc()` string proved only that a
 * string had been written to the attribute, never that any space resulted.
 */
export function minkTurnAnchorSpace(input: {
  viewportHeight: number;
  reservePx: number;
}) {
  const space = Math.round(input.viewportHeight - input.reservePx);
  return `${Math.max(0, space)}px`;
}

/** `rem` is only meaningful against the root font size, so read it. */
function rootFontSizePx() {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(size) && size > 0 ? size : 16;
}

export function shouldSubmitMinkComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}) {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

// Two surfaces, one conversation (state lives in ChatProvider):
//  - "panel"   → the resizable right sheet opened from the topbar
//  - "overlay" → the full-view takeover opened from Home/maximize
export function DashboardChat({
  variant = "panel",
}: {
  variant?: "panel" | "overlay";
}) {
  const {
    isChatOpen,
    isExpanded,
    canSaveMedia,
    closeChat,
    toggleExpand,
    messages,
    conversations,
    activeConversationId,
    activeConversationTitle,
    input,
    setInput,
    isReplying,
    isHistoryLoading,
    deletingConversationId,
    statusText,
    error,
    feedbackSubmittingRunId,
    minkCredits,
    send,
    cancel,
    retry,
    reset,
    loadConversation,
    deleteConversation,
    submitFeedback,
  } = useChat();
  const isOverlay = variant === "overlay";
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const latestUserMessageIdRef = useRef<number | string | null>(null);
  const anchoredUserMessageIdRef = useRef<number | string | null>(null);
  const autoAnchorSubmissionRef = useRef(true);
  const turnAnchorSpaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<MinkConversationSummary | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => {
    if (!isOverlay || !isChatOpen || !isExpanded) return;
    // The desktop takeover benefits from persistent history beside the thread.
    // On a phone that same 288px column left the conversation a ~100px sliver,
    // so compact takeovers start with history closed and expose it on demand.
    const frame = window.requestAnimationFrame(() => {
      const shouldOpen = minkHistoryStartsOpen(window.innerWidth);
      setHistoryOpen((open) => (open === shouldOpen ? open : shouldOpen));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isChatOpen, isExpanded, isOverlay]);

  useEffect(() => {
    if (isOverlay) return;
    const resize = () =>
      setPanelWidth((width) => clampMinkPanelWidth(width, window.innerWidth));
    const restoreFrame = window.requestAnimationFrame(() => {
      try {
        const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(stored) && stored > 0) {
          setPanelWidth(clampMinkPanelWidth(stored, window.innerWidth));
        } else {
          resize();
        }
      } catch {
        resize();
      }
    });
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener("resize", resize);
    };
  }, [isOverlay]);

  useEffect(() => {
    if (isOverlay) return;
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // A private browser may disable storage; resizing still works in-session.
    }
  }, [isOverlay, panelWidth]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const latestUserId = latestMinkUserMessageId(messages);
    const receivedNewUserMessage =
      latestUserId !== null && latestUserId !== latestUserMessageIdRef.current;
    latestUserMessageIdRef.current = latestUserId;

    if (isReplying && receivedNewUserMessage) {
      followLatestRef.current = false;
      autoAnchorSubmissionRef.current = true;
      anchoredUserMessageIdRef.current = latestUserId;
      if (turnAnchorSpaceRef.current) {
        turnAnchorSpaceRef.current.style.minHeight = minkTurnAnchorSpace({
          viewportHeight: scroller.clientHeight,
          reservePx: MINK_TURN_ANCHOR_RESERVE_REM * rootFontSizePx(),
        });
      }
    }

    const frame = window.requestAnimationFrame(() => {
      const anchoredUserMessageId = anchoredUserMessageIdRef.current;
      if (anchoredUserMessageId !== null) {
        if (autoAnchorSubmissionRef.current) {
          const userRows = scroller.querySelectorAll<HTMLElement>(
            '[data-mink-message-role="user"]',
          );
          const latestUserRow = userRows.item(userRows.length - 1);
          if (
            latestUserRow?.dataset.minkMessageId ===
            String(anchoredUserMessageId)
          ) {
            latestUserRow.scrollIntoView?.({
              block: "start",
              behavior: "smooth",
            });
          }
        }
        // Keep one viewport of temporary tail room until the completed answer
        // has been positioned. Without it the browser cannot place a newly
        // submitted question at the top while only the Thinking row exists.
        if (!isReplying) {
          anchoredUserMessageIdRef.current = null;
          if (turnAnchorSpaceRef.current) {
            turnAnchorSpaceRef.current.style.minHeight = "0px";
          }
        }
        setShowJumpToLatest(!isMinkScrollNearBottom(scroller));
        return;
      }
      if (followLatestRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setShowJumpToLatest(false);
      } else {
        setShowJumpToLatest(!isMinkScrollNearBottom(scroller));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, isReplying, error, statusText]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = minkComposerHeight(composer.scrollHeight);
    composer.style.height = `${height}px`;
    composer.style.overflowY =
      composer.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [historyOpen, input, isOverlay, panelWidth]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !deletingConversationId) {
        setDeleteTarget(null);
        setDeleteFailure(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, deletingConversationId]);

  const updateWidth = useCallback((width: number) => {
    setPanelWidth(clampMinkPanelWidth(width, window.innerWidth));
  }, []);

  const sendFromChat = useCallback(
    (raw?: string) => {
      // A new turn belongs at the top of the reading viewport. The completed
      // answer may be much taller than the panel, so chasing its bottom would
      // make the reader lose the question and the beginning of Mink's answer.
      followLatestRef.current = false;
      autoAnchorSubmissionRef.current = true;
      send(raw);
    },
    [send],
  );

  const jumpToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followLatestRef.current = true;
    autoAnchorSubmissionRef.current = false;
    anchoredUserMessageIdRef.current = null;
    if (turnAnchorSpaceRef.current) {
      turnAnchorSpaceRef.current.style.minHeight = "0px";
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    setShowJumpToLatest(false);
  }, []);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateWidth(resize.startWidth + resize.startX - event.clientX);
  };

  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updateWidth(panelWidth - step);
    }
  };

  if (!isChatOpen) return null;
  if (isOverlay !== isExpanded) return null;

  const hasThread = messages.length > 0 || isReplying || Boolean(error);
  const draftEstimate = estimateMinkDraftIntent(input);
  const wrapperClass = isOverlay
    ? "mink-chat-surface fixed inset-0 z-[90] flex h-[100dvh] w-screen max-w-full min-h-0 flex-col overflow-hidden overscroll-none bg-white"
    : "mink-chat-surface dash-chat relative flex h-full flex-shrink-0 flex-col overflow-hidden overscroll-none border-l border-t border-[#e5e5e5] bg-white shadow-sm";
  const columnClass = isOverlay ? "mx-auto w-full max-w-3xl" : "w-full";
  const panelStyle = isOverlay
    ? undefined
    : ({ "--mink-chat-width": `${panelWidth}px` } as CSSProperties);

  return (
    <div
      data-testid="mink-chat-surface"
      className={wrapperClass}
      style={panelStyle}
    >
      {!isOverlay && (
        <div
          role="separator"
          aria-label="Resize Mink AI panel"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={resizeWithKeyboard}
          className="mink-chat-resizer group absolute inset-y-0 left-0 z-30 hidden w-2 -translate-x-1/2 touch-none cursor-col-resize outline-none sm:block"
        >
          <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-[#7f4afa]" />
        </div>
      )}

      <header className="flex min-h-[64px] w-full max-w-full shrink-0 items-center justify-between gap-3 border-b border-[#ededed] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-label={
              historyOpen
                ? "Hide conversation sidebar"
                : "Show conversation sidebar"
            }
            aria-expanded={historyOpen}
            className="rounded-lg p-2 text-[#5c5f62] transition-colors hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
          >
            {historyOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </button>
          <MinkMark />
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d4dff]">
              {ASSISTANT_NAME}
            </span>
            <span className="block truncate text-sm font-semibold text-[#1a1a1a]">
              {activeConversationTitle ?? "New conversation"}
            </span>
          </span>
          {isHistoryLoading && (
            <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8c9196]" />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 text-[#5c5f62]">
          <Link
            href="/dashboard/mink-memories"
            onNavigate={closeChat}
            className="rounded-md px-2 py-1 text-xs hover:bg-[#f1f1f1]"
            title="Review your private approved memories"
          >
            Memories
          </Link>
          <Link
            href="/dashboard/mink-watches"
            onNavigate={closeChat}
            className="rounded-md px-2 py-1 text-xs hover:bg-[#f1f1f1]"
            title="Manage your recurring Mink watches"
          >
            Watches
          </Link>
          <button
            type="button"
            onClick={toggleExpand}
            className="hidden rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1] sm:inline-flex"
            aria-label={
              isOverlay ? "Collapse to side panel" : "Expand to full view"
            }
          >
            {isOverlay ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={closeChat}
            className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1]"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {historyOpen && (
          <ConversationSidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            isOverlay={isOverlay}
            isReplying={isReplying}
            isHistoryLoading={isHistoryLoading}
            deletingConversationId={deletingConversationId}
            onNewConversation={() => {
              followLatestRef.current = true;
              setShowJumpToLatest(false);
              latestUserMessageIdRef.current = null;
              anchoredUserMessageIdRef.current = null;
              if (turnAnchorSpaceRef.current) {
                turnAnchorSpaceRef.current.style.minHeight = "0px";
              }
              reset();
              if (!isOverlay) setHistoryOpen(false);
            }}
            onSelect={(conversation) => {
              followLatestRef.current = true;
              setShowJumpToLatest(false);
              latestUserMessageIdRef.current = null;
              anchoredUserMessageIdRef.current = null;
              if (turnAnchorSpaceRef.current) {
                turnAnchorSpaceRef.current.style.minHeight = "0px";
              }
              void loadConversation(conversation.id);
              if (!isOverlay) setHistoryOpen(false);
            }}
            onDelete={(conversation) => {
              setDeleteFailure(null);
              setDeleteTarget(conversation);
            }}
          />
        )}

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          {!hasThread ? (
            <div className="flex min-h-0 flex-1 touch-pan-y flex-col items-center justify-center overflow-y-auto overscroll-contain p-6 text-center">
              <div className="mb-4">
                <MinkMark size="lg" />
              </div>
              <h2 className="mb-1 text-lg font-semibold text-[#1a1a1a]">
                Hey there
              </h2>
              <h3 className="mb-6 text-xl font-bold text-[#1a1a1a]">
                I&apos;m {ASSISTANT_NAME}. How can I help?
              </h3>
              <button
                type="button"
                onClick={() => sendFromChat("What's new?")}
                className="flex items-center gap-2 rounded-full border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#1a1a1a] shadow-sm transition-colors hover:bg-[#f9f9f9]"
              >
                <div className="h-2 w-2 rounded-full bg-[#6d4dff]" />
                What&apos;s new?
              </button>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                data-testid="mink-message-scroller"
                onScroll={() => {
                  const scroller = scrollRef.current;
                  if (!scroller) return;
                  const nearBottom = isMinkScrollNearBottom(scroller);
                  followLatestRef.current = nearBottom;
                  setShowJumpToLatest(!nearBottom);
                }}
                onPointerDown={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                onTouchStart={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                onWheel={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                className="mink-message-scroll h-full min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-4 py-4"
              >
                <div className={`${columnClass} space-y-4`}>
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <div
                        key={message.id}
                        data-mink-message-id={String(message.id)}
                        data-mink-message-role="user"
                        className="flex scroll-mt-4 justify-end"
                      >
                        <MinkUserMessage text={message.text} />
                      </div>
                    ) : (
                      <div
                        key={message.id}
                        className="flex min-w-0 gap-2.5 py-1"
                      >
                        <MinkMark size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 text-[11px] font-semibold text-[#5c5f62]">
                            {ASSISTANT_NAME}
                          </div>
                          <div className="pr-1">
                            <MinkAnswer text={message.text} />
                          </div>
                          <MinkArtifacts
                            artifacts={message.artifacts ?? []}
                            onPrompt={sendFromChat}
                            promptDisabled={isReplying || isHistoryLoading}
                          />
                          <MinkFeedbackControls
                            message={message}
                            submitting={
                              feedbackSubmittingRunId === message.runId
                            }
                            submit={submitFeedback}
                          />
                        </div>
                      </div>
                    ),
                  )}

                  {isReplying && (
                    <div className="flex gap-2.5" aria-live="polite">
                      <MinkMark size="sm" />
                      <div className="flex items-center gap-2 py-2 text-xs text-[#5c5f62]">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6d4dff]" />
                        {statusText ?? "Thinking…"}
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="flex gap-2.5" role="alert">
                      <MinkMark size="sm" />
                      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[#fff4f4] px-3.5 py-2.5 text-sm text-[#5c1b14]">
                        <div>{error.message}</div>
                        <button
                          type="button"
                          onClick={() => {
                            followLatestRef.current = true;
                            retry();
                          }}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#6d4dff] hover:underline"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Retry
                        </button>
                      </div>
                    </div>
                  )}

                  <div
                    ref={turnAnchorSpaceRef}
                    aria-hidden="true"
                    data-testid="mink-turn-anchor-space"
                    className="shrink-0"
                    style={{ minHeight: 0 }}
                  />
                </div>
              </div>
              {showJumpToLatest && (
                <button
                  type="button"
                  aria-label="Jump to latest message"
                  title="Jump to latest"
                  onClick={jumpToLatest}
                  className="absolute bottom-4 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-[#d9d9d9] bg-white text-[#303030] shadow-md transition hover:bg-[#f7f7f7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
                >
                  <ArrowDown className="h-5 w-5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <div className="shrink-0 border-t border-[#f1f1f1] p-3 sm:p-4">
            <div className={columnClass}>
              {draftEstimate ? (
                <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[10px] text-[#6c6573]">
                  <span>{draftEstimate.label} proposal</span>
                  <span className="font-semibold text-[#5b3fd0]">
                    Expected cost: {draftEstimate.expectedCredits} Mink credit
                    {draftEstimate.expectedCredits === 1 ? "" : "s"}
                  </span>
                </div>
              ) : null}
              <MinkMultimodalInput
                key={`multimodal:${activeConversationId ?? "new"}`}
                message={input}
                onAdd={(value) => {
                  setInput(value);
                  composerRef.current?.focus();
                }}
                disabled={isReplying || isHistoryLoading}
                canSaveMedia={canSaveMedia}
                onSubmit={sendFromChat}
              >
                {({ attach, attachment, voice, submit }) => (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submit();
                    }}
                    className="flex w-full min-w-0 max-w-full flex-col gap-2 rounded-3xl border border-[#e5e5e5] bg-white px-3 py-3 shadow-sm transition-all focus-within:border-[#6d4dff] focus-within:ring-1 focus-within:ring-[#6d4dff]"
                  >
                    {attachment}
                    <textarea
                      ref={composerRef}
                      rows={1}
                      maxLength={4000}
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          !shouldSubmitMinkComposer({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                          })
                        ) {
                          return;
                        }
                        event.preventDefault();
                        if (input.trim() && !isHistoryLoading && !isReplying) {
                          void submit();
                        }
                      }}
                      placeholder="Ask anything..."
                      aria-label={`Message ${ASSISTANT_NAME}`}
                      // ★ THESE FOUR SHAPE THE PHONE KEYBOARD, and without them iOS
                      // guesses. A field inside a <form> with no autocomplete hint
                      // gets the AUTOFILL accessory bar — passwords, cards,
                      // addresses — above the keys instead of QuickType word
                      // suggestions: useless for a chat, and the reason the composer
                      // reads as unfinished next to a native messaging app.
                      //
                      // `enterKeyHint` is honest rather than decorative. A phone has
                      // no Shift, so shouldSubmitMinkComposer means Return ALWAYS
                      // sends here, and the key should say so instead of showing a
                      // generic newline arrow.
                      enterKeyHint="send"
                      autoComplete="off"
                      autoCapitalize="sentences"
                      autoCorrect="on"
                      className="min-h-6 max-h-40 w-full min-w-0 resize-none border-none bg-transparent px-2 py-0.5 text-base leading-6 text-[#1a1a1a] outline-none placeholder:text-[#8c9196] sm:text-sm sm:leading-5"
                    />
                    <div className="flex w-full items-center justify-between">
                      {attach}
                      <div className="flex items-center gap-2">
                        {voice}
                        {isReplying ? (
                          <button
                            type="button"
                            onClick={cancel}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1a1a1a] text-white"
                            aria-label="Stop Mink AI"
                          >
                            <Square className="h-4 w-4 fill-current" />
                          </button>
                        ) : (
                          <button
                            type="submit"
                            disabled={!input.trim() || isHistoryLoading}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#6d4dff] text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
                            aria-label="Send message"
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                )}
              </MinkMultimodalInput>
              <div className="relative mt-2 flex min-h-6 items-center justify-center px-1">
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#8c9196]">
                  Powered by <BrandMark size={13} /> StoreMink
                </span>
                <div className="absolute right-1 top-0">
                  <MinkCreditIndicator summary={minkCredits} />
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {deleteTarget && (
        <div
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="mink-delete-title"
          aria-describedby="mink-delete-description"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[#dedede] bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff1f0] text-[#b42318]">
                <Trash2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2
                  id="mink-delete-title"
                  className="text-base font-semibold text-[#1a1a1a]"
                >
                  Delete conversation?
                </h2>
                <p
                  id="mink-delete-description"
                  className="mt-1 text-sm leading-5 text-[#5c5f62]"
                >
                  “{deleteTarget.title}” and its messages will be permanently
                  deleted.
                </p>
                {deleteFailure && (
                  <p
                    role="alert"
                    className="mt-2 rounded-lg bg-[#fff4f4] px-2.5 py-2 text-xs leading-5 text-[#8a1c13]"
                  >
                    {deleteFailure}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteFailure(null);
                }}
                disabled={Boolean(deletingConversationId)}
                className="rounded-lg border border-[#dedede] px-3 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f6f6f7] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                ref={deleteButtonRef}
                type="button"
                disabled={Boolean(deletingConversationId)}
                onClick={async () => {
                  setDeleteFailure(null);
                  const failure = await deleteConversation(deleteTarget.id);
                  if (!failure) {
                    setDeleteTarget(null);
                  } else {
                    setDeleteFailure(failure.message);
                  }
                }}
                className="inline-flex min-w-[76px] items-center justify-center gap-1.5 rounded-lg bg-[#b42318] px-3 py-2 text-sm font-semibold text-white hover:bg-[#912018] disabled:opacity-60"
              >
                {deletingConversationId === deleteTarget.id && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                )}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MinkCreditIndicator({
  summary,
}: {
  summary: MinkCreditSummary | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const state = summary ? minkCreditIndicatorState(summary) : null;
  const includedLeft = state?.includedLeft ?? null;
  const totalLeft = state?.totalLeft ?? null;
  const fraction = state?.fraction ?? 0;
  const color = state?.color ?? "#dc2626";
  const circumference = 2 * Math.PI * 8;

  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!summary) return null;
  const label =
    totalLeft === null
      ? "Unlimited Mink credits"
      : `${totalLeft} Mink credit${totalLeft === 1 ? "" : "s"} left`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
      >
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Mink credit balance"
          className="absolute bottom-8 right-0 z-50 w-64 rounded-xl border border-[#dedede] bg-white p-3 text-left shadow-xl"
        >
          <p className="text-sm font-semibold text-[#1a1a1a]">Mink credits</p>
          <p className="mt-1 text-2xl font-bold text-[#1a1a1a]">
            {totalLeft === null ? "Unlimited" : totalLeft}
          </p>
          {totalLeft !== null && (
            <p className="text-xs text-[#6b7280]">
              {includedLeft} included + {summary.creditBalance} top-up remaining
            </p>
          )}
          <p className="mt-2 border-t border-[#ededed] pt-2 text-xs text-[#6b7280]">
            Included credits reset{" "}
            {new Date(summary.resetsAt).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            .
          </p>
          <Link
            href="/dashboard/plans"
            onNavigate={() => setOpen(false)}
            className="mt-2 inline-flex text-xs font-semibold text-[#6d4dff] hover:underline"
          >
            View credits and usage
          </Link>
        </div>
      )}
    </div>
  );
}

export function minkCreditIndicatorState(summary: MinkCreditSummary) {
  const includedLeft =
    summary.cap === null ? null : Math.max(0, summary.cap - summary.used);
  const totalLeft =
    includedLeft === null ? null : includedLeft + summary.creditBalance;
  const fraction =
    summary.cap === null
      ? 1
      : Math.min(1, (totalLeft ?? 0) / Math.max(summary.cap, 1));
  return {
    includedLeft,
    totalLeft,
    fraction,
    color: fraction > 0.5 ? "#16a34a" : fraction > 0.2 ? "#f59e0b" : "#dc2626",
  };
}

function MinkUserMessage({ text }: { text: string }) {
  const [viewingImage, setViewingImage] = useState<{
    filename: string;
    url: string;
  } | null>(null);
  let visibleText = text;
  const attachments: Array<
    | { kind: "media"; filename: string; url: string }
    | { kind: "reference"; filename: string; sourceKind: string }
  > = [];

  const document = readReviewedMinkDocument(visibleText);
  if (document) {
    visibleText = document.message;
    attachments.unshift({
      kind: "reference",
      filename: document.attachment.filename || "Reviewed reference",
      sourceKind: document.attachment.kind === "image" ? "Image" : "Document",
    });
  }
  const media = readSavedMinkMediaReference(visibleText);
  if (media) {
    visibleText = media.message;
    attachments.unshift({ kind: "media", ...media.asset });
  }

  return (
    <>
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-sm bg-[#f4f0ff] px-3.5 py-2.5 text-sm text-[#1a1a1a]">
        {attachments.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            aria-label="Message attachments"
          >
            {attachments.map((attachment, index) =>
              attachment.kind === "media" ? (
                <div
                  key={`${attachment.url}:${index}`}
                  className="min-w-0 overflow-hidden rounded-xl border border-black/10 bg-white/80"
                >
                  {isRenderableMinkMediaUrl(attachment.url) && (
                    <button
                      type="button"
                      aria-label={`View ${attachment.filename || "attached image"}`}
                      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6d4dff]"
                      onClick={() => setViewingImage(attachment)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/og-image?url=${encodeURIComponent(attachment.url)}`}
                        alt={attachment.filename || "Attached storefront image"}
                        className="h-28 w-44 max-w-full object-cover"
                      />
                    </button>
                  )}
                  <div className="max-w-44 truncate px-2.5 py-2 text-xs font-medium">
                    {attachment.filename || "Storefront image"}
                  </div>
                </div>
              ) : (
                <div
                  key={`${attachment.filename}:${index}`}
                  className="flex max-w-full items-center gap-2 rounded-xl border border-black/10 bg-white/80 px-3 py-2"
                >
                  <FileText
                    className="h-5 w-5 shrink-0 text-[#6d4dff]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {attachment.filename}
                    </span>
                    <span className="block text-[10px] text-[#777]">
                      {attachment.sourceKind}
                    </span>
                  </span>
                </div>
              ),
            )}
          </div>
        )}
        {visibleText && (
          <div className="whitespace-pre-wrap break-words">{visibleText}</div>
        )}
      </div>
      {viewingImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Attachment preview: ${viewingImage.filename}`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setViewingImage(null)}
        >
          <div
            className="relative max-h-[90dvh] max-w-5xl overflow-auto rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close attachment preview"
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white"
              onClick={() => setViewingImage(null)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/og-image?url=${encodeURIComponent(viewingImage.url)}`}
              alt={viewingImage.filename || "Attached image"}
              className="max-h-[82dvh] max-w-full rounded-xl object-contain"
            />
          </div>
        </div>
      )}
    </>
  );
}

function isRenderableMinkMediaUrl(value: string) {
  // The browser fetches only our same-origin proxy. Its server-side bucket pin
  // rejects a hand-authored marker pointing at someone else's GCS object.
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "storage.googleapis.com" ||
        url.hostname.endsWith(".storage.googleapis.com"))
    );
  } catch {
    return false;
  }
}

function ConversationSidebar({
  conversations,
  activeConversationId,
  isOverlay,
  isReplying,
  isHistoryLoading,
  deletingConversationId,
  onNewConversation,
  onSelect,
  onDelete,
}: {
  conversations: MinkConversationSummary[];
  activeConversationId: string | null;
  isOverlay: boolean;
  isReplying: boolean;
  isHistoryLoading: boolean;
  deletingConversationId: string | null;
  onNewConversation: () => void;
  onSelect: (conversation: MinkConversationSummary) => void;
  onDelete: (conversation: MinkConversationSummary) => void;
}) {
  return (
    <aside
      aria-label="Mink AI conversations"
      className={
        isOverlay
          ? "absolute inset-y-0 left-0 z-40 flex w-[min(320px,100%)] shrink-0 flex-col overscroll-contain border-r border-[#e7e7e7] bg-[#f7f7f8] shadow-xl md:static md:z-auto md:w-72 md:shadow-none"
          : "absolute inset-y-0 left-0 z-40 flex w-[min(300px,100%)] flex-col overscroll-contain border-r border-[#e7e7e7] bg-[#f7f7f8] shadow-xl"
      }
    >
      <div className="p-3">
        <button
          type="button"
          onClick={onNewConversation}
          disabled={isReplying}
          className="flex w-full items-center gap-2 rounded-xl border border-[#dedede] bg-white px-3 py-2.5 text-left text-sm font-semibold text-[#1a1a1a] shadow-sm transition-colors hover:border-[#cfc4ff] hover:bg-[#fbfaff] disabled:opacity-50"
        >
          <MessageSquarePlus className="h-4 w-4 text-[#6d4dff]" />
          New conversation
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="flex h-8 items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8c9196]">
          <span>Recent</span>
          {isHistoryLoading && (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((conversation) => {
            const selected = conversation.id === activeConversationId;
            const deleting = deletingConversationId === conversation.id;
            return (
              <div
                key={conversation.id}
                className={`group relative rounded-xl transition-colors ${
                  selected
                    ? "bg-[#eee9ff]"
                    : "hover:bg-[#ededee] focus-within:bg-[#ededee]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conversation)}
                  disabled={isReplying || deleting}
                  aria-current={selected ? "page" : undefined}
                  className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 pr-10 text-left disabled:opacity-50"
                >
                  <MessageSquare
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      selected ? "text-[#6d4dff]" : "text-[#8c9196]"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#1a1a1a]">
                      {conversation.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[#8c9196]">
                      {formatConversationDate(conversation.lastMessageAt)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(conversation)}
                  disabled={isReplying || deleting}
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete conversation"
                  className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#8c9196] transition hover:bg-white hover:text-[#b42318] focus:opacity-100 disabled:opacity-40 ${
                    selected
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {deleting ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
          {conversations.length === 0 && !isHistoryLoading && (
            <div className="px-3 py-5 text-center text-xs leading-5 text-[#8c9196]">
              Your recent conversations will appear here.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
