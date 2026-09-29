import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
import { withService, type Db } from "@/lib/db/client";
import { themeStudioMessages, themeStudioRuns } from "@/drizzle/schema";
import {
  addThemeStudioReference,
  queueThemeStudioGeneration,
  reviseThemeStudioVersion,
  selectMessageReferences,
  submitThemeStudioDetails,
} from "./repository";

const projectId = "11111111-1111-4111-8111-111111111111";
const imageId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const actor = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "op@test.dev",
};
const input = {
  projectId,
  expectedRevision: 4,
  body: "Fix this screenshot",
  referenceAssetIds: [imageId],
  idempotencyKey: "message-reference-test",
};

function database(results: unknown[][]) {
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const predicates: SQL[] = [];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      for: () => query,
      limit: () => query,
      orderBy: () => query,
      where: (predicate: SQL) => {
        predicates.push(predicate);
        return query;
      },
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  });
  const db = {
    select,
    execute: vi.fn(async () => []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return {
          returning: async () => [
            { id: table === themeStudioMessages ? "message-id" : "run-id" },
          ],
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as Db;
  vi.mocked(withService).mockImplementation(async (work) => work(db));
  return { db, writes, predicates, select };
}
afterEach(() => vi.unstubAllEnvs());

describe("message screenshot snapshots", () => {
  it("preserves screenshot numbering when an older screenshot is attached after a newer one", async () => {
    const { db } = database([
      [
        { id: versionId, originalByteSize: 100 },
        { id: imageId, originalByteSize: 100 },
      ],
    ]);
    expect(
      (await selectMessageReferences(db, projectId, [imageId, versionId])).map(
        (ref) => ref.id,
      ),
    ).toEqual([imageId, versionId]);
  });
  it("selects only project-owned reference assets and binds the selected id", async () => {
    const { db, predicates } = database([
      [{ id: imageId, originalByteSize: 100 }],
    ]);
    expect(await selectMessageReferences(db, projectId, [imageId])).toEqual([
      { id: imageId, originalByteSize: 100 },
    ]);
    const query = new PgDialect().sqlToQuery(predicates[0]);
    expect(query.params).toEqual([projectId, "reference", imageId]);
    expect(query.sql).toContain('"project_id"');
    expect(query.sql).toContain('"purpose"');
  });

  it("does not implicitly resend history when a message has no attachments", async () => {
    const { db, select } = database([]);
    expect(await selectMessageReferences(db, projectId, [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it.each(
    [
      [imageId, imageId],
      ["not-a-uuid"],
      "forged",
      Array(11).fill(imageId),
      null,
    ].map((selection) => ({ selection })),
  )("refuses invalid attachment selections %j", async ({ selection }) => {
    const { db, select } = database([]);
    await expect(
      selectMessageReferences(db, projectId, selection),
    ).rejects.toThrow(/10 distinct/);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects missing, foreign-project, or non-reference assets before creating a run", async () => {
    const { db } = database([[]]);
    await expect(
      selectMessageReferences(db, projectId, [imageId]),
    ).rejects.toThrow(/unavailable or belongs/);
  });

  it("retains the per-message byte cap despite a larger history allowance", async () => {
    const { db } = database([
      [{ id: imageId, originalByteSize: 41 * 1024 * 1024 }],
    ]);
    await expect(
      selectMessageReferences(db, projectId, [imageId]),
    ).rejects.toThrow(/40 MB/);
  });

  it.each(["draft", "ready", "blocked"])(
    "persists explicit attachments on a %s message",
    async (status) => {
      vi.stubEnv("THEME_STUDIO_PROVIDER", "fake");
      vi.stubEnv("THEME_STUDIO_GENERATION_ENABLED", "true");
      const results = [
        [
          {
            id: projectId,
            status,
            revision: 4,
            modelKey: "gemini-3.8-flash",
            draftBrief: "Original",
            currentVersionId: versionId,
          },
        ],
        [],
      ];
      const extra: unknown[][] =
        status === "ready"
          ? [[{ id: versionId, packageDigest: "digest" }]]
          : status === "blocked"
            ? [
                [
                  {
                    kind: "revise",
                    baseVersionId: versionId,
                    basePackageDigest: "digest",
                    contextMessageIds: ["previous-message"],
                  },
                ],
              ]
            : [];
      const { writes } = database([
        ...results,
        ...extra,
        [{ n: 0 }],
        [{ id: imageId, originalByteSize: 100 }],
      ]);
      if (status === "draft") await queueThemeStudioGeneration(actor, input);
      else if (status === "blocked")
        await submitThemeStudioDetails(actor, input);
      else
        await reviseThemeStudioVersion(actor, {
          ...input,
          versionId,
          expectedPackageDigest: "digest",
        });
      expect(
        writes.find((write) => write.table === themeStudioMessages)?.values,
      ).toMatchObject({ body: input.body, referenceAssetIds: [imageId] });
      const run = writes.find(
        (write) => write.table === themeStudioRuns,
      )?.values;
      expect(run).toMatchObject({
        kind: status === "draft" ? "generate" : "revise",
      });
      if (status === "blocked")
        expect(run).toMatchObject({
          baseVersionId: versionId,
          contextMessageIds: ["previous-message", "message-id"],
        });
    },
  );

  it.each(["ready", "candidate", "approved"])(
    "allows another screenshot after ten historical images in %s",
    async (status) => {
      const { writes } = database([
        [{ id: projectId, status }],
        [],
        [{ n: 10, bytes: 40 * 1024 * 1024 }],
      ]);
      await addThemeStudioReference(actor, projectId, {
        bytes: Buffer.from("sanitized"),
        width: 100,
        height: 100,
        mediaType: "image/webp",
        originalMediaType: "image/png",
        originalByteSize: 100,
        sha256: "a".repeat(64),
      });
      expect(writes.length).toBeGreaterThan(0);
    },
  );
});
