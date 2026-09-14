// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductEditorForm } from "./product-editor-form";
import type { Product } from "./page";

vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: () => <div data-testid="image-upload" />,
}));
vi.mock("@/lib/storage/uploads", () => ({ uploadImage: vi.fn() }));
vi.mock("@/app/actions/product-actions", () => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  generateProductDescription: vi.fn(),
  generateProductSeo: vi.fn(),
}));

const product: Product = {
  id: "product-1",
  name: "Coffee beans",
  slug: "coffee-beans",
  description: "Freshly roasted coffee",
  category_id: "category-1",
  base_price: 500,
  selling_price: 450,
  cost_price: null,
  image_url: null,
  images: [],
  status: "published",
  featured: false,
  sort_order: 0,
  card_color: null,
  seo_title: "Coffee beans",
  seo_description: "Freshly roasted coffee beans",
  published_at: "2026-08-01T00:00:00.000Z",
  track_inventory: true,
  stock: 7,
  low_stock_threshold: 3,
  allow_backorder: false,
  sku: "SKU-1",
  barcode: null,
  tax_class_id: null,
  hsn_code: null,
  returnable: true,
  return_window_days: null,
  requires_shipping: true,
  weight_grams: null,
  length_cm: null,
  width_cm: null,
  height_cm: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  category: {
    id: "category-1",
    name: "Coffee",
    slug: "coffee",
  },
  variants: [
    {
      id: "variant-1",
      product_id: "product-1",
      name: "500 g",
      base_price: 500,
      selling_price: 450,
      cost_price: null,
      special_price: null,
      stock: 7,
      sku: "SKU-1-V1",
      barcode: null,
      requires_shipping: true,
      weight_grams: null,
      length_cm: null,
      width_cm: null,
      height_cm: null,
      image_url: null,
      images: [],
      sort_order: 0,
      created_at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

describe("ProductEditorForm inventory flow", () => {
  it("uses a dedicated stock handoff and keeps existing variant totals read-only", () => {
    render(
      <ProductEditorForm
        product={product}
        categories={[
          {
            id: "category-1",
            name: "Coffee",
            slug: "coffee",
            status: "active",
          },
        ]}
        colors={[]}
        taxClasses={[]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inventory" }));
    expect(screen.getByText("7 units")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage stock by location" }),
    ).toHaveAttribute("href", "/dashboard/inventory?q=Coffee%20beans");

    fireEvent.click(screen.getByRole("button", { name: "Variants" }));
    expect(
      screen.getByText(/Existing stock is shown as a store-wide total/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Opening stock/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(
      screen.getByLabelText("Opening stock for variant 2"),
    ).toBeInTheDocument();
  });
});
