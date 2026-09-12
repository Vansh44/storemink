/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { saveMinkGeneratedImage } from "./mink-media-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { sqlText } from "./_test-helpers";

const STORE = "a0000000-0000-4000-8000-000000000001";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const CONTENT = {
  url: `https://storage.googleapis.com/sm-media/stores/${STORE}/mink-generated/img.jpg`,
  storage_path: `stores/${STORE}/mink-generated/img.jpg`,
  filename: "hero-1.jpg",
  content_type: "image/jpeg",
  size_bytes: "140322",
  purpose: "hero",
  prompt: "A warm overhead still life of loose grains on linen.",
  alt: "Grains and pulses on linen",
};

function dbWithDraft(overrides: Record<string, unknown> = {}) {
  return makeDbMock({
    selectByTable: {
      mink_drafts: [[{ kind: "media_image", content: CONTENT, ...overrides }]],
    },
    executeQueue: [[{ url: CONTENT.url }]],
  });
}

// mink-media-actions.ts — Phase 9E's "Save to Media Library" button. It writes
// `media_assets.url`, which 9D's ownership guard treats as proof an image
// belongs to the store, so everything about the row comes from the stored
// proposal rather than from the caller.
describe("saveMinkGeneratedImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = dbWithDraft();
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  });

  it("saves the stored image and refreshes the library", async () => {
    const result = await saveMinkGeneratedImage(DRAFT);
    expect(result.error).toBeUndefined();
    expect(result.url).toBe(CONTENT.url);
    expect(result.alt).toBe(CONTENT.alt);
    const insert = sqlText(dbHolder.current.calls.execute[0]);
    expect(insert).toMatch(/insert into media_assets/i);
    expect(insert).toMatch(/where not exists/i);
  });

  it("★ REQUIRES MEDIA MANAGE, NOT MERELY A DRAFT ID", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const result = await saveMinkGeneratedImage(DRAFT);
    expect(result.error).toMatch(/don't have access/);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★★ NEVER SAVES ANOTHER KIND OF DRAFT", async () => {
    // Every Mink draft shares one table and one id space, so without this a
    // design or layout proposal's id would reach `readStoredGeneratedImage`
    // holding fields that happen to parse.
    dbHolder.current = dbWithDraft({ kind: "storefront_design" });
    const result = await saveMinkGeneratedImage(DRAFT);
    expect(result.error).toMatch(/could not be found/);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("reports a draft this admin does not own as missing", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { mink_drafts: [[]] },
    });
    const result = await saveMinkGeneratedImage(DRAFT);
    expect(result.error).toMatch(/could not be found/);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★ SURFACES A STORAGE INTEGRITY FAILURE IN ITS OWN WORDS", async () => {
    // The url and the path are written together and checked against each
    // other. A generic "please try again" here would invite the merchant to
    // retry a row that can never pass.
    dbHolder.current = dbWithDraft({
      content: { ...CONTENT, url: "https://attacker.example/pixel.jpg" },
    });
    const result = await saveMinkGeneratedImage(DRAFT);
    expect(result.error).toMatch(/storage integrity check/);
  });

  it("refuses an id that is not a uuid before touching the database", async () => {
    const result = await saveMinkGeneratedImage("../../etc/passwd");
    expect(result.error).toMatch(/could not be found/);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });
});
