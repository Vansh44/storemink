// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryManagementView } from "./inventory-management-view";
import type { SkuRow } from "@/app/actions/inventory-actions";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/dashboard/inventory",
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/actions/inventory-actions", async () => {
  const actual = await vi.importActual("@/app/actions/inventory-actions");
  return {
    ...actual,
    bulkAdjust: vi.fn(),
    setStock: vi.fn(),
  };
});
vi.mock("@/app/dashboard/components/import-export-menu", () => ({
  ImportExportMenu: () => null,
}));
vi.mock("@/app/dashboard/components/list-pagination", () => ({
  ListPagination: () => null,
}));
vi.mock("@/app/dashboard/components/bulk-actions", () => ({
  BulkActionBar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  RowCheckbox: () => <input type="checkbox" aria-label="row checkbox" />,
  SelectAllCheckbox: () => <input type="checkbox" aria-label="select all" />,
}));
vi.mock("./inventory-edit-drawer", () => ({
  InventoryEditDrawer: ({ locationName }: { locationName: string }) => (
    <div data-testid="stock-drawer">Editing {locationName}</div>
  ),
}));
vi.mock("./inventory-history-drawer", () => ({
  InventoryHistoryDrawer: () => <div data-testid="history-drawer" />,
}));

const row: SkuRow = {
  id: "p-product-1",
  productId: "product-1",
  variantId: null,
  name: "Coffee beans",
  variantName: null,
  sku: "SKU-1",
  stock: 12,
  trackInventory: true,
  lowStockThreshold: 5,
  allowBackorder: false,
  status: "in",
  category: "Coffee",
  image: null,
};

const baseProps = {
  rows: [row],
  total: 1,
  categories: [],
  canManage: true,
  page: 1,
  pageSize: 50,
  query: "",
  filter: "all" as const,
  categoryFilter: "all",
  storeLowStockThreshold: 5,
  locations: [
    { id: "loc-delhi", name: "Delhi Shop" },
    { id: "loc-mumbai", name: "Mumbai Warehouse" },
  ],
  canViewAggregate: true,
};

describe("InventoryManagementView location flow", () => {
  beforeEach(() => push.mockClear());

  it("keeps all-location totals visibly read-only", () => {
    render(<InventoryManagementView {...baseProps} locationId={null} />);

    expect(screen.getByText("All locations")).toBeInTheDocument();
    expect(
      screen.getByText(/these are totals across all locations/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("row", { name: /Coffee beans/i }));
    expect(screen.queryByTestId("stock-drawer")).not.toBeInTheDocument();
  });

  it("names the selected shelf and opens its editor", () => {
    render(<InventoryManagementView {...baseProps} locationId="loc-delhi" />);

    expect(screen.getByText("Stock at Delhi Shop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("row", { name: /Coffee beans/i }));
    expect(screen.getByTestId("stock-drawer")).toHaveTextContent(
      "Editing Delhi Shop",
    );
  });

  it("keeps the all-locations choice explicit in the URL", () => {
    render(<InventoryManagementView {...baseProps} locationId="loc-delhi" />);

    fireEvent.change(screen.getByLabelText("Stock location"), {
      target: { value: "all" },
    });
    expect(push).toHaveBeenCalledWith("/dashboard/inventory?location=all");
  });
});
