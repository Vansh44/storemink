import { describe, expect, it } from "vitest";
import { operatorImagePackage, placeholderPackage } from "./_test-helpers";
import { validateThemePackageV2 } from "./contracts";
import {
  approvalReadiness,
  buildPublishedPackage,
  nextReleaseVersion,
  publicationBlockers,
  releaseDate,
  validateCatalogChange,
  validateScorecard,
  type ReviewFacts,
  type Scores,
} from "./publication-core";

function scores(value: number, overrides: Partial<Scores> = {}): Scores {
  return {
    artDirection: value,
    distinctness: value,
    commerceClarity: value,
    typography: value,
    imagery: value,
    responsiveComposition: value,
    detailQuality: value,
    brandAdaptability: value,
    ...overrides,
  };
}

const card = (overrides: Record<string, unknown> = {}) => ({
  role: "design",
  scores: scores(5),
  rejections: [],
  verdict: "approve",
  notes: "",
  ...overrides,
});

describe("the scorecard", () => {
  it("accepts an approving review that clears the bar", () => {
    const parsed = validateScorecard(card());
    expect(parsed.ok && parsed.value.verdict).toBe("approve");
  });

  it("holds an approval to every row >= 4 and an average >= 4.2", () => {
    // 4,4,4,4,4,4,4,5 averages 4.125: every row passes, the average does not.
    const low = validateScorecard(
      card({ scores: scores(4, { brandAdaptability: 5 }) }),
    );
    expect(!low.ok && low.error).toMatch(/average of at least 4.2/);
    // 4,4,4,4,4,4,5,5 averages 4.25.
    expect(
      validateScorecard(
        card({ scores: scores(4, { detailQuality: 5, brandAdaptability: 5 }) }),
      ).ok,
    ).toBe(true);
    // A single 3 fails however high the rest are.
    const row = validateScorecard(card({ scores: scores(5, { imagery: 3 }) }));
    expect(row.ok).toBe(false);
  });

  it("makes approval impossible once a rejection condition is ticked", () => {
    const parsed = validateScorecard(card({ rejections: ["copied"] }));
    expect(!parsed.ok && parsed.error).toMatch(/cannot approve/);
  });

  it("requires a reason to reject, and accepts a rejection over high scores", () => {
    expect(validateScorecard(card({ verdict: "reject" })).ok).toBe(false);
    const parsed = validateScorecard(
      card({ verdict: "reject", notes: "The cart is unreadable on mobile." }),
    );
    expect(parsed.ok).toBe(true);
  });

  it.each([
    [{ role: "owner" }, /which review/],
    [{ scores: scores(5, { imagery: 6 }) }, /Imagery/],
    [{ scores: scores(5, { imagery: 4.5 }) }, /Imagery/],
    [{ rejections: ["nope"] }, /Unknown rejection/],
    [{ verdict: "maybe" }, /approve or reject/],
    [{ notes: "x".repeat(2001) }, /under 2000/],
  ])("refuses %j", (overrides, message) => {
    const parsed = validateScorecard(card(overrides));
    expect(!parsed.ok && parsed.error).toMatch(message);
  });

  it("deduplicates repeated rejection conditions", () => {
    const parsed = validateScorecard(
      card({
        verdict: "reject",
        notes: "Palette swap of Basket.",
        rejections: ["palette_only", "palette_only"],
      }),
    );
    expect(parsed.ok && parsed.value.rejections).toEqual(["palette_only"]);
  });
});

describe("approval readiness", () => {
  const review = (overrides: Partial<ReviewFacts>): ReviewFacts => ({
    role: "design",
    verdict: "approve",
    reviewerIsAuthor: false,
    reviewerEmail: "a@storemink.com",
    ...overrides,
  });

  it("is ready with both chairs approving and one independent reviewer", () => {
    expect(
      approvalReadiness([
        review({ reviewerIsAuthor: true }),
        review({ role: "commerce", reviewerEmail: "b@storemink.com" }),
      ]),
    ).toEqual({ ok: true });
  });

  it("needs both chairs", () => {
    const result = approvalReadiness([review({})]);
    expect(!result.ok && result.reasons).toEqual([
      "It needs an approving Commerce / QA review.",
    ]);
  });

  it("refuses when every approving reviewer authored the theme", () => {
    const result = approvalReadiness([
      review({ reviewerIsAuthor: true }),
      review({ role: "commerce", reviewerIsAuthor: true }),
    ]);
    expect(!result.ok && result.reasons.join(" ")).toMatch(
      /must not have authored/,
    );
  });

  it("refuses when any reviewer rejected", () => {
    const result = approvalReadiness([
      review({}),
      review({ role: "commerce", verdict: "reject" }),
    ]);
    expect(!result.ok && result.reasons[0]).toMatch(/rejected/);
  });
});

