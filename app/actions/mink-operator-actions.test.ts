import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  viewer: vi.fn(),
  service: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  conflict: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/app/actions/platform", () => ({ getPlatformViewer: h.viewer }));
vi.mock("@/lib/db/client", () => ({ withService: h.service }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
import { setMinkBetaAccess } from "./mink-operator-actions";
import { MINK_ACTION_TOOLS } from "@/lib/mink/product-action-types";
import { minkActionToolAccess, minkStoreAccess } from "@/drizzle/schema";
const storeId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.resetAllMocks();
  h.viewer.mockResolvedValue({
    role: "superadmin",
    email: "operator@example.test",
  });
  h.limit.mockResolvedValue([{ id: storeId }]);
  h.insert.mockReturnValue({ values: h.values });
  h.values.mockReturnValue({ onConflictDoUpdate: h.conflict });
  h.update.mockReturnValue({ set: h.set });
  h.set.mockReturnValue({ where: h.where });
  h.service.mockImplementation((fn) =>
    fn({
      select: () => ({ from: () => ({ where: () => ({ limit: h.limit }) }) }),
      insert: h.insert,
      update: h.update,
    }),
  );
});
describe("single Mink AI operator switch", () => {
  it("enables the parent, drafting and every registered action in one transaction", async () => {
    expect(await setMinkBetaAccess(storeId, true)).toEqual({ success: true });
    expect(h.service).toHaveBeenCalledOnce();
    expect(h.insert.mock.calls.map((c) => c[0])).toEqual([
      minkStoreAccess,
      minkActionToolAccess,
    ]);
    expect(h.values.mock.calls[0][0]).toMatchObject({
      storeId,
      enabled: true,
      draftingEnabled: true,
    });
    const children = h.values.mock.calls[1][0];
    expect(children.map((row: { toolName: string }) => row.toolName)).toEqual([
      ...MINK_ACTION_TOOLS,
    ]);
    expect(
      children.every(
        (row: { enabled: boolean; storeId: string }) =>
          row.enabled && row.storeId === storeId,
      ),
    ).toBe(true);
  });
  it("disables drafting and all child gates after the parent", async () => {
    expect(await setMinkBetaAccess(storeId, false)).toEqual({ success: true });
    expect(h.values.mock.calls[0][0]).toMatchObject({
      enabled: false,
      draftingEnabled: false,
    });
    expect(h.update).toHaveBeenCalledWith(minkActionToolAccess);
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, enabledBy: null }),
    );
    expect(h.conflict.mock.invocationCallOrder[0]).toBeLessThan(
      h.update.mock.invocationCallOrder[0],
    );
  });
  it("rejects staff and untrusted inputs without database access", async () => {
    h.viewer.mockResolvedValueOnce({ role: "operator" });
    expect((await setMinkBetaAccess(storeId, true)).error).toMatch(
      /superadmin/,
    );
    expect((await setMinkBetaAccess("other;drop table", true)).error).toMatch(
      /Invalid/,
    );
    expect(
      (await setMinkBetaAccess(storeId, "true" as unknown as boolean)).error,
    ).toMatch(/Invalid/);
    expect(h.service).not.toHaveBeenCalled();
  });
  it("does not create access for a missing store", async () => {
    h.limit.mockResolvedValue([]);
    expect(await setMinkBetaAccess(storeId, true)).toEqual({
      error: "Store not found.",
    });
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("propagates child failures through the transaction and reports no success", async () => {
    h.conflict
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("constraint failed"));
    const result = await setMinkBetaAccess(storeId, true);
    expect(result.error).toMatch(/Could not change/);
    expect(result.success).toBeUndefined();
    expect(h.service.mock.results[0].value).rejects.toThrow(
      "constraint failed",
    );
  });
});
