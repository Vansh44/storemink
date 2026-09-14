// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MinkAnswer } from "./mink-answer";

describe("MinkAnswer", () => {
  it("renders model emphasis without exposing Markdown markers", () => {
    const { container } = render(
      <MinkAnswer text="Your store (**echos**) is on the **Pro** plan." />,
    );

    expect(screen.getByText("echos").tagName).toBe("STRONG");
    expect(screen.getByText("Pro").tagName).toBe("STRONG");
    expect(container.textContent).toBe(
      "Your store (echos) is on the Pro plan.",
    );
    expect(container.textContent).not.toContain("**");
  });

  it("renders inline code as text without accepting raw HTML", () => {
    const { container } = render(
      <MinkAnswer text={'Find `<script>alert("x")</script>`'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain("<script>");
  });

  it("renders dashboard Markdown links and structured lists", () => {
    render(
      <MinkAnswer
        text={[
          "## Stock at Shop",
          "1. [Cobalt Lounge Chair](/dashboard/products/product-1) — **Bone**",
          "   - Stock: `0` · Out of stock",
          "2. Form No. 03 Art Print — A2",
        ].join("\n")}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Cobalt Lounge Chair" }),
    ).toHaveAttribute("href", "/dashboard/products/product-1");
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByText("Stock at Shop")).toHaveClass("font-semibold");
    expect(screen.getByText("0").tagName).toBe("CODE");
  });

  it("never turns arbitrary model URLs or raw HTML into active content", () => {
    const { container } = render(
      <MinkAnswer
        text={
          '[Sign in](https://evil.example/login) <img src=x onerror="alert(1)">'
        }
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img");
  });

  it("renders compact Markdown tables", () => {
    render(
      <MinkAnswer
        text={["| Status | Count |", "| --- | ---: |", "| Draft | 2 |"].join(
          "\n",
        )}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Draft" })).toBeVisible();
  });
});