describe("release versions", () => {
  it.each([
    [[], "1.0.0"],
    [["1.0.0"], "1.1.0"],
    [["1.0.0", "1.4.2", "1.10.0"], "1.11.0"],
    [["0.3.0"], "1.0.0"],
    [["2.0.0", "1.9.0", "not-a-version"], "2.1.0"],
  ])("after %j comes %s", (existing, next) => {
    expect(nextReleaseVersion(existing)).toBe(next);
  });
});

describe("the published package", () => {
  const url = (path: string) =>
    `https://storage.googleapis.com/storemink-media/${path}`;

  it("refuses a version that still has placeholders", () => {
    const pkg = placeholderPackage();
    expect(publicationBlockers(pkg)[0]).toMatch(/placeholder/);
    const built = buildPublishedPackage(pkg, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(!built.ok && built.error).toMatch(/placeholder/);
  });

  it("points every slot at its immutable object and publishes the release", () => {
    const draft = operatorImagePackage();
    const built = buildPublishedPackage(draft, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { pkg, objects } = built.value;
    const id = draft.definition.id;
    expect(objects).toHaveLength(draft.assets.length);
    for (const object of objects) {
      expect(object.objectPath).toBe(
        `theme-releases/${id}/1.0.0/${object.assetId}-${object.sha256.slice(0, 16)}.webp`,
      );
    }
    expect(
      pkg.assets.every((a) => a.path.startsWith(url("theme-releases/"))),
    ).toBe(true);
    expect(JSON.stringify(pkg.definition)).not.toContain("theme-asset://");
    expect(pkg.definition.release).toEqual({
      version: "1.0.0",
      status: "published",
      releasedAt: "2026-09-25",
      notes: ["Published from Theme Studio version 3."],
    });
    expect(pkg.definition.catalog.visibility).toBe("public");
    expect(pkg.definition.demo).toEqual({
      slug: `demo-${id}`,
      status: "healthy",
    });
    // The draft is untouched.
    expect(draft.definition.release.status).not.toBe("published");
  });

  it("refuses a bad version or date", () => {
    const draft = operatorImagePackage();
    const base = {
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: url,
    };
    expect(buildPublishedPackage(draft, { ...base, version: "1.0" }).ok).toBe(
      false,
    );
    expect(
      buildPublishedPackage(draft, {
        ...base,
        version: "1.0.0",
        releasedAt: "25/09/2026",
      }).ok,
    ).toBe(false);
  });
});

describe("published image paths in the contract", () => {
  function published() {
    const built = buildPublishedPackage(operatorImagePackage(), {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: (p) => `https://storage.googleapis.com/bucket-x/${p}`,
    });
    if (!built.ok) throw new Error(built.error);
    return built.value.pkg;
  }

  it("accepts the release's own images", () => {
    expect(validateThemePackageV2(published()).ok).toBe(true);
  });

  it.each([
    [
      "another theme's image",
      (p: string) =>
        p.replace(/\/theme-releases\/[^/]+\//, "/theme-releases/other-theme/"),
    ],
    ["another release's image", (p: string) => p.replace("/1.0.0/", "/2.0.0/")],
    [
      "an image whose digest does not match",
      (p: string) =>
        p.replace(/-[a-f0-9]{16}\.webp$/, "-0000000000000000.webp"),
    ],
    [
      "an arbitrary URL",
      () => "https://evil.example.com/theme-releases/x.webp",
    ],
  ])("refuses %s", (_label, mutate) => {
    const pkg = published();
    const asset = pkg.assets[0];
    const moved = mutate(asset.path);
    const tampered = JSON.parse(
      JSON.stringify(pkg).split(asset.path).join(moved),
    );
    expect(validateThemePackageV2(tampered).ok).toBe(false);
  });
});

describe("catalog changes", () => {
  it("needs a reason", () => {
    expect(validateCatalogChange({ action: "hide", reason: "" }).ok).toBe(
      false,
    );
  });

  it("accepts hide, show and a release selection", () => {
    expect(
      validateCatalogChange({ action: "hide", reason: "Broken PDP" }).ok,
    ).toBe(true);
    expect(
      validateCatalogChange({
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      },
    });
    expect(
      validateCatalogChange({ action: "select_release", reason: "x".repeat(4) })
        .ok,
    ).toBe(false);
    expect(validateCatalogChange({ action: "delete", reason: "nope" }).ok).toBe(
      false,
    );
  });
});

describe("release dates", () => {
  it("dates a release in India time", () => {
    // 20:00 UTC on the 24th is 01:30 IST on the 25th.
    expect(releaseDate(new Date("2026-09-24T20:00:00Z"))).toBe("2026-09-25");
  });
});
