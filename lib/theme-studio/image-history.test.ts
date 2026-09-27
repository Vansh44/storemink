import { describe, expect, it } from "vitest";
import {
  hasReusableAnchor,
  imageRunSummary,
  redrawEstimate,
  slotDrawHistory,
  type StoredImageRun,
} from "./image-history";

const run = (over: Partial<StoredImageRun> = {}): StoredImageRun => ({
  id: "run-1",
  createdAt: "2026-09-27 10:00:00+00",
  imageSlotIds: [],
  outcomeDetail: { kind: "images", outcomes: [] },
  usage: { calls: [], reviews: [] },
  ...over,
});

describe("how each slot's image came to be", () => {
  it("takes the nearest run that drew a slot, and passes over one that skipped it", () => {
    const redraw = run({
      id: "redraw",
      imageSlotIds: ["hero", "mug"],
      outcomeDetail: {
        outcomes: [
          {
            slotId: "hero",
            status: "generated",
            attempts: 2,
            review: "passed",
          },
          { slotId: "mug", status: "skipped" },
        ],
      },
    });
    const full = run({
      id: "full",
      outcomeDetail: {
        outcomes: [
          {
            slotId: "hero",
            status: "generated",
            attempts: 1,
            review: "passed",
          },
          {
            slotId: "mug",
            status: "generated",
            attempts: 1,
            review: "flagged",
            problems: ["poor_crop", "made_up"],
            note: "Handle cut off.",
          },
        ],
      },
    });
    const history = slotDrawHistory([redraw, full]);
    expect(history.get("hero")).toMatchObject({
      runId: "redraw",
      attempts: 2,
      review: "passed",
      redraw: true,
    });
    expect(history.get("mug")).toMatchObject({
      runId: "full",
      review: "flagged",
      problems: ["poor_crop"],
      note: "Handle cut off.",
      redraw: false,
    });
  });

  it("prices a slot from its own image and check calls only", () => {
    const history = slotDrawHistory([
      run({
        outcomeDetail: {
          outcomes: [{ slotId: "hero", status: "generated", attempts: 2 }],
        },
        usage: {
          calls: [
            { briefId: "anchor", estimatedCostMicroUsd: 100_000 },
            { briefId: "hero", estimatedCostMicroUsd: 101_000 },
            { briefId: "hero", estimatedCostMicroUsd: 102_000 },
            { briefId: "mug", estimatedCostMicroUsd: 99_000 },
          ],
          reviews: [
            { briefId: "hero", estimatedCostMicroUsd: 3_000 },
            { briefId: "hero", estimatedCostMicroUsd: -5 },
          ],
        },
      }),
    ]);
    expect(history.get("hero")?.costMicroUsd).toBe(206_000);
  });

  it("reads a run made before checks and redraws existed as one unchecked attempt", () => {
    const history = slotDrawHistory([
      run({
        outcomeDetail: {
          outcomes: [
            { slotId: "hero", status: "generated" },
            { slotId: "mug", status: "refused", reason: "IMAGE_SAFETY" },
            { slotId: "bowl", status: "failed", code: "rate_limited" },
            { slotId: "odd", status: "exploded" },
            "not an object",
          ],
        },
        usage: null,
      }),
    ]);
    expect(history.get("hero")).toMatchObject({
      attempts: 1,
      review: "unreviewed",
      costMicroUsd: 0,
    });
    expect(history.get("mug")).toMatchObject({
      status: "refused",
      reason: "IMAGE_SAFETY",
      review: null,
    });
    expect(history.get("bowl")?.reason).toBe("rate_limited");
    expect(history.has("odd")).toBe(false);
  });

  it("reads nothing from a run with no outcomes", () => {
    expect(slotDrawHistory([run({ outcomeDetail: null })]).size).toBe(0);
    expect(slotDrawHistory([]).size).toBe(0);
  });
});

describe("an image run in the run list", () => {
  it("counts what came back and splits the cost", () => {
    const summary = imageRunSummary(
      run({
        imageSlotIds: ["a", "b", "c", "d", "e", "f"],
        outcomeDetail: {
          outcomes: [
            { slotId: "a", status: "generated", attempts: 1, review: "passed" },
            {
              slotId: "b",
              status: "generated",
              attempts: 2,
              review: "flagged",
            },
            {
              slotId: "c",
              status: "generated",
              attempts: 1,
              review: "unreviewed",
            },
            { slotId: "d", status: "rejected", attempts: 2 },
            { slotId: "e", status: "refused", attempts: 1 },
            { slotId: "f", status: "skipped" },
          ],
        },
        usage: {
          calls: [
            { estimatedCostMicroUsd: 100_000 },
            { estimatedCostMicroUsd: 100_000 },
          ],
          reviews: [{ estimatedCostMicroUsd: 3_000 }],
        },
      }),
    );
    expect(summary).toEqual({
      redraw: true,
      slots: 6,
      generated: 3,
      rejected: 1,
      failed: 1,
      skipped: 1,
      redrawn: 2,
      flagged: 1,
      unreviewed: 1,
      imageCostMicroUsd: 200_000,
      reviewCostMicroUsd: 3_000,
    });
  });

  it("has nothing to say about a run that never drew", () => {
    expect(imageRunSummary(run())).toBeNull();
  });
});

describe("reusing the art-direction image", () => {
  it("is possible once any run in the lineage recorded one", () => {
    expect(hasReusableAnchor([run()])).toBe(false);
    expect(
      hasReusableAnchor([
        run(),
        run({ outcomeDetail: { anchorAssetId: "a-1", outcomes: [] } }),
      ]),
    ).toBe(true);
  });

  it("prices a redraw with or without a new art-direction image", () => {
    const prices = { imageUsd: 0.1, reviewUsd: 0.003 };
    expect(redrawEstimate(2, true, prices)).toEqual({
      images: 2,
      expectedUsd: 0.21,
      mostUsd: 0.41,
    });
    expect(redrawEstimate(2, false, prices)).toEqual({
      images: 3,
      expectedUsd: 0.31,
      mostUsd: 0.62,
    });
  });
});
