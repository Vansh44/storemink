// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// AuthProvider tracks the customer via Firebase onAuthStateChanged, reads the
// row via the getMyCustomerSession server action, re-mints a lapsed session
// cookie via establishSession, and tears down via endSession. Mock every seam
// so we can drive auth state without a real Firebase client.
vi.mock("firebase/auth", () => ({ onAuthStateChanged: vi.fn() }));
vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: vi.fn(() => ({ currentUser: currentFbUser })),
  endSession: vi.fn(async () => {}),
  establishSession: vi.fn(async () => null),
}));
vi.mock("@/app/actions/customer-profile", () => ({
  getMyCustomerSession: vi.fn(),
}));

import AuthProvider, { useAuth } from "./AuthProvider";
import { onAuthStateChanged } from "firebase/auth";
import { endSession, establishSession } from "@/lib/auth/firebase-client";
import { getMyCustomerSession } from "@/app/actions/customer-profile";

// ---------------------------------------------------------------------------
// Mock wiring. onAuthStateChanged stores the callback and fires it once with
// the current user (mimicking Firebase's initial resolve on mount); tests can
// re-fire it via `authCallback` to simulate later sign-in / sign-out.
// `currentFbUser` / `customerRow` are mutable so tests can flip them.
// ---------------------------------------------------------------------------

let currentFbUser: any;
let customerRow: any;
let authCallback: ((user: any) => void) | null;
const unsubscribe = vi.fn();

// A Firebase User carries uid / email / phoneNumber (AuthProvider maps these to
// id / email / phone for consumers).
const FB_USER = { uid: "u-1", email: "a@b.com", phoneNumber: "+15551234567" };
const CUSTOMER = {
  id: "u-1",
  phone: "+15551234567",
  email: "a@b.com",
  first_name: "Ada",
  last_name: "Lovelace",
  updated_at: "2026-01-01",
};

function Harness() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="user">{auth.user?.id ?? ""}</span>
      <span data-testid="customer">{auth.customer?.first_name ?? ""}</span>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="modal">{String(auth.isAuthModalOpen)}</span>
      <button onClick={() => auth.openAuthModal()}>open</button>
      <button onClick={() => auth.closeAuthModal()}>close</button>
      <button onClick={() => auth.signOut()}>signOut</button>
      <button onClick={() => auth.refreshCustomer()}>refresh</button>
    </div>
  );
}

