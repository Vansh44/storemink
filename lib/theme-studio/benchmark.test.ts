import { expect, it } from "vitest";
import { themeBenchmarkReport, THEME_BENCHMARK_CASES } from "./benchmark";
import { validateProjectInput } from "./repository";

it("all four live benchmark briefs pass the same project intake as operators", () => {
  for (const entry of THEME_BENCHMARK_CASES)
    expect(
      validateProjectInput({
        name: entry.name,
        themeId: `benchmark-${entry.name.toLowerCase()}`,
        brief: entry.brief,
        industries: [entry.industry],
        catalogSizes: ["small"],
        requiredFeatures: ["category-navigation"],
        baseThemeId: null,
        modelKey: "gemini-3.8-flash",
      }).industries,
    ).toEqual([entry.industry]);
});

it("reports actual final QA rather than treating successful generation or snapshot count as a quality pass", () => {
  const input = {
    project: { id: "p", name: "Apparel", status: "ready" },
    measuredAt: "2026-10-02T12:00:00Z",
    versions: Array(12).fill({}),
    runs: [
      {
        kind: "generate",
        status: "succeeded",
        provider: "vertex-gemini",
        createdAt: "2026-10-02T10:00:00Z",
        startedAt: "2026-10-02T10:01:00Z",
        finishedAt: "2026-10-02T10:06:00Z",
        usage: { estimatedCostMicroUsd: 100000 },
      },
      {
        kind: "revise",
        automatic: true,
        status: "succeeded",
        provider: "vertex-gemini",
      },
    ],
    captures: [],
    qa: [
      {
        status: "passed",
        qaIteration: 0,
        createdAt: "2026-10-02T10:06:00Z",
        browserReport: { phase: "layout" },
      },
      {
        status: "revision_queued",
        qaIteration: 0,
        createdAt: "2026-10-02T10:30:00Z",
        finishedAt: "2026-10-02T10:35:00Z",
        browserReport: { gates: [] },
      },
      {
        status: "failed",
        qaIteration: 1,
        createdAt: "2026-10-02T10:40:00Z",
        finishedAt: "2026-10-02T10:45:00Z",
        errorCode: "qa_no_progress",
        browserReport: { gates: [] },
      },
    ],
  };
  expect(themeBenchmarkReport(input)).toMatchObject({
    completed: false,
    firstFinalQaPassed: false,
    snapshots: 12,
    designRevisions: 1,
    automaticRevisions: 1,
    wallMs: 45 * 60 * 1000,
    estimatedRunCostMicroUsd: 100000,
  });
  const offline = themeBenchmarkReport({
    ...input,
    runs: input.runs.map((r) => ({ ...r, provider: "fake" })),
  });
  expect(offline.mode).toBe("offline-or-mixed");
  expect(offline.firstFinalQaPassed).toBeNull();
});

it("does not report a queued review as failed, and keeps an incomplete wall clock open", () => {
  const r = themeBenchmarkReport({
    project: { status: "generating" },
    runs: [
      {
        kind: "generate",
        provider: "vertex-gemini",
        createdAt: "2026-10-02T10:00:00Z",
        finishedAt: "2026-10-02T10:05:00Z",
      },
    ],
    qa: [{ status: "queued", browserReport: {} }],
    versions: [],
    captures: [],
    measuredAt: "2026-10-02T10:10:00Z",
  });
  expect(r).toMatchObject({
    terminal: false,
    completed: false,
    firstFinalQaPassed: null,
    wallMs: 10 * 60 * 1000,
  });
});

it("does not grade fake or unattributed visual scores as live quality, and reports the latest slot outcomes", () => {
  const input = {
    project: { status: "candidate" },
    measuredAt: "2026-10-02T10:10:00Z",
    runs: [
      { kind: "generate", provider: "vertex-gemini" },
      {
        kind: "images",
        provider: "vertex-gemini",
        createdAt: "2026-10-02T10:01:00Z",
        outcomeDetail: {
          outcomes: [
            { slotId: "a", status: "rejected", attempts: 2 },
            {
              slotId: "b",
              status: "generated",
              review: "flagged",
              attempts: 1,
            },
          ],
        },
      },
      {
        kind: "images",
        provider: "vertex-gemini",
        createdAt: "2026-10-02T10:03:00Z",
        imageSlotIds: ["a", "b"],
        outcomeDetail: {
          outcomes: [
            { slotId: "a", status: "generated", review: "passed", attempts: 1 },
            {
              slotId: "b",
              status: "generated",
              review: "flagged",
              attempts: 2,
            },
          ],
        },
      },
    ],
    qa: [
      {
        status: "passed",
        qaIteration: 0,
        browserReport: {},
        visionReport: { provider: "vertex-gemini", scores: { total: 36 } },
      },
    ],
    versions: [],
    captures: [],
  };
  expect(themeBenchmarkReport(input)).toMatchObject({
    firstFinalQaPassed: true,
    redrawEvents: 2,
    targetedRedrawSlots: 2,
    slotFailureEvents: 1,
    lastReportedFailedSlots: 0,
    lastReportedFlaggedSlots: 1,
  });
  for (const provider of ["fake", undefined]) {
    const report = themeBenchmarkReport({
      ...input,
      qa: input.qa.map((q) => ({
        ...q,
        visionReport: { ...q.visionReport, provider },
      })),
    });
    expect(report.firstFinalQaPassed).toBeNull();
    expect(report.mode).toBe("offline-or-mixed");
  }
  // A preflight repair can yield a clean first final review, but the original
  // draft did not pass without a correction. Preserve both measurements.
  expect(
    themeBenchmarkReport({
      ...input,
      qa: input.qa.map((q) => ({ ...q, qaIteration: 1 })),
    }),
  ).toMatchObject({ firstFinalQaPassed: true, firstPassQaPassed: false });
});
