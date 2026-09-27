import { canonicalJson, type ThemePackageV2 } from "./contracts";

// ---------------------------------------------------------------------------
// Compare two Theme Studio versions.
//
// Pure, so the compare screen and its tests share one answer. It reports what
// an operator reviewing a revision needs to see first — which tokens moved,
// which pages gained, lost or changed sections, what happened to navigation
// and the sample catalogue, and which capability gaps appeared or cleared —
// rather than a JSON diff of two two-hundred-kilobyte packages.
//
// ★ Page and product identity is the slug, because that is what a storefront
// URL is built from. Section identity inside a page is its position and type:
// section ids are regenerated on every materialization, so comparing them would
// report every section of every page as changed.
// ---------------------------------------------------------------------------

export interface TokenChange {
  group: "palette" | "fonts" | "shape" | "layout" | "brand";
  key: string;
  before: string | null;
  after: string | null;
}

export interface PageChange {
  slug: string;
  title: string;
  change: "added" | "removed" | "changed";
  before: string[];
  after: string[];
}

export interface ThemeDiff {
  identical: boolean;
  tokens: TokenChange[];
  pages: PageChange[];
  navigationChanged: boolean;
  products: { added: string[]; removed: string[]; changed: string[] };
  categories: { added: string[]; removed: string[]; changed: string[] };
  gaps: { added: string[]; removed: string[] };
}

function display(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : canonicalJson(value);
}

function tokenChanges(
  group: TokenChange["group"],
  before: unknown,
  after: unknown,
): TokenChange[] {
  const a = (before && typeof before === "object" ? before : {}) as Record<
    string,
    unknown
  >;
  const b = (after && typeof after === "object" ? after : {}) as Record<
    string,
    unknown
  >;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) => {
    const x = display(a[key]);
    const y = display(b[key]);
    return x === y ? [] : [{ group, key, before: x, after: y }];
  });
}

/** Keyed collection diff on `slug`, comparing whole entries canonically. */
function collection<T extends { slug: string; name?: string }>(
  before: readonly T[],
  after: readonly T[],
): { added: string[]; removed: string[]; changed: string[] } {
  const a = new Map(before.map((item) => [item.slug, item]));
  const b = new Map(after.map((item) => [item.slug, item]));
  const label = (item: T) => item.name ?? item.slug;
  return {
    added: [...b.values()].filter((i) => !a.has(i.slug)).map(label),
    removed: [...a.values()].filter((i) => !b.has(i.slug)).map(label),
    changed: [...b.values()]
      .filter(
        (i) =>
          a.has(i.slug) && canonicalJson(a.get(i.slug)) !== canonicalJson(i),
      )
      .map(label),
  };
}

function withoutIds(sections: readonly { type: string; config?: unknown }[]) {
  return sections.map((s) => ({ type: s.type, config: s.config ?? null }));
}

export function diffThemePackages(
  before: ThemePackageV2,
  after: ThemePackageV2,
): ThemeDiff {
  const pa = before.definition.preset;
  const pb = after.definition.preset;

  const tokens = [
    ...tokenChanges("palette", pa.design?.palette, pb.design?.palette),
    ...tokenChanges("fonts", pa.design?.fonts, pb.design?.fonts),
    ...tokenChanges("shape", pa.design?.shape, pb.design?.shape),
    ...tokenChanges("layout", pa.design?.layout, pb.design?.layout),
    ...tokenChanges("brand", pa.brand, pb.brand),
  ];

  const pagesA = new Map(pa.pages.map((p) => [p.slug, p]));
  const pagesB = new Map(pb.pages.map((p) => [p.slug, p]));
  const pages: PageChange[] = [];
  for (const page of pb.pages) {
    const old = pagesA.get(page.slug);
    const afterLines = page.sections.map((s) => s.type);
    if (!old) {
      pages.push({
        slug: page.slug,
        title: page.title,
        change: "added",
        before: [],
        after: afterLines,
      });
    } else if (
      old.title !== page.title ||
      canonicalJson(withoutIds(old.sections)) !==
        canonicalJson(withoutIds(page.sections))
    ) {
      pages.push({
        slug: page.slug,
        title: page.title,
        change: "changed",
        before: old.sections.map((s) => s.type),
        after: afterLines,
      });
    }
  }
  for (const page of pa.pages) {
    if (!pagesB.has(page.slug)) {
      pages.push({
        slug: page.slug,
        title: page.title,
        change: "removed",
        before: page.sections.map((s) => s.type),
        after: [],
      });
    }
  }

  const navigationChanged = canonicalJson(pa.menus) !== canonicalJson(pb.menus);
  const products = collection(
    pa.sampleData?.products ?? [],
    pb.sampleData?.products ?? [],
  );
  const categories = collection(
    pa.sampleData?.categories ?? [],
    pb.sampleData?.categories ?? [],
  );
  const gapKey = (g: { code: string; requestedCapability: string }) =>
    `${g.code}: ${g.requestedCapability}`;
  const gapsA = new Set(before.capabilityGaps.map(gapKey));
  const gapsB = new Set(after.capabilityGaps.map(gapKey));
  const gaps = {
    added: [...gapsB].filter((g) => !gapsA.has(g)),
    removed: [...gapsA].filter((g) => !gapsB.has(g)),
  };

  const identical =
    tokens.length === 0 &&
    pages.length === 0 &&
    !navigationChanged &&
    products.added.length +
      products.removed.length +
      products.changed.length ===
      0 &&
    categories.added.length +
      categories.removed.length +
      categories.changed.length ===
      0 &&
    gaps.added.length + gaps.removed.length === 0;

  return {
    identical,
    tokens,
    pages,
    navigationChanged,
    products,
    categories,
    gaps,
  };
}
