// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ publishPage: vi.fn() }));
vi.mock("@/app/actions/page-actions", () => ({ publishPage: h.publishPage }));

import { MinkStorefrontLayoutProposalCard } from "./mink-storefront-layout-proposal-card";
import type { MinkArtifact } from "@/lib/mink/types";

const PAGE_ID = "9f1d2c3b-4a5e-4f60-8123-abcdefabcdef";

const savedResult = {
  approval: {
    id: "11111111-1111-4111-8111-111111111111",
    sourceApprovalId: null,
    toolName: "apply_storefront_layout",
    operation: "apply",
    status: "executed",
    draftId: "22222222-2222-4222-8222-222222222222",
    draftVersion: 0,
    resource: {
      type: "storefront_page",
      id: PAGE_ID,
      label: "Home",
      dashboardPath: "/dashboard/builder",
    },
    before: {
      page_slug: "home",
      page_title: "Home",
      sections_digest: "a".repeat(64),
      section_count: "8",
    },
    after: {
      page_slug: "home",
      page_title: "Home",
      sections_digest: "b".repeat(64),
      section_count: "9",
    },
    summary: { kept: [], added: [], removed: [], reordered: false },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    executedAt: new Date().toISOString(),
  },
  auditId: "33333333-3333-4333-8333-333333333333",
  repeated: false,
};

const proposal = {
  type: "storefront_layout_proposal",
  draftId: "22222222-2222-4222-8222-222222222222",
  title: "Layout for Home",
  destinationLabel: "Home",
  destinationPath: "/dashboard/builder",
  explanation: "Adds the offer banner to the hero carousel.",
  target: {
    pageSlug: "home",
    expectedPageVersion: "2026-09-20 10:00:00.123456+00",
    expectedSectionsDigest: "a".repeat(64),
  },
  patchDigest: "c".repeat(64),
  summary: { kept: [], added: [], removed: [], reordered: false },
  sectionCount: 9,
  status: "private_preview",
  expectedCredits: 3,
  chargedCredits: 3,
  creditSource: "plan",
} as Extract<MinkArtifact, { type: "storefront_layout_proposal" }>;

/** The card asks for its latest action on mount; serve the applied one. */
function mountApplied() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: savedResult }),
    })),
  );
  return render(<MinkStorefrontLayoutProposalCard proposal={proposal} />);
}

beforeEach(() => {
  h.publishPage.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// ★★ THE SECOND STEP, IN THE SAME CARD.
//
// Reported: "I should go to the website builder then it will be saved at draft
// — all and all it's pretty complex." Applying already worked in one click;
// publishing meant leaving chat for a different screen. Publishing stays a
// separate deliberate act, it is simply no longer somewhere else.
// ---------------------------------------------------------------------------
describe("publishing from the layout card", () => {
  it("★★ offers Publish only once the draft save has landed", async () => {
    // Nothing applied yet: fetch reports no prior action.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ result: null }) })),
    );
    render(<MinkStorefrontLayoutProposalCard proposal={proposal} />);

    expect(
      await screen.findByRole("button", {
        name: /apply to website builder draft/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
  });

  it("★★ publishes the page the save landed in, by its own id", async () => {
    mountApplied();
    const button = await screen.findByRole("button", {
      name: /publish this page/i,
    });
    await userEvent.click(button);

    await waitFor(() => expect(h.publishPage).toHaveBeenCalledTimes(1));
    expect(h.publishPage).toHaveBeenCalledWith(PAGE_ID);
    // ⚠ No expectedUpdatedAt: the save that just succeeded IS the latest
    // version, so passing the value from before it would refuse every time.
    expect(h.publishPage.mock.calls[0]).toHaveLength(1);
  });

  it("★ says the whole draft goes live, not just this proposal", async () => {
    mountApplied();
    await screen.findByRole("button", { name: /publish this page/i });
    expect(screen.getByText(/whole draft on your storefront/i)).toBeTruthy();
  });

  it("★ reports a refusal and points at the draft it did not lose", async () => {
    // The real case: an empty custom-code section fails strict re-validation.
    h.publishPage.mockResolvedValue({
      error: "Section 9 (custom_code): Add some HTML, CSS or JavaScript first.",
    });
    mountApplied();
    await userEvent.click(
      await screen.findByRole("button", { name: /publish this page/i }),
    );

    expect(await screen.findByText(/Add some HTML/i)).toBeTruthy();
    expect(screen.getByText(/Your draft is safe/i)).toBeTruthy();
    // Still offered, because the merchant can fix the page and try again.
    expect(
      screen.getByRole("button", { name: /publish this page/i }),
    ).toBeTruthy();
  });

  it("★ and stops offering it once the page is live", async () => {
    mountApplied();
    await userEvent.click(
      await screen.findByRole("button", { name: /publish this page/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/this page is now live/i)).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: /publish this page/i }),
    ).toBeNull();
  });
});
