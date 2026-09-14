// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskAnything } from "./ask-anything";
import { useChat } from "./chat-context";

vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
}));

describe("dashboard Ask anything", () => {
  it("uses an iOS-safe input size and carries the prompt into full view", () => {
    const startExpandedChat = vi.fn();
    vi.mocked(useChat).mockReturnValue({
      isChatOpen: false,
      startExpandedChat,
    } as unknown as ReturnType<typeof useChat>);

    render(<AskAnything />);

    const input = screen.getByLabelText("Message Mink AI");
    expect(input).toHaveClass("min-w-0", "text-base", "sm:text-[15px]");

    fireEvent.change(input, { target: { value: "What is my plan?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(startExpandedChat).toHaveBeenCalledWith("What is my plan?");
  });

  it("tells the phone keyboard what this field is for", () => {
    vi.mocked(useChat).mockReturnValue({
      isChatOpen: false,
      startExpandedChat: vi.fn(),
    } as unknown as ReturnType<typeof useChat>);

    render(<AskAnything />);
    const input = screen.getByLabelText("Message Mink AI");

    // Invisible on a desktop browser and therefore easy to delete by accident,
    // but on iOS they are the difference between QuickType word suggestions and
    // the password/card/address AutoFill bar sitting over a chat composer.
    expect(input).toHaveAttribute("enterkeyhint", "send");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocapitalize", "sentences");
  });
});
