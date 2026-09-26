// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const action = vi.fn();
vi.mock("@/app/actions/theme-studio-actions", () => ({
  queueThemeStudioImagesAction: (...args: unknown[]) => action(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GenerateImagesButton } from "./generate-images-button";

const props = {
  projectId: "p",
  versionId: "v",
  revision: 4,
  packageDigest: "d".repeat(64),
  slots: 6,
  estimate: "about $0.70",
  blockedReason: null,
};

afterEach(() => cleanup());

describe("GenerateImagesButton", () => {
  it("states the image count and cost before anything is queued", () => {
    render(<GenerateImagesButton {...props} />);
    expect(screen.getByText(/6 placeholder slots/)).toBeTruthy();
    expect(
      screen.getByText(/7 images, about \$0.70 at list price/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Generate images/ }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Draw 7 images" })).toBeTruthy();
  });

  it("queues against the version and digest on screen once confirmed", async () => {
    action.mockResolvedValue({ ok: true, id: "run" });
    render(<GenerateImagesButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Generate images/ }));
    fireEvent.click(screen.getByRole("button", { name: "Draw 7 images" }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith("/dashboard/themes/studio/p"),
    );
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p",
        versionId: "v",
        expectedRevision: 4,
        expectedPackageDigest: props.packageDigest,
      }),
    );
  });

  it("says why it cannot run, and cannot be pressed", () => {
    render(
      <GenerateImagesButton
        {...props}
        blockedReason="Wait for the active run to finish."
      />,
    );
    expect(screen.getByText("Wait for the active run to finish.")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Generate images/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("offers nothing when no slot needs an image, and names the test provider as free", () => {
    const { container } = render(<GenerateImagesButton {...props} slots={0} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    render(<GenerateImagesButton {...props} estimate={null} />);
    expect(
      screen.getByText(/test provider draws placeholder pictures at no cost/),
    ).toBeTruthy();
  });
});
