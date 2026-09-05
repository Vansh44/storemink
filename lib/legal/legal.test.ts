/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The rules that make a consent record worth anything:
//   - a published version can only be superseded, never rewritten
//   - retire-then-insert, in that order, or the unique index rejects it
//   - the registry and the content agree on which policies exist
// ---------------------------------------------------------------------------

const calls: string[] = [];

/** Rows the next select() resolves to — i.e. what is currently published. */
let selectRows: unknown[] = [];
/** Set to throw from the next insert(), to exercise the failure path. */
let insertThrows = false;

/**
 * A drizzle-shaped chain that is also a promise, so from/where/limit/orderBy
 * can be called in any combination and awaited at the end.
 */
function chain(rows: unknown[]): any {
  const node: any = Promise.resolve(rows);
  for (const method of ["from", "where", "limit", "orderBy"]) {
    node[method] = () => chain(rows);
  }
  return node;
}

/** 1-indexed select() call that should blow up, to simulate a DB outage. */
let selectThrowsOnCall: number | null = null;
let selectCallCount = 0;

const db = {
  select: vi.fn(() => {
    selectCallCount++;
    if (selectThrowsOnCall === selectCallCount) {
      throw new Error("connection terminated");
    }
    return chain(selectRows);
  }),
  update: vi.fn(() => {
    calls.push("update");
    return { set: () => ({ where: () => Promise.resolve([]) }) };
  }),
  insert: vi.fn(() => {
    calls.push("insert");
    if (insertThrows) throw new Error("connection reset");
    return { values: () => Promise.resolve([]) };
  }),
};

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(db))),
  withUser: vi.fn((_i: any, fn: any) => Promise.resolve(fn(db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(db))),
}));

// Mirrors the real thing: unstable_cache THROWS when there is no render scope
// (a server action, a route handler, a script) rather than degrading.
let cacheHasRenderScope = true;
vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => async () => {
    if (!cacheHasRenderScope) {
      throw new Error("Invariant: incrementalCache missing in unstable_cache");
    }
    return fn();
  },
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Map()),
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { checksumBody, LEGAL_DOCS, signupRequiredDocs } from "./documents";
import { LEGAL_CONTENT } from "./content";
import * as store from "./store";

const CONTENT = {
  kind: "terms",
  title: "Terms of Service",
  version: 2,
  body: "<p>v2 body</p>",
};

function currentDoc(version: number) {
  return {
    id: "doc-1",
    kind: "terms",
    version,
    title: "Terms of Service",
    body: "<p>old</p>",
    checksum: "abc",
    effectiveAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  calls.length = 0;
  selectRows = [];
  insertThrows = false;
  selectThrowsOnCall = null;
  selectCallCount = 0;
  cacheHasRenderScope = true;
  vi.clearAllMocks();
});