function renderAuth(initialHasSession = true) {
  return render(
    <AuthProvider initialHasSession={initialHasSession}>
      <Harness />
    </AuthProvider>,
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentFbUser = null;
    customerRow = null;
    authCallback = null;
    // Default: a valid session. `customerRow = null` therefore means "no `users`
    // row" (a store admin on their own storefront), NOT a lapsed cookie — so the
    // self-heal path stays out of every test that isn't about it.
    vi.mocked(getMyCustomerSession).mockImplementation(async () =>
      customerRow
        ? { status: "ok", customer: customerRow }
        : { status: "no-row", customer: null },
    );
    // mockClear() keeps implementations, so per-test overrides would leak.
    vi.mocked(establishSession).mockResolvedValue(null);
    vi.mocked(onAuthStateChanged).mockImplementation((_auth: any, cb: any) => {
      authCallback = cb;
      cb(currentFbUser); // initial resolve (Firebase fires on mount)
      return unsubscribe as any;
    });
  });

  it("useAuth throws when used outside the provider", () => {
    function Bare() {
      useAuth();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/useAuth must be used within/);
    spy.mockRestore();
  });

  it("initial load with no session settles loading=false and a null user", async () => {
    renderAuth();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("");
    expect(screen.getByTestId("customer")).toHaveTextContent("");
    expect(getMyCustomerSession).not.toHaveBeenCalled();
  });

  it("defers Firebase for an anonymous storefront until account UI opens", async () => {
    const user = userEvent.setup();
    renderAuth(false);

    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(onAuthStateChanged).not.toHaveBeenCalled();

    await user.click(screen.getByText("open"));

    expect(screen.getByTestId("modal")).toHaveTextContent("true");
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("initial load with a session populates the user and fetches the customer row", async () => {
    currentFbUser = FB_USER;
    customerRow = CUSTOMER;
    renderAuth();

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByTestId("user")).toHaveTextContent("u-1");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(getMyCustomerSession).toHaveBeenCalled();
  });

  // Regression: `loading` used to clear the moment Firebase answered, while the
  // customer fetch was still in flight — so a signed-in visitor was briefly
  // {loading: false, customer: null}, which every consumer reads as "signed
  // out". That window is what popped the auth modal over a signed-in checkout
  // on every refresh (nothing closes it once the row arrives).
  it("holds loading=true until the customer row lands for a signed-in visitor", async () => {
    currentFbUser = FB_USER;
    let resolveCustomer: (res: any) => void = () => {};
    vi.mocked(getMyCustomerSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCustomer = resolve;
        }),
    );

    renderAuth();

    // Firebase has answered — the user is populated — but the row is in flight.
    await waitFor(() =>
      expect(screen.getByTestId("user")).toHaveTextContent("u-1"),
    );
    expect(screen.getByTestId("customer")).toHaveTextContent("");
    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await act(async () => {
      resolveCustomer({ status: "ok", customer: CUSTOMER });
    });

    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("customer")).toHaveTextContent("Ada");
  });

  // ...and it must settle even when that fetch fails, or consumers gated on
  // `loading` would wait forever.
  it("settles loading when the customer fetch rejects", async () => {
    currentFbUser = FB_USER;
    vi.mocked(getMyCustomerSession).mockRejectedValue(new Error("network"));

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("u-1");
  });

  // ── Self-heal: a live Firebase session the server no longer recognises ────
  // `sm_session` lasts 14 days; the client SDK's persistence is indefinite. A
  // shopper returning after a fortnight is still signed in as far as the
  // browser is concerned, so re-mint the cookie rather than demanding an OTP.

  it("re-mints a lapsed session cookie and retries the read once", async () => {
    currentFbUser = FB_USER;
    vi.mocked(getMyCustomerSession)
      .mockResolvedValueOnce({ status: "no-session", customer: null })
      .mockResolvedValueOnce({ status: "ok", customer: CUSTOMER });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("customer")).toHaveTextContent("Ada"),
    );
    // forceRefresh — a revoked or disabled account must fail at the token
    // rather than mint a cookie from a stale cached one.
    expect(establishSession).toHaveBeenCalledWith(true);
    expect(getMyCustomerSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  // A store admin browsing their own storefront: valid cookie, no `users` row.
  // Re-minting would achieve nothing and cost every page load a round-trip.
  it("does not re-mint when the session is valid but there is no customer row", async () => {
    currentFbUser = FB_USER;
    customerRow = null; // → { status: "no-row" }

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(establishSession).not.toHaveBeenCalled();
    expect(getMyCustomerSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("customer")).toHaveTextContent("");
  });

  // An outage is not a lapsed cookie — a fresh one fixes nothing.
  it("does not re-mint when the read was unavailable", async () => {
    currentFbUser = FB_USER;
    vi.mocked(getMyCustomerSession).mockResolvedValue({
      status: "unavailable",
      customer: null,
    });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(establishSession).not.toHaveBeenCalled();
    expect(getMyCustomerSession).toHaveBeenCalledTimes(1);
  });

  it("gives up after one re-mint instead of retrying in a loop", async () => {
    currentFbUser = FB_USER;
    vi.mocked(getMyCustomerSession).mockResolvedValue({
      status: "no-session",
      customer: null,
    });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(establishSession).toHaveBeenCalledTimes(1);
    expect(getMyCustomerSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("customer")).toHaveTextContent("");
  });

  it("skips the retry when the cookie could not be re-minted", async () => {
    currentFbUser = FB_USER;
    vi.mocked(getMyCustomerSession).mockResolvedValue({
      status: "no-session",
      customer: null,
    });
    vi.mocked(establishSession).mockResolvedValue(
      "Could not create a session.",
    );

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(getMyCustomerSession).toHaveBeenCalledTimes(1);
  });

  it("openAuthModal / closeAuthModal toggle isAuthModalOpen", async () => {
    const user = userEvent.setup();
    renderAuth();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    expect(screen.getByTestId("modal")).toHaveTextContent("false");
    await user.click(screen.getByText("open"));
    expect(screen.getByTestId("modal")).toHaveTextContent("true");
    await user.click(screen.getByText("close"));
    expect(screen.getByTestId("modal")).toHaveTextContent("false");
  });

  it("signOut calls endSession and clears user + customer", async () => {
    const user = userEvent.setup();
    currentFbUser = FB_USER;
    customerRow = CUSTOMER;
    renderAuth();

    expect(await screen.findByText("Ada")).toBeInTheDocument();

    await user.click(screen.getByText("signOut"));

    expect(endSession).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("user")).toHaveTextContent("");
      expect(screen.getByTestId("customer")).toHaveTextContent("");
    });
  });

  it("onAuthStateChanged SIGNED_IN populates the user (and SIGNED_OUT clears it)", async () => {
    customerRow = CUSTOMER;
    renderAuth();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(authCallback).toBeTypeOf("function");

    await act(async () => {
      authCallback!(FB_USER);
    });
    expect(screen.getByTestId("user")).toHaveTextContent("u-1");
    await waitFor(() =>
      expect(screen.getByTestId("customer")).toHaveTextContent("Ada"),
    );

    await act(async () => {
      authCallback!(null);
    });
    expect(screen.getByTestId("user")).toHaveTextContent("");
    expect(screen.getByTestId("customer")).toHaveTextContent("");
  });

  it("refreshCustomer re-fetches from the live session and surfaces the update", async () => {
    const user = userEvent.setup();
    currentFbUser = FB_USER;
    customerRow = CUSTOMER;
    renderAuth();
    expect(await screen.findByText("Ada")).toBeInTheDocument();

    customerRow = { ...CUSTOMER, first_name: "Grace" };
    await user.click(screen.getByText("refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("customer")).toHaveTextContent("Grace"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("u-1");
  });

  it("unsubscribes from auth state changes on unmount", async () => {
    const { unmount } = renderAuth();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
