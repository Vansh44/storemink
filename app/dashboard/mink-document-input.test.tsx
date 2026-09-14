// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MinkDocumentInput } from "./mink-document-input";
afterEach(cleanup);
function upload(text: string, name = "echos.txt") {
  const file = new File([text], name, { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose text document"), {
    target: { files: [file] },
  });
}
describe("local document review", () => {
  it("does not add anything without review; edits reset consent", async () => {
    const add = vi.fn();
    render(
      <MinkDocumentInput message="Summarise" onAdd={add} disabled={false} />,
    );
    upload("Echos notes");
    await screen.findByLabelText("Document text");
    const button = screen.getByRole("button", {
      name: "Add reviewed text to message",
    });
    expect(button).toBeDisabled();
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Document text"), {
      target: { value: "Updated notes" },
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(add).toHaveBeenCalledWith(
      expect.stringContaining('"text":"Updated notes"'),
    );
    expect(screen.queryByLabelText("Document text")).not.toBeInTheDocument();
  });
  it("discards local data without adding it to a message", async () => {
    const add = vi.fn();
    render(<MinkDocumentInput message="" onAdd={add} disabled={false} />);
    upload("Notes");
    await screen.findByLabelText("Document text");
    fireEvent.click(screen.getByText("Discard document"));
    expect(add).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Document text")).not.toBeInTheDocument();
  });
  it("shows a validation error for unsupported input", async () => {
    const add = vi.fn();
    render(<MinkDocumentInput message="" onAdd={add} disabled={false} />);
    upload("not a PDF", "notes.pdf");
    expect(await screen.findByRole("alert")).toHaveTextContent("not supported");
    expect(add).not.toHaveBeenCalled();
  });
  it("preserves the review when the combined message is too long", async () => {
    const add = vi.fn();
    render(
      <MinkDocumentInput
        message={"x".repeat(4000)}
        onAdd={add}
        disabled={false}
      />,
    );
    upload("Notes");
    await screen.findByLabelText("Document text");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Add reviewed text to message"));
    expect(await screen.findByRole("alert")).toHaveTextContent("exceed 4,000");
    expect(add).not.toHaveBeenCalled();
  });
});
