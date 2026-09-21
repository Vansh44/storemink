import { describe, expect, it, vi } from "vitest";

// The ownership predicate resolves a URL through the real `gcsPathFromUrl`,
// so the bucket has to be deterministic here rather than read from a local
// .env that CI does not have.
vi.mock("@/lib/storage/gcs", () => ({
  GCS_PUBLIC_HOST: "storage.googleapis.com",
  gcsPathFromUrl: (url: string) => {
    const m = /storage\.googleapis\.com\/[^/]+\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
}));

const dbHolder = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn(async (_identity: unknown, fn: (db: unknown) => unknown) =>
    fn(dbHolder),
  ),
}));
vi.mock("@/lib/slug", () => ({ slugify: (v: string) => v.trim() }));

import { importCategories } from "./categories";
import type { ImportContext } from "./types";
import type { ParsedRecord } from "../types";

const STORE_ID = "a0000000-0000-4000-8000-000000000001";
const FOREIGN =
  "https://storage.googleapis.com/bkt/stores/b0000000-0000-4000-8000-0000000000ff/uploads/victim.webp";

function ctx(): ImportContext {
  return {
    storeId: STORE_ID,
    admin: { uid: "user-1", email: "admin@example.com" },
    options: { create: true, update: true },
  } as unknown as ImportContext;
}

function record(imageUrl: string): ParsedRecord {
  return {
    line: 2,
    values: { handle: "snacks", name: "Snacks", imageUrl },
    issues: [],
  } as unknown as ParsedRecord;
}

// ★★ A CSV IS A SUPPORTED WAY TO WRITE AN ARBITRARY URL: `coerceUrl` checks
//    only the scheme, so an Image URL column can name another store's object
//    in the shared bucket — and deleting or re-importing that row then sweeps
//    THEIR file.
describe("category import image ownership", () => {
  it("fails the row and names the column, without writing", async () => {
    const select = vi.fn(() => ({
      from: () => ({ where: () => [] }),
    }));
    const insert = vi.fn();
    Object.assign(dbHolder, { select, insert });

    const results = await importCategories(ctx(), [record(FOREIGN)]);

    expect(results[0]).toMatchObject({ outcome: "failed" });
    expect(results[0].issues.at(-1)).toMatchObject({
      code: "image_not_owned",
      column: "Image URL",
      severity: "error",
    });
    // Row-atomic: the refusal happens before any write.
    expect(insert).not.toHaveBeenCalled();
  });
});
