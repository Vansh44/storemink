// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkProposalCard } from "./mink-proposal-card";

type Proposal = Extract<MinkArtifact, { type: "proposal" }>;

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";

const proposal: Proposal = {
  type: "proposal",
  draftId: DRAFT_ID,
  draftKind: "product_description",
  title: "Rewrite the description",
  destinationLabel: "Amul Taaza Toned Milk",
  destinationPath: "/dashboard/products/p1",
  before: [
    {
      key: "description",
      label: "Description",
      value: "Old copy.",
      multiline: true,
      maxLength: 4000,
    },
  ],
  after: [
    {
      key: "description",
      label: "Description",
      value: "New copy.",
      multiline: true,
      maxLength: 4000,
    },
  ],
  content: { description: "New copy." },
  status: "draft",
  currentVersion: 1,
  expectedCredits: 2,
  chargedCredits: 2,
  creditSource: "plan",
};

const approval = {
  id: APPROVAL_ID,
  sourceApprovalId: null,
  toolName: "apply_product_description" as const,
  operation: "apply" as const,
  status: "pending" as const,
  draftId: DRAFT_ID,
  draftVersion: 1,
  product: {
    id: "p1",
    name: "Amul Taaza Toned Milk",
    slug: "amul-taaza",
    dashboardPath: "/dashboard/products/p1",
  },
  before: { description: "Old copy." },
  after: { description: "New copy." },
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  executedAt: null,
};

function draftBody(lastProductAction: unknown = null) {
  return {
    draft: {
      id: DRAFT_ID,
      kind: proposal.draftKind,
      title: proposal.title,
      status: proposal.status,
      destinationLabel: proposal.destinationLabel,
      destinationPath: proposal.destinationPath,
      before: { description: "Old copy." },
      content: proposal.content,
      currentVersion: 1,
      expectedCredits: 2,
      chargedCredits: 2,
      creditSource: "plan",
      versions: [],
      lastProductAction,
      lastDomainAction: null,
      lastInventoryAction: null,
      lastBulkInventoryAction: null,
      lastBulkPriceAction: null,
      lastOrderStatusAction: null,
      lastBlogPublication: null,
      lastCampaign: null,
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Render the card, drive it to a pending approval, then answer the execute POST
 * with `respond`. `reconcile` answers the draft re-read the card performs after
 * an unknown outcome.
 */
async function confirmWith(
  respond: () => Response | Promise<Response>,
  reconcile: () => Response = () => json(draftBody()),
) {
  let executed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST") {
        return executed ? reconcile() : json(draftBody());
      }
      const body = JSON.parse(String(init.body)) as { action: string };
      if (url.endsWith("/product-action") && body.action === "preview") {
        return json({ approval });
      }
      if (url.endsWith("/product-action") && body.action === "execute") {
        executed = true;
        return respond();
      }
      throw new Error(`unexpected request: ${url} ${body.action}`);
    }),
  );

  render(<MinkProposalCard proposal={proposal} />);

  // ★★ WAIT FOR THE CARD TO FINISH LOADING BEFORE CLICKING.
  //
  // `busy` starts as "load" and every action button is `disabled` until the
  // mount GET resolves — and `findByRole` matches a DISABLED button perfectly
  // happily. So clicking as soon as it appears fires an event that React drops,
  // the preview never runs, and the failure surfaces a second later as "unable
  // to find Approve and apply" with a pristine card in the dump.
  //
  // Locally the mocked GET resolves before the click and it passes; on a loaded
  // CI runner it does not, which is why this only ever failed in the shuffled
  // "Test Order Independence" job. Delaying just that GET by 50ms reproduces it
  // exactly. Waiting on the button being ENABLED is timing-independent.
  const review = await screen.findByRole("button", {
    name: /review exact change/i,
  });
  await waitFor(() => {
    if ((review as HTMLButtonElement).disabled) {
      throw new Error("still loading the draft");
    }
  });
  fireEvent.click(review);

  fireEvent.click(
    await screen.findByRole("button", { name: /approve and apply/i }),
  );
}

describe("Mink proposal card · execute outcome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the approval when the execute outcome is unknown", async () => {
    // A 503 comes from one generic catch covering failures both before AND
    // after the transaction commits, so it is not proof that nothing happened.
    await confirmWith(() =>
      json({ error: "Mink AI couldn't complete that product action." }, 503),
    );

    await screen.findByText(
      /couldn't confirm whether that change was applied/i,
    );
    // The approval must survive: re-confirming the SAME approvalId is
    // idempotent, whereas a fresh preview would apply the change a second time.
    expect(
      screen.getByRole("button", { name: /approve and apply/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /review exact change/i }),
    ).toBeNull();
    expect(screen.queryByText(/was not applied/i)).toBeNull();
  });

  it("resolves an unknown outcome that had in fact committed", async () => {
    await confirmWith(
      () =>
        json({ error: "Mink AI couldn't complete that product action." }, 503),
      () =>
        json(
          draftBody({
            approval: {
              ...approval,
              status: "executed",
              executedAt: new Date().toISOString(),
            },
            auditId: "audit-1",
            repeated: true,
          }),
        ),
    );

    // The re-read found this exact approval executed, so the card reports what
    // actually happened instead of asking the admin to guess.
    await screen.findByText(/approved text applied to the product/i);
    expect(
      screen.queryByRole("button", { name: /approve and apply/i }),
    ).toBeNull();
  });

  it("clears the approval when the server definitely refused", async () => {
    await confirmWith(() =>
      json(
        {
          error: "The saved proposal changed after preview. Review it again.",
          code: "mink_product_draft_conflict",
        },
        409,
      ),
    );

    await screen.findByText(/the saved proposal changed after preview/i);
    // A 4xx IS a verdict: nothing was written and the approval is spent.
    expect(
      await screen.findByRole("button", { name: /review exact change/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /approve and apply/i }),
    ).toBeNull();
  });

  it("treats a rejected fetch as unknown rather than as a refusal", async () => {
    await confirmWith(() => Promise.reject(new TypeError("Failed to fetch")));

    await screen.findByText(
      /couldn't confirm whether that change was applied/i,
    );
    expect(
      screen.getByRole("button", { name: /approve and apply/i }),
    ).toBeTruthy();
  });
});
