// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({ open: true, close: vi.fn() }));
vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    isAuthModalOpen: auth.open,
    closeAuthModal: auth.close,
  }),
}));
// The real modal pulls in Firebase; a marker is enough to tell them apart.
vi.mock("next/dynamic", () => ({
  default: () =>
    function AuthModalStub() {
      return <div>phone sign-in</div>;
    },
}));

import AuthModalLoader from "./auth-modal-loader";

describe("AuthModalLoader", () => {
  it("opens the ordinary sign-in on a real store", () => {
    render(<AuthModalLoader />);
    expect(screen.getByText("phone sign-in")).toBeTruthy();
  });

  it("explains instead of signing in on a theme demo store", () => {
    render(<AuthModalLoader demoStore />);
    expect(screen.queryByText("phone sign-in")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "This is a theme preview" }),
    ).toBeTruthy();
    screen.getByRole("button", { name: "Keep browsing" }).click();
    expect(auth.close).toHaveBeenCalled();
  });
});
