// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MerchantTracking } from "./merchant-tracking";

vi.mock("next/navigation", () => ({ usePathname: () => "/products" }));
vi.mock("next/script", () => ({
  default: ({ id }: { id: string }) => <script data-testid={id} />,
}));

describe("MerchantTracking consent gate", () => {
  const sendBeacon = vi.fn(() => true);

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    sendBeacon.mockClear();
    delete window.gtag;
    delete window.fbq;
  });

  it("does not render either provider before consent", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
        firstPartyEnabled={false}
      >
        <div>Store</div>
      </MerchantTracking>,
    );

    expect(
      await screen.findByRole("dialog", { name: /privacy choices/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /privacy policy/i }),
    ).toHaveAttribute("href", "/privacy-policy");
    expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
  });

  it("loads only after opt-in and lets the visitor revoke it", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
        firstPartyEnabled={false}
      >
        <div>Store</div>
      </MerchantTracking>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    expect(await screen.findByTestId(/sm-ga4-init/)).toBeInTheDocument();
    expect(screen.getByTestId(/sm-meta-pixel/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Privacy choices" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject optional" }));

    await waitFor(() => {
      expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
    });
  });

  it("keeps analytics and marketing consent independent", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
        firstPartyEnabled={false}
      >
        <div>Store</div>
      </MerchantTracking>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage choices" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Analytics/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));

    expect(await screen.findByTestId(/sm-ga4-init/)).toBeInTheDocument();
    expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
  });

  it("restores a saved browser choice", async () => {
    localStorage.setItem(
      "sm.storefront-tracking-consent.v1",
      JSON.stringify({
        version: 1,
        analytics: false,
        marketing: true,
        decidedAt: "2026-08-20T12:00:00.000Z",
      }),
    );

    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
        firstPartyEnabled={false}
      >
        <div>Store</div>
      </MerchantTracking>,
    );

    expect(await screen.findByTestId(/sm-meta-pixel/)).toBeInTheDocument();
    expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("applies a revocation received from another tab", async () => {
    localStorage.setItem(
      "sm.storefront-tracking-consent.v1",
      JSON.stringify({
        version: 1,
        analytics: true,
        marketing: true,
        decidedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    window.gtag = vi.fn();
    window.fbq = vi.fn() as Window["fbq"];

    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
        firstPartyEnabled={false}
      >
        <div>Store</div>
      </MerchantTracking>,
    );
    expect(await screen.findByTestId(/sm-ga4-init/)).toBeInTheDocument();

    const revoked = JSON.stringify({
      version: 1,
      analytics: false,
      marketing: false,
      decidedAt: "2026-08-20T12:05:00.000Z",
    });
    localStorage.setItem("sm.storefront-tracking-consent.v1", revoked);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sm.storefront-tracking-consent.v1",
        newValue: revoked,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
      expect(window.gtag).toHaveBeenCalledWith("consent", "update", {
        analytics_storage: "denied",
      });
      expect(window.fbq).toHaveBeenCalledWith("consent", "revoke");
    });
  });

  it("sends first-party events only after analytics consent", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId={null}
        metaPixelId={null}
        firstPartyEnabled
      >
        <div>Store</div>
      </MerchantTracking>,
    );

    expect(sendBeacon).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(sendBeacon).toHaveBeenCalledTimes(1));
    expect(sendBeacon).toHaveBeenCalledWith("/api/t", expect.any(Blob));
  });
});
