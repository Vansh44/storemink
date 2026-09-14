// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpAssistant } from "./help-assistant";

const askHelpAssistant = vi.fn();
const scrollIntoView = vi.fn();

vi.mock("@/app/actions/help-assistant-actions", () => ({
  askHelpAssistant: (...args: unknown[]) => askHelpAssistant(...args),
}));

describe("HelpAssistant", () => {
  beforeEach(() => {
    localStorage.clear();
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    askHelpAssistant.mockReset();
    askHelpAssistant.mockResolvedValue({
      success: true,
      data: {
        answer: "Use the Sell screen to complete the checkout.",
        steps: ["Open Sell.", "Add products.", "Select Take payment."],
        notes: ["Review the live total before completing the sale."],
        sources: [
          {
            title: "Process an in-store sale",
            url: "/help/point-of-sale/process-an-in-store-sale",
            excerpt: "Complete a counter checkout.",
          },
        ],
        clarificationPrompts: [],
        followUps: ["How do I split a payment?"],
        needsHuman: false,
      },
    });
  });

  it("opens accessibly and renders structured, sourced guidance", async () => {
    render(<HelpAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).toBeInTheDocument();
    const credit = screen.getByLabelText("Powered by StoreMink");
    expect(credit.children).toHaveLength(3);
    expect(credit.children[0]).toHaveTextContent("Powered by");
    expect(credit.children[1]).toHaveAttribute(
      "src",
      expect.stringContaining("storemink-mark.webp"),
    );
    expect(credit.children[2]).toHaveTextContent("StoreMink");

    fireEvent.change(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
      {
        target: { value: "How do I complete a POS sale?" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(
      await screen.findByText("Use the Sell screen to complete the checkout."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "smooth",
      }),
    );
    expect(scrollIntoView.mock.instances.at(-1)).toBe(
      screen
        .getByText("Use the Sell screen to complete the checkout.")
        .closest("[data-message-id]"),
    );
    expect(screen.getByText("Select Take payment.")).toBeInTheDocument();
    expect(screen.getByText("Verified guides")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Process an in-store sale/i }),
    ).toHaveAttribute("href", "/help/point-of-sale/process-an-in-store-sale");
    expect(askHelpAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do I complete a POS sale?",
        history: [expect.objectContaining({ role: "assistant" })],
      }),
    );
  });

  it("supports suggested follow-ups and resetting the conversation", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How do I process a POS sale?" }),
    );
    await screen.findByText("How do I split a payment?");

    fireEvent.click(
      screen.getByRole("button", { name: "How do I split a payment?" }),
    );
    await waitFor(() => expect(askHelpAssistant).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new conversation" }),
    );
    expect(
      screen.getByText(/Tell me what you want to do/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Use the Sell screen to complete the checkout."),
    ).not.toBeInTheDocument();
  });

  it("renders clarification guidance without turning it into a user message", async () => {
    askHelpAssistant.mockResolvedValueOnce({
      success: true,
      data: {
        answer: "Add more detail so I can find the right published guide.",
        steps: [],
        notes: [],
        sources: [],
        clarificationPrompts: [
          "The StoreMink page or menu you are using",
          "What happened after your last step",
        ],
        followUps: [],
        needsHuman: true,
      },
    });
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How do I process a POS sale?" }),
    );

    expect(
      await screen.findByText("Include these details in your reply"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The StoreMink page or menu you are using"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "The StoreMink page or menu you are using",
      }),
    ).not.toBeInTheDocument();
    expect(askHelpAssistant).toHaveBeenCalledTimes(1);
  });

  it("rejects keyboard noise instead of reusing an earlier topic", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const input = screen.getByLabelText("Ask Mink AI a StoreMink question");

    fireEvent.change(input, { target: { value: "ll" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByText(/Please enter a complete StoreMink question/i),
    ).toBeInTheDocument();
    expect(askHelpAssistant).not.toHaveBeenCalled();
  });

  it("supports accessible keyboard resizing and remembers the width", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const resizer = screen.getByRole("separator", {
      name: "Resize Mink AI drawer",
    });

    expect(resizer).toHaveAttribute("aria-valuenow", "480");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "504");
    expect(localStorage.getItem("sm-help-mink-width")).toBe("504");
  });

  it("maximizes to the full viewport and restores the resizable drawer", () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    fireEvent.click(screen.getByRole("button", { name: "Maximize Mink AI" }));

    expect(dialog).toHaveClass("is-maximized");
    expect(
      screen.queryByRole("separator", { name: "Resize Mink AI drawer" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore Mink AI drawer" }),
    );
    expect(dialog).not.toHaveClass("is-maximized");
    expect(
      screen.getByRole("separator", { name: "Resize Mink AI drawer" }),
    ).toBeInTheDocument();
  });

  // ★★ THE DRAWER MUST LEAVE THE HEADER. `.hc-topbar` carries
  // `backdrop-filter: blur(18px)`, which makes it the containing block for
  // every `position: fixed` descendant — so a drawer rendered in place
  // resolved top/right/bottom against the 73px header and opened as a 360x8px
  // sliver at its bottom edge (measured live on help.storemink.com). Nothing
  // threw and every assertion above still passed, which is why this pins the
  // PARENT rather than any visible state: jsdom computes no layout, so the
  // only observable difference is where the panel is mounted.
  it("portals the drawer out of the backdrop-filtered header", () => {
    const header = document.createElement("header");
    header.className = "hc-topbar";
    const overlayHost = document.createElement("div");
    overlayHost.id = "hc-overlay-root";
    document.body.append(header, overlayHost);

    render(<HelpAssistant />, { container: header });
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    expect(overlayHost).toContainElement(dialog);
    expect(header.contains(dialog)).toBe(false);
    expect(header.querySelector(".hc-assistant-backdrop")).toBeNull();
    expect(overlayHost.querySelector(".hc-assistant-backdrop")).not.toBeNull();

    header.remove();
    overlayHost.remove();
  });
});
