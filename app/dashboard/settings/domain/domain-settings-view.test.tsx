// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/store-domain", () => ({
  updateCustomDomain: vi.fn(),
  verifyDomain: vi.fn(),
  disconnectDomain: vi.fn(),
  getDomainConnectionState: vi.fn(),
  retryGoogleIndexing: vi.fn(),
}));

import { DomainSettingsView } from "./domain-settings-view";

afterEach(cleanup);

const INDEXING = {
  state: "waiting" as const,
  origin: "https://shop.storemink.com",
  verification: "platform" as const,
  verifiedAt: null,
  sitemap: "pending" as const,
  sitemapSubmittedAt: null,
  lastAttemptAt: "2026-08-20T02:00:00.000Z",
  error: null,
};

describe("DomainSettingsView", () => {
  it("shows registrar-relative names and the fully-qualified result", () => {
    const { container } = render(
      <DomainSettingsView
        rootDomain="staging.storemink.com"
        initial={{
          domain: "storiq.in",
          verified: false,
          allowed: true,
          available: true,
          certificateState: "PROVISIONING",
          extraHosts: [],
          indexing: INDEXING,
          records: [
            {
              type: "A",
              name: "@",
              fqdn: "storiq.in",
              value: "136.69.75.127",
              purpose: "routing",
            },
            {
              type: "CNAME",
              name: "_acme-challenge",
              fqdn: "_acme-challenge.storiq.in",
              value: "token.authorize.certificatemanager.goog",
              purpose: "certificate",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("Creates _acme-challenge.storiq.in"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/GoDaddy and most DNS providers/),
    ).toBeInTheDocument();

    const copyValues = [...container.querySelectorAll("code")].map(
      (node) => node.textContent,
    );
    expect(copyValues).toEqual([
      "@",
      "136.69.75.127",
      "_acme-challenge",
      "token.authorize.certificatemanager.goog",
    ]);
  });

  it("tells a live store that www is still uncovered, instead of only 'HTTPS'", () => {
    // The apex being live is NOT the whole story: the companion certificate
    // validates separately, so a store can be serving while www still throws a
    // browser warning. That outstanding record has to stay on screen.
    render(
      <DomainSettingsView
        rootDomain="staging.storemink.com"
        initial={{
          domain: "storiq.in",
          verified: true,
          allowed: true,
          available: true,
          certificateState: "ACTIVE",
          extraHosts: [],
          indexing: INDEXING,
          records: [
            {
              type: "CNAME",
              name: "_acme-challenge.www",
              fqdn: "_acme-challenge.www.storiq.in",
              value: "token2.authorize.certificatemanager.goog",
              purpose: "certificate",
            },
          ],
        }}
      />,
    );

    // Named by the HOST it covers, not the raw challenge record.
    expect(
      screen.getByText("Finish covering www.storiq.in"),
    ).toBeInTheDocument();
    expect(screen.getByText(/security warning/)).toBeInTheDocument();
  });

  it("says so when the companion host is covered too", () => {
    render(
      <DomainSettingsView
        rootDomain="staging.storemink.com"
        initial={{
          domain: "storiq.in",
          verified: true,
          allowed: true,
          available: true,
          certificateState: "ACTIVE",
          extraHosts: ["www.storiq.in"],
          indexing: INDEXING,
          records: [],
        }}
      />,
    );

    expect(
      screen.getByText(/along with www\.storiq\.in\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Finish covering/)).not.toBeInTheDocument();
  });

  it("shows actionable Google indexing health from the persisted status", () => {
    render(
      <DomainSettingsView
        rootDomain="storemink.com"
        initial={{
          domain: null,
          verified: false,
          allowed: true,
          available: true,
          certificateState: null,
          extraHosts: [],
          records: [],
          indexing: {
            ...INDEXING,
            state: "error",
            error: "Search Console permission denied",
          },
        }}
      />,
    );

    expect(screen.getByText("Google Search coverage")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(
      screen.getByText("Search Console permission denied"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
    expect(screen.getByText("Covered by StoreMink")).toBeInTheDocument();
  });
});