describe("checksumBody", () => {
  it("is stable for the same text and differs for changed text", async () => {
    const a = await checksumBody("<p>hello</p>");
    const b = await checksumBody("<p>hello</p>");
    const c = await checksumBody("<p>hello.</p>");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it("ignores surrounding whitespace so reformatting isn't a text change", async () => {
    expect(await checksumBody("  <p>x</p>\n")).toBe(
      await checksumBody("<p>x</p>"),
    );
  });
});

describe("the registry and the content agree", () => {
  it("every document in the registry has content to publish", () => {
    for (const def of LEGAL_DOCS) {
      const content = LEGAL_CONTENT.find((c) => c.kind === def.kind);
      expect(content, `no content for "${def.kind}"`).toBeDefined();
      expect(content!.version).toBeGreaterThan(0);
      expect(content!.body.length).toBeGreaterThan(500);
    }
  });

  it("no content exists for a document the registry doesn't declare", () => {
    const kinds = new Set(LEGAL_DOCS.map((d) => d.kind));
    for (const content of LEGAL_CONTENT) {
      expect(kinds.has(content.kind as never), `orphan "${content.kind}"`).toBe(
        true,
      );
    }
  });

  // ★ A PLACEHOLDER THAT REACHES PRODUCTION IS A POLICY THAT SAYS NOTHING at
  // the exact moment someone relies on it — and these bodies are published
  // verbatim into an immutable table, so it cannot be edited out afterwards,
  // only superseded. Two clauses are deliberately unfinished (the contracting
  // entity and the governing-law seat); they keep real v1 wording rather than
  // a bracket for exactly this reason.
  it("no policy body contains an unfilled placeholder", () => {
    for (const content of LEGAL_CONTENT) {
      for (const pattern of [
        /\[[^\]]*\]/, // [ENTITY NAME]
        /\bTODO\b/i,
        /\bTBD\b/i,
        /\bXXX\b/,
        /\bFIXME\b/i,
        /\{\{/, // an unrendered template token
      ]) {
        expect(
          pattern.test(content.body),
          `"${content.kind}" body matches ${pattern}`,
        ).toBe(false);
      }
    }
  });

  // The version a reader SEES has to be the version they accepted. v1 carried
  // it as hand-written text in the body beside the number in this metadata, so
  // bumping one without the other would show the wrong version on a document
  // whose whole purpose is being pinned to a version.
  it("the version shown in each body matches the version published", () => {
    for (const content of LEGAL_CONTENT) {
      const shown = /Version\s+(\d+)/.exec(content.body);
      expect(shown, `"${content.kind}" body states no version`).not.toBeNull();
      expect(Number(shown![1]), `"${content.kind}" version mismatch`).toBe(
        content.version,
      );
    }
  });

  it("at least one document is required at signup", () => {
    // A signup checkbox that names nothing is not consent to anything.
    expect(signupRequiredDocs().length).toBeGreaterThan(0);
  });
});

describe("outstandingDocs — the re-acceptance gate's question", () => {
  it("returns nothing when no policy is published yet", async () => {
    // Before seeding there is nothing to agree to, so the gate must not fire.
    // Otherwise a fresh environment locks every merchant out of the dashboard.
    selectRows = [];
    expect(await store.outstandingDocs("user-1")).toEqual([]);
  });

  it("still answers when there is no render scope to cache in", async () => {
    // The gate runs in the dashboard LAYOUT (a render scope) and in the accept
    // SERVER ACTION (no render scope). unstable_cache throws in the second, so
    // reading through it unguarded left the accept button stuck on "Saving…"
    // with nothing shown. The cache is an optimisation, not an input.
    cacheHasRenderScope = false;
    selectRows = [currentDoc(1)];

    const docs = await store.getSignupDocsCached();

    expect(docs.map((d) => d.kind)).toEqual(["terms"]);
  });

  it("fails OPEN when the acceptance lookup errors", async () => {
    // A DB hiccup must never present as "you have not agreed to our terms" and
    // strand every merchant on a consent screen they cannot get past. Call 1
    // reads the documents; call 2 reads this user's acceptances.
    selectRows = [currentDoc(1)];
    selectThrowsOnCall = 2;

    expect(await store.outstandingDocs("user-1")).toEqual([]);
  });
});

describe("publishLegalVersion", () => {
  it("retires the old version BEFORE inserting the new one", async () => {
    // The partial unique index allows exactly one is_current row per kind, so
    // insert-then-retire would be rejected outright.
    selectRows = [currentDoc(1)];

    const result = await store.publishLegalVersion(CONTENT);

    expect(result.status).toBe("published");
    expect(calls).toEqual(["update", "insert"]);
  });

  it("inserts without retiring when nothing is published yet", async () => {
    selectRows = [];

    const result = await store.publishLegalVersion(CONTENT);

    expect(result.status).toBe("published");
    expect(result.fromVersion).toBeNull();
    expect(calls).toEqual(["insert"]);
  });

  it("refuses to republish the version that is already current", async () => {
    selectRows = [currentDoc(2)];

    const result = await store.publishLegalVersion(CONTENT);

    expect(result.status).toBe("unchanged");
    expect(calls).toEqual([]);
  });

  it("refuses to go backwards", async () => {
    // Publishing an older version would silently un-publish the newer text
    // that people have already been shown and accepted.
    selectRows = [currentDoc(5)];

    const result = await store.publishLegalVersion(CONTENT);

    expect(result.status).toBe("unchanged");
    expect(result.message).toMatch(/backwards/i);
    expect(calls).toEqual([]);
  });

  it("reports an error instead of throwing when the write fails", async () => {
    selectRows = [];
    insertThrows = true;

    const result = await store.publishLegalVersion(CONTENT);

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/connection reset/);
  });
});
