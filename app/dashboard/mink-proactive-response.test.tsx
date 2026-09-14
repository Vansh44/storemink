// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MinkProactiveResponse } from "./mink-proactive-response";
import type { ProactiveResponseResult } from "@/lib/mink/proactive-response-types";

function result(path: string): ProactiveResponseResult {
  return {
    signal: "inventory",
    evidence: {
      key: "inventory",
      status: "attention",
      evidence: "Shop has a stock gap",
      nextStep: "Count the shelf",
    } as ProactiveResponseResult["evidence"],
    dataAsOf: "2026-09-06T00:00:00Z",
    locationLabel: "Shop and Delhi",
    timeZone: "Asia/Kolkata",
    rangeLabel: "Yesterday",
    rows: [{ label: "<img src=x onerror=alert(1)>", detail: "Stock 0", path }],
    truncated: true,
    nextSteps: ["Count the shelf"],
    limitations: ["Read-only"],
  };
}
describe("Approved response result safety", () => {
  it.each([
    "javascript:alert(1)",
    "//evil.example",
    "/dashboard/orders/../../settings",
  ])("does not activate unsafe result links: %s", (path) => {
    const { container } = render(
      <MinkProactiveResponse result={result(path)} />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/dashboard");
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
  });
  it("shows scoped details, truncation and unexecuted recommendations", () => {
    const path =
      "/dashboard/inventory?location=11111111-1111-4111-8111-111111111111";
    render(<MinkProactiveResponse result={result(path)} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", path);
    expect(screen.getByText(/Showing a limited sample/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Suggested next steps—not executed",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Shop and Delhi/)).toBeInTheDocument();
  });
});
