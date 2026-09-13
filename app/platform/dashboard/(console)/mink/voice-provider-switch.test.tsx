import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/app/actions/mink-operator-actions", () => ({
  setMinkVoiceProvider: h.save,
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { VoiceProviderSwitch } from "./voice-provider-switch";

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.save.mockResolvedValue({ success: true, provider: "saaras_v4" });
});

describe("global voice provider switch", () => {
  it("changes the one global setting immediately", async () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage />);
    const control = screen.getByRole("switch", {
      name: "Use Sarvam Saaras v4 globally",
    });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    await waitFor(() => expect(h.save).toHaveBeenCalledWith("saaras_v4"));
    await waitFor(() =>
      expect(control).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText(/used by Mink for every store/i)).toBeVisible();
  });

  it("is read-only for operators who cannot manage platform settings", () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage={false} />);
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});
