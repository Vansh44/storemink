import { expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("./acceptance-http", () => ({
  fetchInternalPageWithRetry: vi.fn(async () => ({
    status: 200,
    body: '<main class="storefront-root sm-themed-type">Shop</main>',
    headers: { "x-robots-tag": "noindex" },
    error: null,
  })),
}));
import { renderedPreviewGates } from "./acceptance";
import { fetchInternalPageWithRetry } from "./acceptance-http";

it("re-evaluates reused server HTML and still fetches unmeasured navigation links", async () => {
  const html =
    '<main class="storefront-root sm-themed-type"><a href="/collections/bags">Bags</a><img src="https://foreign.example/a.png"></main>';
  const gates = await renderedPreviewGates({
    origin: "http://preview.localhost:3000",
    pages: [{ surface: "home", path: "/", label: "Home" }],
    cookies: {},
    capturedRoutes: [
      { surface: "home", path: "/", status: 200, html, robots: "noindex" },
    ],
  });
  expect(fetchInternalPageWithRetry).toHaveBeenCalledTimes(1);
  expect(fetchInternalPageWithRetry).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/collections/bags" }),
  );
  expect(gates.find((g) => g.id === "routes.markup")?.status).toBe("fail");
  expect(gates.flatMap((g) => g.findings).map((f) => f.code)).toContain(
    "external_resource",
  );
  expect(gates.flatMap((g) => g.findings).map((f) => f.code)).toContain(
    "img_alt",
  );
});
