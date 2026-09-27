// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push }),
}));

import {
  forgetPredictiveSearches,
  PredictiveSearch,
} from "./predictive-search";
import { PhoneSearch } from "./phone-search";
import type { PredictiveResponse } from "@/lib/storefront/product-search";

const answer = (query: string, over: Partial<PredictiveResponse> = {}) => ({
  query,
  total: 2,
  products: [
    {
      name: "Linen shirt",
      href: "/shop/linen-shirt",
      imageUrl: "/a.webp",
      price: 1200,
      compareAt: 1500,
      category: "Shirts",
    },
    {
      name: "Shirt dress",
      href: "/shop/shirt-dress",
      imageUrl: null,
      price: 900,
      compareAt: null,
      category: null,
    },
  ],
  categories: [{ name: "Shirts", href: "/shop?category=shirts" }],
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  forgetPredictiveSearches();
  push.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    const q = new URL(url, "https://shop.example").searchParams.get("q")!;
    return new Response(JSON.stringify(answer(q)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const box = () => screen.getByRole("combobox", { name: "Search products" });

async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe("PredictiveSearch", () => {
  it("suggests products, categories and a search-all row", async () => {
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("shirt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(box()).toHaveAttribute("aria-expanded", "true");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Linen shirt"),
      expect.stringContaining("Shirt dress"),
      "Shirts",
      "Search for “shirt”",
    ]);
    expect(options[0].textContent).toContain("₹1,200");
    expect(options[0].querySelector("s")?.textContent).toContain("₹1,500");
  });

  it("asks nothing below two characters", async () => {
    render(<PredictiveSearch />);
    await type("s");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute("aria-expanded", "false");
  });

  it("debounces a burst of keystrokes into one request", async () => {
    render(<PredictiveSearch />);
    fireEvent.change(box(), { target: { value: "sh" } });
    fireEvent.change(box(), { target: { value: "shi" } });
    fireEvent.change(box(), { target: { value: "shir" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=shir");
  });

  it("never shows an answer for a query the shopper typed past", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("ca"); // in flight, never answered before the next keystroke
    await type("cand");
    await act(async () => {
      release(new Response(JSON.stringify(answer("ca")), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const all = screen.getAllByRole("option").at(-1)!;
    expect(all.textContent).toContain("cand");
  });

  it("hides the previous query's suggestions while the next one loads", async () => {
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("shirt");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    await type("shirtz"); // answer never arrives
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(box()).toHaveAttribute("aria-expanded", "false");
  });

  it("moves through suggestions with the arrows and opens one with Enter", async () => {
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("shirt");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    const second = screen.getAllByRole("option")[1];
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(box()).toHaveAttribute("aria-activedescendant", second.id);
    fireEvent.submit(box().closest("form")!);
    expect(push).toHaveBeenCalledWith("/shop/shirt-dress");
  });

  it("searches the grid with Enter when nothing is highlighted", async () => {
    const onNavigate = vi.fn();
    render(<PredictiveSearch onNavigate={onNavigate} />);
    await type("linen tee");
    fireEvent.submit(box().closest("form")!);
    expect(push).toHaveBeenCalledWith("/shop?q=linen%20tee");
    expect(onNavigate).toHaveBeenCalled();
  });

  it("an empty submit goes to the shop", () => {
    render(<PredictiveSearch />);
    fireEvent.submit(box().closest("form")!);
    expect(push).toHaveBeenCalledWith("/shop");
  });

  it("Escape closes the list, then clears the box", async () => {
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("shirt");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveAttribute("aria-expanded", "false");
    expect(box()).toHaveValue("shirt");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveValue("");
  });

  it("says so when nothing matches, and still offers the search", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            answer("zz", { products: [], categories: [], total: 0 }),
          ),
          { status: 200 },
        ),
    );
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("zz");
    expect(
      screen.getByText("No products match “zz”.", { selector: "li" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("names how many more results the grid holds", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(answer("shirt", { total: 14 })), {
          status: 200,
        }),
    );
    render(<PredictiveSearch />);
    fireEvent.focus(box());
    await type("shirt");
    expect(screen.getAllByRole("option").at(-1)!.textContent).toBe(
      "See all 14 results for “shirt”",
    );
  });
});

describe("PhoneSearch", () => {
  it("opens a search sheet, and Escape closes it and returns focus", async () => {
    render(
      <div className="storefront-root">
        <PhoneSearch />
      </div>,
    );
    const open = screen.getByRole("button", { name: "Search" });
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Search the store" });
    expect(dialog.closest(".storefront-root")).not.toBeNull();
    expect(document.activeElement).toBe(box());
    // With text in the box, Escape clears it and the sheet stays open.
    fireEvent.change(box(), { target: { value: "sh" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveValue("");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // Empty, it closes the sheet.
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("closes once a suggestion or search navigates", async () => {
    render(<PhoneSearch />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await type("shirt");
    fireEvent.submit(box().closest("form")!);
    expect(push).toHaveBeenCalledWith("/shop?q=shirt");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
