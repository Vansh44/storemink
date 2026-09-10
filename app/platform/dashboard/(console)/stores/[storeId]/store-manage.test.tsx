import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const h = vi.hoisted(() => ({ toggle: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/actions/mink-operator-actions", () => ({
  setMinkBetaAccess: h.toggle,
}));
vi.mock("@/app/actions/platform", () => ({
  deleteStore: vi.fn(),
  grantAiCredits: vi.fn(),
  setStorePlan: vi.fn(),
  setStoreStatus: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { StoreManageBar } from "./store-manage";
const props = {
  storeId: "11111111-1111-4111-8111-111111111111",
  slug: "echos",
  name: "Echos",
  status: "active",
  plan: "pro" as const,
  canManage: true,
  minkBetaEnabled: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  h.toggle.mockResolvedValue({ success: true });
});
afterEach(cleanup);
it("renders one Mink AI switch and enables all capabilities through one call", async () => {
  render(<StoreManageBar {...props} />);
  expect(screen.getAllByRole("button", { name: /Mink/i })).toHaveLength(1);
  expect(
    screen.queryByRole("button", {
      name: /draft|description|inventory|publication/i,
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enable Mink AI" }));
  await waitFor(() =>
    expect(h.toggle).toHaveBeenCalledWith(props.storeId, true),
  );
  expect(h.toggle).toHaveBeenCalledOnce();
  await waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
});
it("disables the same master switch without granular controls", async () => {
  render(<StoreManageBar {...props} minkBetaEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Disable Mink AI" }));
  await waitFor(() =>
    expect(h.toggle).toHaveBeenCalledWith(props.storeId, false),
  );
});
it("does not expose management controls to a read-only operator", () => {
  render(<StoreManageBar {...props} canManage={false} />);
  expect(screen.queryByRole("button")).toBeNull();
});
