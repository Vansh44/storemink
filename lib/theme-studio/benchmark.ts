/** Reports actual persisted orchestration, including hidden image/capture
 * snapshots. Fake-provider outcomes are never a model quality grade. */
type Row = Record<string, unknown>;
export const THEME_BENCHMARK_CASES = [
  {
    name: "Apparel",
    industry: "clothing",
    brief:
      "Build an editorial premium apparel shop. Original warm-neutral brand voice, large tactile product photography, size/colour options, collection discovery and a concise about page. Balanced native commerce, eight realistic products, no unsupported interactions.",
  },
  {
    name: "Food",
    industry: "food-and-drink",
    brief:
      "Build a welcoming specialty pantry shop with quick product discovery, clear pricing, category navigation and an about page explaining provenance. Natural packaged-food still life, cohesive lighting, eight realistic products, no people or unsupported interactions.",
  },
  {
    name: "Beauty",
    industry: "beauty",
    brief:
      "Build a refined skincare shop with plum accents, accessible contrast, product benefits and collection discovery. Cohesive bottle and packaging still life, eight realistic products, a useful brand story, no health claims, people or unsupported interactions.",
  },
  {
    name: "Home",
    industry: "home",
    brief:
      "Build a calm ceramics and homeware shop with generous spacing and original craft-focused copy. Cohesive ceramic still life, eight realistic products, collection discovery and a concise about page. No people or unsupported interactions.",
  },
] as const;
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const date = (v: unknown): number | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? Date.parse(v)
    : null;
const duration = (start: unknown, end: unknown): number | null => {
  const a = date(start),
    b = date(end);
  return a === null || b === null ? null : Math.max(0, b - a);
};

export function themeBenchmarkReport(input: {
  project: Row;
  runs: Row[];
  captures: Row[];
  qa: Row[];
  versions: Row[];
  measuredAt: string;
}) {
  const { project, runs, captures, versions } = input;
  const qa = [...input.qa].sort(
    (a, b) => (date(a.createdAt) ?? 0) - (date(b.createdAt) ?? 0),
  );
  const final = qa.filter((r) => object(r.browserReport).phase !== "layout");
  const initial = [...runs]
    .filter((r) => r.kind === "generate")
    .sort((a, b) => (date(a.createdAt) ?? 0) - (date(b.createdAt) ?? 0))[0];
  const terminal =
    project.status !== "generating" && project.status !== "draft";
  const ends = [...runs, ...captures, ...qa]
    .map((r) => date(r.finishedAt))
    .filter((v): v is number => v !== null);
  const last =
    terminal && ends.length
      ? new Date(Math.max(...ends)).toISOString()
      : input.measuredAt;
  const live =
    runs.length > 0 &&
    runs.every((r) => r.provider === "vertex-gemini") &&
    final.every((r) => {
      const vision = object(r.visionReport);
      // Old records do not prove which provider judged their scores. Never
      // turn fake or unattributed vision evidence into a live quality grade.
      return !vision.scores || vision.provider === "vertex-gemini";
    });
  const images = runs
    .filter((r) => r.kind === "images")
    .sort((a, b) => (date(a.createdAt) ?? 0) - (date(b.createdAt) ?? 0));
  const outcomes = images.flatMap((r) =>
    array(object(r.outcomeDetail).outcomes).map(object),
  );
  const first = final[0];
  const lastSlotState = new Map(
    outcomes
      .filter((o) => typeof o.slotId === "string")
      .map((o) => [o.slotId, o]),
  );
  const timing = captures.map((r) => ({
    id: r.id,
    phase: r.phase,
    status: r.status,
    queueMs: duration(r.createdAt, r.startedAt),
    wallMs: duration(r.startedAt, r.finishedAt),
    error: r.errorCode,
  }));
  return {
    projectId: project.id,
    name: project.name,
    status: project.status,
    mode: live ? "live" : "offline-or-mixed",
    terminal,
    measuredAt: input.measuredAt,
    wallMs: initial ? duration(initial.createdAt, last) : null,
    firstFinalQaPassed:
      live && first && first.status !== "queued" && first.status !== "running"
        ? first.status === "passed"
        : null,
    firstPassQaPassed:
      live && first && first.status !== "queued" && first.status !== "running"
        ? first.status === "passed" && count(first.qaIteration) === 0
        : null,
    completed: project.status === "candidate",
    snapshots: versions.length,
    designRevisions: runs.filter((r) => r.kind === "revise").length,
    automaticRevisions: runs.filter(
      (r) => r.kind === "revise" && r.automatic === true,
    ).length,
    imageRuns: images.length,
    redrawEvents: outcomes.filter((r) => count(r.attempts) > 1).length,
    targetedRedrawSlots: new Set(images.flatMap((r) => array(r.imageSlotIds)))
      .size,
    slotFailureEvents: outcomes.filter((r) =>
      ["failed", "unusable", "refused", "rejected"].includes(String(r.status)),
    ).length,
    lastReportedFailedSlots: [...lastSlotState.values()].filter((v) =>
      ["failed", "unusable", "refused", "rejected"].includes(String(v.status)),
    ).length,
    lastReportedFlaggedSlots: [...lastSlotState.values()].filter(
      (v) => v.status === "generated" && v.review === "flagged",
    ).length,
    rateLimitDeferrals: runs.reduce(
      (n, r) => n + count(r.rateLimitDeferrals),
      0,
    ),
    imageReviewDeferrals: runs.reduce(
      (n, r) => n + count(r.imageReviewDeferrals),
      0,
    ),
    estimatedRunCostMicroUsd: runs.reduce(
      (n, r) => n + count(object(r.usage).estimatedCostMicroUsd),
      0,
    ),
    // Visual cost is not stored as an estimate. Preserve its real usage and
    // don't pretend the run estimate covers every paid stage.
    visualUsage: qa.map((r) => object(object(r.visionReport).usage)),
    runs: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      promptVersion: r.promptVersion,
      queueMs: duration(r.createdAt, r.startedAt),
      wallMs: duration(r.startedAt, r.finishedAt),
      error: r.errorCode,
      usage: r.usage,
    })),
    captures: timing,
    qa: qa.map((r) => ({
      id: r.id,
      phase: object(r.browserReport).phase ?? "final",
      status: r.status,
      iteration: r.qaIteration,
      buildId: object(r.browserReport).buildId ?? null,
      wallMs: duration(r.startedAt, r.finishedAt),
      timing: object(r.browserReport).timing ?? null,
      reusedRoutes: object(r.browserReport).reusedRoutes ?? 0,
      error: r.errorCode,
      failedRequiredGates: array(object(r.browserReport).gates)
        .map(object)
        .filter((g) => g.required === true && g.status !== "pass")
        .map((g) => ({ id: g.id, findings: g.findings })),
      scores: object(r.visionReport).scores ?? null,
      provider: object(r.visionReport).provider ?? null,
      providerModel: object(r.visionReport).providerModel ?? null,
    })),
  };
}
