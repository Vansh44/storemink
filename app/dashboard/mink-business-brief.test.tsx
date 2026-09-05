import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBusinessBriefResult,
  type BusinessBriefSnapshot,
} from "@/lib/mink/business-brief-types";
import { MinkBusinessBrief } from "./mink-business-brief";
import { MinkWorkflowCard } from "./mink-workflow-card";

const snapshot: BusinessBriefSnapshot = {
  period: "daily",
  rangeLabel: "4 Sep 2026",
  comparisonLabel: "3 Sep 2026",
  fromInclusive: "2026-09-03T18:30:00Z",
  toExclusive: "2026-09-04T18:30:00Z",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationLabel: "Shop and Delhi",
  netSales: 800,
  previousNetSales: 1000,
  orders: 8,
  previousOrders: 10,
  returns: 0,
  previousReturns: 0,
  createdOrders: 0,
  failedPaymentOrders: 0,
  locations: [
    { id: "shop", name: "Shop", trackedItems: 8, lowStock: 1, outOfStock: 2 },
    { id: "delhi", name: "Delhi", trackedItems: 8, lowStock: 0, outOfStock: 6 },
  ],
  dataAsOf: "2026-09-05T04:00:00Z",
};
const result = buildBusinessBriefResult(snapshot);
const artifact = {
  type: "workflow" as const,
  template: "business_brief" as const,
  runId: "brief-1",
  title: "Business brief",
  description: "Business evidence",
  status: "queued" as const,
  currentStep: 0,
  totalSteps: 3,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mink business brief UI", () => {
  it("renders dates, evidence states and separate location counts", () => {
    render(<MinkBusinessBrief result={result} />);
    expect(
      screen.getByRole("heading", { name: "Daily business brief" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 Sep 2026.*3 Sep 2026/)).toBeInTheDocument();
    expect(screen.getAllByText("Needs attention")).toHaveLength(2);
    expect(screen.getAllByText("Not enough data")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Shop" })).toHaveAttribute(
      "href",
      "/dashboard/inventory?location=shop",
    );
    expect(
      screen.getByRole("link", { name: "Delhi" }).closest("tr"),
    ).toHaveTextContent("Delhi806");
    expect(screen.getByText(/not an all-clear/)).toBeInTheDocument();
  });
  it("escapes merchant location text and does not activate stored signal URLs", () => {
    const malicious = {
      ...result,
      locations: [
        { ...result.locations[0], name: '<img src=x onerror="alert(1)">' },
      ],
      signals: result.signals.map((signal) => ({
        ...signal,
        path: "javascript:alert(1)",
      })),
    };
    const { container } = render(<MinkBusinessBrief result={malicious} />);
    expect(container.querySelector("img")).toBeNull();
    expect(
      [...container.querySelectorAll("a")].every((link) =>
        link.getAttribute("href")?.startsWith("/dashboard/"),
      ),
    ).toBe(true);
  });
  it("renders the completed result through the shared workflow progress card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        workflow: {
          id: "brief-1",
          template: "business_brief",
          status: "completed",
          currentStep: 3,
          totalSteps: 3,
          result,
          events: [],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MinkWorkflowCard artifact={artifact} />);
    await screen.findByRole("heading", { name: "Daily business brief" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mink/workflows/brief-1",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });
  it("keeps cancellation on the shared authenticated API", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, options: RequestInit) => ({
        ok: true,
        json: async () => ({
          workflow: {
            id: "brief-1",
            template: "business_brief",
            status: options.method === "POST" ? "cancelled" : "queued",
            currentStep: 0,
            totalSteps: 3,
            result: null,
            events: [],
          },
        }),
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MinkWorkflowCard artifact={artifact} />);
    const cancel = await screen.findByRole("button", { name: /stop/i });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mink/workflows/brief-1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "cancel" }),
          credentials: "same-origin",
        }),
      ),
    );
  });
});
