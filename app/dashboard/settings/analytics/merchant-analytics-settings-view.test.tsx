// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/actions/merchant-analytics-settings", () => ({
  saveMerchantAnalyticsSettings: h.save,
}));

import { MerchantAnalyticsSettingsView } from "./merchant-analytics-settings-view";

const NOTHING_SAVED = {
  ga4MeasurementId: "",
  ga4Enabled: false,
  metaPixelId: "",
  metaPixelEnabled: false,
};

function view(settings = NOTHING_SAVED, overrides = {}) {
  return (
    <MerchantAnalyticsSettingsView
      initial={{
        settings,
        ga4Available: true,
        metaAvailable: true,
        ga4PlatformEnabled: true,
        metaPlatformEnabled: true,
        plan: "pro",
        canManage: true,
        ...overrides,
      }}
      ga4HelpUrl="https://help.example/ga4"
      metaHelpUrl="https://help.example/meta"
    />
  );
}

beforeEach(() => {
  h.save.mockResolvedValue({ settings: NOTHING_SAVED });
});

/** Both cards render the same status vocabulary, so every assertion about one
 *  integration has to be scoped to its own card. */
function ga4Card() {
  const heading = screen.getByRole("heading", { name: "Google Analytics 4" });
  const card = heading.closest("section");
  if (!card) throw new Error("GA4 card not found");
  return within(card);
}

describe("★★ the status line describes the SERVER, not the edit box", () => {
  // The reported data loss: paste an ID, flick the switch, refresh — the ID was
  // gone. Nothing here autosaves, but the page SAID "Saved, but disabled" the
  // moment an ID was typed and "Enabled" the moment the switch moved, so a
  // merchant had every reason to believe it had persisted.
  it("does not claim an unsaved ID is saved", () => {
    render(view());
    expect(ga4Card().getByText(/Status: Not connected/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("GA4 Measurement ID"), {
      target: { value: "G-PWWB62LG19" },
    });

    // Still not connected — nothing has been sent anywhere.
    expect(ga4Card().getByText(/Status: Not connected/)).toBeVisible();
    expect(screen.queryByText(/Saved, but disabled/)).toBeNull();
    expect(ga4Card().getByText("Unsaved")).toBeVisible();
  });

  it("does not claim an unsaved toggle is active", () => {
    render(view());
    fireEvent.change(screen.getByLabelText("GA4 Measurement ID"), {
      target: { value: "G-PWWB62LG19" },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable Google Analytics 4" }),
    );

    // The switch reflects the pending edit...
    expect(
      screen.getByRole("switch", { name: "Disable Google Analytics 4" }),
    ).toHaveAttribute("aria-checked", "true");
    // ...but nothing tells the merchant it is live.
    expect(screen.queryByText("Active")).toBeNull();
    expect(ga4Card().getByText(/Status: Not connected/)).toBeVisible();
  });

  it("says Enabled and Active only for what the server returned", () => {
    render(
      view({
        ga4MeasurementId: "G-PWWB62LG19",
        ga4Enabled: true,
        metaPixelId: "",
        metaPixelEnabled: false,
      }),
    );
    expect(ga4Card().getByText(/Status: Enabled/)).toBeVisible();
    expect(ga4Card().getByText("Active")).toBeVisible();
    expect(screen.queryByText(/Unsaved/)).toBeNull();
  });

  it("says 'Saved, but disabled' only for a persisted ID that is switched off", () => {
    render(
      view({
        ga4MeasurementId: "G-PWWB62LG19",
        ga4Enabled: false,
        metaPixelId: "",
        metaPixelEnabled: false,
      }),
    );
    expect(ga4Card().getByText(/Status: Saved, but disabled/)).toBeVisible();
  });

  it("keeps the save control reachable and reports pending work", () => {
    render(view());
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(screen.getByLabelText("GA4 Measurement ID"), {
      target: { value: "G-PWWB62LG19" },
    });
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Save tracking settings/ }),
    ).toBeEnabled();
  });
});
