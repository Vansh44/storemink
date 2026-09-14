// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
vi.mock("../mink-workflow-card", () => ({
  MinkWorkflowCard: ({ artifact }: { artifact: { runId: string } }) => (
    <p>Workflow {artifact.runId}</p>
  ),
}));
import { MinkResponsePanel } from "./response-panel";
const fetcher = vi.fn();
const plan = {
  rank: 1,
  signal: "inventory",
  title: "Review Delhi shortages",
  evidence: "2 out-of-stock SKUs at Delhi",
  impact: "Revenue impact unknown",
  locationLabel: "Delhi",
  rangeLabel: "Yesterday",
  timeZone: "Asia/Kolkata",
  dataAsOf: "2026-09-06T10:00:00Z",
  limits: "One read-only investigation; no business changes",
  planHash: "hash",
  sourceRunId: "source",
  expiresAt: "2099-09-07T10:00:00Z",
  status: "proposed",
  workflowId: null,
};
const data = {
  active: true,
  plans: [plan],
  investigations: [],
  ranking: "Evidence-based review order",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  fetcher.mockReset().mockResolvedValue(response(data));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("human response approval", () => {
  it("requires consent and sends only the exact displayed plan", async () => {
    render(<MinkResponsePanel watchId="Delhi-watch" />);
    const button = await screen.findByRole("button", {
      name: "Approve investigation",
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fetcher
      .mockResolvedValueOnce(response({ status: "approved" }))
      .mockResolvedValueOnce(
        response({
          ...data,
          plans: [{ ...plan, status: "approved", workflowId: "one" }],
        }),
      );
    fireEvent.click(button);
    await screen.findByText("Workflow one");
    const call = fetcher.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(call[1].body)).toEqual({
      action: "approve",
      watchId: "Delhi-watch",
      sourceRunId: "source",
      signal: "inventory",
      planHash: "hash",
      confirmed: true,
    });
  });
  it("dismisses without approving a workflow", async () => {
    render(<MinkResponsePanel watchId="watch" />);
    const button = await screen.findByRole("button", { name: "Dismiss" });
    fetcher
      .mockResolvedValueOnce(response({ status: "dismissed" }))
      .mockResolvedValueOnce(
        response({ ...data, plans: [{ ...plan, status: "dismissed" }] }),
      );
    fireEvent.click(button);
    await screen.findByText("Dismissed for this evidence snapshot.");
    expect(screen.queryByText(/Workflow /)).not.toBeInTheDocument();
  });
  it("keeps a failed approval retryable and never claims it succeeded", async () => {
    render(<MinkResponsePanel watchId="watch" />);
    await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("checkbox"));
    fetcher.mockResolvedValueOnce(response({ error: "Plan changed" }, 409));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve investigation" }),
    );
    await screen.findByText("Plan changed");
    expect(
      screen.queryByText(/Investigation approved/),
    ).not.toBeInTheDocument();
  });
  it("clears inaccessible evidence after a refresh failure", async () => {
    render(<MinkResponsePanel watchId="watch" />);
    await screen.findByText("2 out-of-stock SKUs at Delhi");
    fetcher.mockResolvedValueOnce(response({ error: "Access revoked" }, 403));
    fireEvent.click(screen.getByRole("button", { name: "Refresh responses" }));
    await waitFor(() =>
      expect(
        screen.queryByText("2 out-of-stock SKUs at Delhi"),
      ).not.toBeInTheDocument(),
    );
  });
  it("disables approvals on paused watches", async () => {
    fetcher.mockResolvedValueOnce(response({ ...data, active: false }));
    render(<MinkResponsePanel watchId="watch" />);
    expect(await screen.findByRole("checkbox")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Approve investigation" }),
    ).toBeDisabled();
  });
});
