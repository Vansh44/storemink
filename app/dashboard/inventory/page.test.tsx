// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getInventory = vi.fn();

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/app/actions/inventory-actions", () => ({
  getInventory: (...args: unknown[]) => getInventory(...args),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async () => []),
}));
vi.mock("@/lib/pos/locations", () => ({
  getStoreLocations: vi.fn(async () => [
    { id: "loc-main", name: "Main Shop", isDefault: true },
    { id: "loc-warehouse", name: "Warehouse", isDefault: false },
  ]),
}));
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => null),
}));
vi.mock("./inventory-management-view", () => ({
  InventoryManagementView: ({ locationId }: { locationId: string | null }) => (
    <div>Selected {locationId ?? "all"}</div>
  ),
}));
vi.mock("../components/realtime-refresher", () => ({
  RealtimeRefresher: () => null,
}));

import InventoryPage from "./page";
import { getViewerLocations } from "@/lib/locations/scope";

describe("InventoryPage location default", () => {
  beforeEach(() => {
    getInventory.mockReset();
    vi.mocked(getViewerLocations).mockResolvedValue(null);
    getInventory.mockImplementation(async ({ locationId }) => ({
      rows: [],
      total: 0,
      lowStockThreshold: 5,
      locationId: locationId === "all" ? null : locationId,
    }));
  });

  it("opens a multi-location store on its default accessible shelf", async () => {
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));

    expect(getInventory).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "loc-main" }),
    );
    expect(screen.getByText("Selected loc-main")).toBeInTheDocument();
  });

  it("preserves an explicitly requested all-locations view", async () => {
    render(
      await InventoryPage({
        searchParams: Promise.resolve({ location: "all" }),
      }),
    );

    expect(getInventory).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "all" }),
    );
    expect(screen.getByText("Selected all")).toBeInTheDocument();
  });

  it("lands location-bound staff on their assigned shelf", async () => {
    vi.mocked(getViewerLocations).mockResolvedValue(["loc-warehouse"]);

    render(await InventoryPage({ searchParams: Promise.resolve({}) }));

    expect(getInventory).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "loc-warehouse" }),
    );
    expect(screen.getByText("Selected loc-warehouse")).toBeInTheDocument();
  });
});
