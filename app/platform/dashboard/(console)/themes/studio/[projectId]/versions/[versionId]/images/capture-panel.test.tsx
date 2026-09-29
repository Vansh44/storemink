// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const queue = vi.fn();
vi.mock("@/app/actions/theme-studio-actions", () => ({
  queueThemeStudioCaptureAction: (...args: unknown[]) => queue(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CapturePanel, captureErrorText } from "./capture-panel";

afterEach(() => cleanup());

const slots = [
  {
    id: "preview",
    label: "Catalog card",
    url: null,
    placeholder: true,
    captured: false,
  },
  {
    id: "screenshot-desktop",
    label: "Desktop screenshot",
    url: null,
    placeholder: true,
    captured: false,
  },
];

const props = {
  projectId: "p",
  versionId: "v",
  revision: 7,
  packageDigest: "d".repeat(64),
  isCurrent: true,
  canEdit: true,
  captureEnabled: true,
  blockers: [] as string[],
  latest: null,
  resultVersionNumber: null,
  slots,
};

const button = () =>
  screen.getByRole("button", {
    name: /Capture/,
  }) as HTMLButtonElement;

describe("the catalog pictures panel", () => {
  it("offers a failed automatic result another browser and visual review", async () => {
    queue.mockResolvedValue({ ok: true, id: "c" });
    render(<CapturePanel {...props} retryAutomaticQa />);
    expect(
      screen.getByText(/rerun browser checks and visual review/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry automatic QA" }));
    await vi.waitFor(() =>
      expect(queue).toHaveBeenCalledWith(
        expect.objectContaining({ versionId: "v" }),
      ),
    );
  });

  it("queues a capture of the version on screen", async () => {
    queue.mockResolvedValue({ ok: true, id: "c" });
    render(<CapturePanel {...props} />);
    expect(button().textContent).toContain("Capture catalog pictures");
    fireEvent.click(button());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p",
        versionId: "v",
        expectedRevision: 7,
        expectedPackageDigest: "d".repeat(64),
      }),
    );
  });

  it("says why it cannot capture, and cannot be pressed", () => {
    render(
      <CapturePanel
        {...props}
        blockers={["1 image is still a placeholder. Draw or upload it first."]}
      />,
    );
    expect(
      screen.getByText(
        "1 image is still a placeholder. Draw or upload it first.",
      ),
    ).toBeTruthy();
    expect(button().disabled).toBe(true);
    cleanup();
    render(<CapturePanel {...props} isCurrent={false} />);
    expect(
      screen.getByText("Only the current version can be captured."),
    ).toBeTruthy();
    expect(button().disabled).toBe(true);
  });

  it("stays disabled until the browser worker is deployed", () => {
    render(<CapturePanel {...props} captureEnabled={false} />);
    expect(screen.getByText(/browser worker is deployed/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    expect(queue).not.toHaveBeenCalled();
  });

  it("follows a capture in flight, and names a failure", () => {
    const latest = {
      id: "c",
      versionId: "v",
      status: "queued" as const,
      errorCode: null,
      resultVersionId: null,
      attemptCount: 0,
      createdAt: "",
      finishedAt: null,
    };
    render(<CapturePanel {...props} latest={latest} />);
    expect(screen.getByText(/Queued: the capture job/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    cleanup();
    render(
      <CapturePanel
        {...props}
        latest={{
          ...latest,
          status: "failed",
          errorCode: "preview_status_404",
        }}
      />,
    );
    expect(
      screen.getByText(
        "Last capture failed: The preview answered with HTTP 404 instead of the storefront.",
      ),
    ).toBeTruthy();
    expect(button().disabled).toBe(false);
  });

  it("links a finished capture to the version it made, and offers to capture again", () => {
    render(
      <CapturePanel
        {...props}
        latest={{
          id: "c",
          versionId: "v",
          status: "succeeded",
          errorCode: null,
          resultVersionId: "v2",
          attemptCount: 1,
          createdAt: "",
          finishedAt: "",
        }}
        resultVersionNumber={9}
        slots={slots.map((s) => ({ ...s, placeholder: false, captured: true }))}
      />,
    );
    const link = screen.getByRole("link", { name: "version 9" });
    expect(link.getAttribute("href")).toBe(
      "/dashboard/themes/studio/p/versions/v2/images",
    );
    expect(button().textContent).toContain("Capture again");
  });

  it("explains every code the capture can fail with", () => {
    expect(captureErrorText("lease_expired")).toMatch(/stopped responding/);
    expect(captureErrorText("mystery")).toBe("The capture failed.");
    expect(captureErrorText(null)).toBe("The capture failed.");
  });
});
