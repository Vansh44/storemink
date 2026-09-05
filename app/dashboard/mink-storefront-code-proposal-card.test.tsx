import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";

vi.mock("@/app/(storefront)/components/sections/custom-code-frame", () => ({
  CustomCodeFrame: ({ title }: { title: string }) => <iframe title={title} />,
}));

import { MinkStorefrontCodeProposalCard } from "./mink-storefront-code-proposal-card";

type Proposal = Extract<MinkArtifact, { type: "storefront_code_proposal" }>;

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_VERSION = "2026-09-04T10:20:30.123456+00:00";
const SECTION_DIGEST = "a".repeat(64);
const PROPOSED_DIGEST = "b".repeat(64);

const beforeConfig = {
  html: '<section class="hero">Old</section>',
  css: ".hero { color: black; }",
  js: "",
  height_mode: "auto" as const,
  fixed_height: 400,
};
const proposedConfig = {
  ...beforeConfig,
  html: '<section class="hero">New</section>',
  css: ".hero { color: purple; }",
};

const proposal: Proposal = {
  type: "storefront_code_proposal",
  draftId: DRAFT_ID,
  title: "Echos homepage custom code",
  destinationLabel: "Home · custom code",
  destinationPath: "/dashboard/builder?page=home&section=hero-code",
  explanation: "Refresh the Echos homepage hero.",
  target: {
    pageSlug: "home",
    sectionId: "hero-code",
    expectedPageVersion: PAGE_VERSION,
    expectedSectionDigest: SECTION_DIGEST,
  },
  patchDigest: "c".repeat(64),
  changedFields: ["html", "css"],
  beforeCharacters: 55,
  afterCharacters: 59,
  validationChecks: ["Exact target matched", "Network access rejected"],
  status: "private_preview",
  expectedCredits: 5,
  chargedCredits: 5,
  creditSource: "plan",
};

const before = {
  page_slug: "home",
  page_title: "Home",
  section_id: "hero-code",
  section_digest: SECTION_DIGEST,
  html: beforeConfig.html,
  css: beforeConfig.css,
  js: beforeConfig.js,
  height_mode: beforeConfig.height_mode,
  fixed_height: "400",
};
const after = {
  ...before,
  section_digest: PROPOSED_DIGEST,
  html: proposedConfig.html,
  css: proposedConfig.css,
};
const approval = {
  id: APPROVAL_ID,
  sourceApprovalId: null,
  toolName: "apply_storefront_code" as const,
  operation: "apply" as const,
  status: "pending" as const,
  draftId: DRAFT_ID,
  draftVersion: 0,
  resource: {
    type: "storefront_section" as const,
    id: PAGE_ID,
    label: "Home · custom code",
    dashboardPath: "/dashboard/builder?page=home&section=hero-code",
  },
  before,
  after,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  executedAt: null,
};

function previewBody(lastAction: unknown = null) {
  return {
    preview: {
      id: DRAFT_ID,
      draftVersion: 0,
      title: proposal.title,
      destinationLabel: proposal.destinationLabel,
      destinationPath: proposal.destinationPath,
      explanation: proposal.explanation,
      target: proposal.target,
      targetState: "current",
      targetMessage: "The exact Builder target is current.",
      patchDigest: proposal.patchDigest,
      beforeConfig,
      proposedConfig,
      changedFields: proposal.changedFields,
      validationChecks: proposal.validationChecks,
      sandbox: {
        iframe: {
          sandboxAttribute: "allow-scripts",
          opaqueOrigin: true,
          sameOrigin: false,
          topNavigation: false,
        },
      },
      authority: {
        canPreview: true,
        canEditProposal: false,
        canSaveBuilderDraft: true,
        canPublish: false,
      },
    },
    lastAction,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function driveToExecute(
  execute: () => Response | Promise<Response>,
  reconcile: () => Response = () => json(previewBody()),
) {
  let executeAttempted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return executeAttempted ? reconcile() : json(previewBody());
      }
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === "preview") return json({ approval });
      if (body.action === "execute") {
        executeAttempted = true;
        return execute();
      }
      throw new Error(`Unexpected storefront action: ${body.action}`);
    }),
  );

  render(<MinkStorefrontCodeProposalCard proposal={proposal} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /review builder draft save/i }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: /approve and save builder draft/i,
    }),
  );
}

describe("Mink Phase 7C storefront proposal card", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the exact approval after an unknown execute outcome", async () => {
    await driveToExecute(() =>
      json({ error: "Mink AI couldn't complete that action." }, 503),
    );

    await screen.findByText(
      /couldn't confirm whether the Builder draft was saved/i,
    );
    expect(
      screen.getByRole("button", {
        name: /approve and save builder draft/i,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /review builder draft save/i }),
    ).toBeNull();
  });

  it("reconciles a save that committed before a lost response", async () => {
    const executed = {
      approval: {
        ...approval,
        status: "executed",
        executedAt: new Date().toISOString(),
      },
      auditId: AUDIT_ID,
      repeated: true,
    };
    await driveToExecute(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => json(previewBody(executed)),
    );

    await screen.findByText(/saved to the private Website Builder draft/i);
    expect(screen.getByText(new RegExp(AUDIT_ID))).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /approve and save builder draft/i,
      }),
    ).toBeNull();
  });

  it("retires a definitely rejected approval", async () => {
    await driveToExecute(() =>
      json(
        {
          error: "The Website Builder page changed. Nothing was saved.",
          code: "mink_storefront_target_conflict",
        },
        409,
      ),
    );

    await screen.findByText(/Website Builder page changed/i);
    expect(
      await screen.findByRole("button", {
        name: /review builder draft save/i,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /approve and save builder draft/i,
      }),
    ).toBeNull();
  });
});
