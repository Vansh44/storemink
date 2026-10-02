import { describe, expect, it } from "vitest";
import { operatorImagePackage } from "./_test-helpers";
import { applyTargetedRepair, repairTargets } from "./targeted-repair";

const edit = (path: string, value: unknown) => ({
  path,
  valueJson: JSON.stringify(value),
});
const cart = "/definition/preset/design/layout/cart";

describe("bounded automatic theme repair", () => {
  it("changes a native layout while preserving every asset, route and catalogue item", () => {
    const base = operatorImagePackage();
    const before = structuredClone(base);
    const result = applyTargetedRepair(base, {
      edits: [edit(cart, "compact")],
      unrepairable: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.definition.preset.design.layout?.cart).toBe(
      "compact",
    );
    expect(result.package.assets).toEqual(base.assets);
    expect(result.package.definition.preset.pages).toEqual(
      base.definition.preset.pages,
    );
    expect(result.package.definition.preset.sampleData).toEqual(
      base.definition.preset.sampleData,
    );
    expect(base).toEqual(before);
  });
  it.each([
    "/assets/0/path",
    "/definition/preset/pages/0/slug",
    "/definition/preset/pages/0/sections/0/config/image_url",
    "/definition/preset/sampleData/products/0/name",
    "/definition/preset/design/__proto__/polluted",
    "/definition/engine/version",
    "/capabilityGaps/0/blocking",
  ])("refuses writes to protected path %s", (path) => {
    expect(
      applyTargetedRepair(operatorImagePackage(), {
        edits: [edit(path, "malicious")],
        unrepairable: [],
      }).ok,
    ).toBe(false);
  });
  it("rejects invented settings, duplicate edits and object replacements", () => {
    const base = operatorImagePackage();
    for (const edits of [
      [edit(cart, "custom_css")],
      [edit(cart, "compact"), edit(cart, "classic")],
      [edit(cart, { css: "body{display:none}" })],
    ]) {
      expect(applyTargetedRepair(base, { edits, unrepairable: [] }).ok).toBe(
        false,
      );
    }
  });
  it("validates palette contrast and publish-mode section configuration", () => {
    const base = operatorImagePackage();
    expect(
      applyTargetedRepair(base, {
        edits: [
          edit("/definition/preset/design/palette/ink", "javascript:alert(1)"),
        ],
        unrepairable: [],
      }).ok,
    ).toBe(false);
    const target = repairTargets(base).find((t) =>
      t.path.endsWith("/config/heading"),
    )!;
    expect(
      applyTargetedRepair(base, {
        edits: [edit(target.path, "x".repeat(7000))],
        unrepairable: [],
      }).ok,
    ).toBe(false);
  });
  it("does not create a version for an unsupported renderer change or a no-op", () => {
    const base = operatorImagePackage();
    expect(
      applyTargetedRepair(base, {
        edits: [],
        unrepairable: ["Requires a shared renderer fix."],
      }),
    ).toMatchObject({
      ok: false,
      unrepairable: ["Requires a shared renderer fix."],
    });
    const target = repairTargets(base)[0];
    expect(
      applyTargetedRepair(base, {
        edits: [edit(target.path, target.current)],
        unrepairable: [],
      }).ok,
    ).toBe(false);
  });
  it("can set an optional design group while retaining supported choice metadata", () => {
    const base = operatorImagePackage();
    delete base.definition.preset.design.typography;
    const path = "/definition/preset/design/typography/headingScale";
    expect(repairTargets(base).find((t) => t.path === path)?.choices).toContain(
      "medium",
    );
    expect(
      applyTargetedRepair(base, {
        edits: [edit(path, "medium")],
        unrepairable: [],
      }).ok,
    ).toBe(true);
  });
  it("exposes native hero height choices and rejects silently normalised values", () => {
    const base = operatorImagePackage();
    const target = repairTargets(base).find(
      (t) => t.path.endsWith("/config/height") && t.choices?.includes("medium"),
    )!;
    expect(target).toBeTruthy();
    expect(target.choices).toContain("screen");
    expect(
      applyTargetedRepair(base, {
        edits: [edit(target.path, "md")],
        unrepairable: [],
      }).ok,
    ).toBe(false);
    const nested = repairTargets(base).find((t) =>
      t.path.endsWith("/config/alignment"),
    )!;
    expect(
      applyTargetedRepair(base, {
        edits: [edit(nested.path, "invented-alignment")],
        unrepairable: [],
      }),
    ).toMatchObject({ ok: false });
  });
});
