// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { connection, categories, counts, popular } = vi.hoisted(() => ({
  connection: vi.fn(),
  categories: vi.fn(),
  counts: vi.fn(),
  popular: vi.fn(),
}));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/lib/help/queries", () => ({
  getHelpCategories: categories,
  getHelpCategoryCounts: counts,
  getPopularHelpArticles: popular,
}));
vi.mock("./components/search-box", () => ({
  HelpSearchBox: () => <div>Search guides</div>,
}));
import HelpHome from "./page";
import HelpError from "./error";

beforeEach(() => {
  vi.clearAllMocks();
  connection.mockResolvedValue(undefined);
  categories.mockResolvedValue([
    {
      id: "start",
      slug: "getting-started",
      title: "Getting started",
      description: "Start here",
      icon: "rocket",
      position: 0,
    },
  ]);
  counts.mockResolvedValue({ start: 8 });
  popular.mockResolvedValue([]);
});

describe("Help Centre first visit", () => {
  it("waits for a request before any data read, then renders topics without a reload", async () => {
    let acceptRequest!: () => void;
    connection.mockReturnValue(
      new Promise<void>((resolve) => {
        acceptRequest = resolve;
      }),
    );
    const pending = HelpHome();
    expect(categories).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
    expect(popular).not.toHaveBeenCalled();
    acceptRequest();
    render(await pending);
    expect(
      screen.getByRole("link", { name: /Getting started/ }),
    ).toHaveAttribute("href", "/help/getting-started");
    expect(screen.getByText("8 articles")).toBeInTheDocument();
    expect(
      screen.queryByText(/Articles are on their way/),
    ).not.toBeInTheDocument();
  });

  it("propagates unavailable reads to the error boundary instead of rendering no articles", async () => {
    const error = new Error("database unavailable");
    categories.mockRejectedValue(error);
    await expect(HelpHome()).rejects.toBe(error);
  });

  it("offers a server re-fetch on failure without exposing the database error", () => {
    const retry = vi.fn();
    render(
      <HelpError
        error={new Error("private database connection details")}
        unstable_retry={retry}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Help Centre is temporarily unavailable",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
