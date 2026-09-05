import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkStorefrontCodeActionResult } from "@/lib/mink/storefront-code-action-types";
import type {
  MinkStorefrontPublicationApproval,
  MinkStorefrontPublicationResult,
} from "@/lib/mink/storefront-publication-types";

vi.mock(
  "@/app/(storefront)/components/sections/custom-code-frame",
  async () => {
    const { useEffect, useRef } = await import("react");
    return {
      CustomCodeFrame: ({
        title,
        validation,
      }: {
        title: string;
        validation?: {
          token: string;
          viewport: "desktop" | "mobile";
          width: number;
          onResult: (result: unknown) => void;
        };
      }) => {
        const reported = useRef("");
        const validationToken = validation?.token;
        const validationViewport = validation?.viewport;
        const validationWidth = validation?.width;
        const validationOnResult = validation?.onResult;
        useEffect(() => {
          if (
            !validationToken ||
            !validationViewport ||
            !validationWidth ||
            !validationOnResult
          )
            return;
          const reportKey = `${validationToken}:${validationViewport}`;
          if (reported.current === reportKey) return;
          reported.current = reportKey;
          validationOnResult({
            token: validationToken,
            viewport: validationViewport,
            width: validationWidth,
            passed: true,
            issues: [],
            runtimeErrorCount: 0,
            cspViolationCount: 0,
            horizontalOverflow: false,
          });
        }, [
          validationOnResult,
          validationToken,
          validationViewport,
          validationWidth,
        ]);
        return <iframe title={title} />;
      },
    };
  },
);

import { MinkStorefrontPublicationControls } from "./mink-storefront-publication-controls";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const SAVE_APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const PUBLISH_APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const AUDIT_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);
const TARGET_DIGEST = "b".repeat(64);
const PAGE_VALUES = {
  page_slug: "home",
  page_title: "Home",
  page_status: "published" as const,
  published_at: "2026-09-04T10:00:00.000Z",
  sections_digest: DIGEST,
  target_section_id: "hero-code",
  target_section_digest: TARGET_DIGEST,
};
const SAVED_ACTION = {
  approval: {
    id: SAVE_APPROVAL_ID,
    status: "executed",
  },
} as MinkStorefrontCodeActionResult;
const PUBLISH_APPROVAL: MinkStorefrontPublicationApproval = {
  id: PUBLISH_APPROVAL_ID,
  sourceApprovalId: SAVE_APPROVAL_ID,
  toolName: "publish_storefront_code",
  operation: "apply",
  status: "pending",
  draftId: DRAFT_ID,
  draftVersion: 0,
  resource: {
    type: "storefront_page",
    id: PAGE_ID,
    label: "Home · storefront page",
    dashboardPath: "/dashboard/builder?page=home&section=hero-code",
    publicPath: "/",
  },
  before: PAGE_VALUES,
  after: { ...PAGE_VALUES, published_at: null },
  checks: {
    staticChecksPassed: true,
    browserChecksPassed: true,
    desktopWidth: 1280,
    mobileWidth: 390,
    browserFamily: "chromium",
    browserMajor: 140,
  },
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  executedAt: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Mink Phase 7D storefront publication controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires both isolated viewport checks and a fresh publication approval", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const mutation = JSON.parse(String(init?.body)) as { action: string };
        if (mutation.action === "preview_publish") {
          return json({ approval: PUBLISH_APPROVAL });
        }
        if (mutation.action === "execute") {
          const result: MinkStorefrontPublicationResult = {
            approval: {
              ...PUBLISH_APPROVAL,
              status: "executed",
              executedAt: new Date().toISOString(),
            },
            auditId: AUDIT_ID,
            repeated: false,
          };
          return json({ result });
        }
        throw new Error(`Unexpected mutation: ${mutation.action}`);
      }),
    );

    render(
      <MinkStorefrontPublicationControls
        draftId={DRAFT_ID}
        patchDigest={DIGEST}
        config={{
          html: "<section><h2>New arrivals</h2></section>",
          css: "",
          js: "",
          height_mode: "auto",
          fixed_height: 400,
        }}
        savedAction={SAVED_ACTION}
        initialResult={null}
      />,
    );

    const review = screen.getByRole("button", {
      name: /review storefront publication/i,
    });
    expect(review).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: /run publication checks/i }),
    );
    await screen.findByText(/desktop, mobile, runtime, CSP and accessibility/i);
    expect(review).not.toBeDisabled();

    fireEvent.click(review);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /approve and publish storefront/i,
      }),
    );
    await screen.findByText("Storefront published");
    expect(screen.getByText(new RegExp(AUDIT_ID))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /review exact rollback/i }),
    ).toBeTruthy();

    const calls = vi.mocked(fetch).mock.calls;
    const previewBody = JSON.parse(String(calls[0]?.[1]?.body));
    expect(previewBody).toMatchObject({
      action: "preview_publish",
      sourceApprovalId: SAVE_APPROVAL_ID,
      browserValidation: {
        patchDigest: DIGEST,
        browser: { family: "chromium", major: 140, supported: true },
        viewports: {
          desktop: { width: 1280, passed: true },
          mobile: { width: 390, passed: true },
        },
      },
    });
  });

  it.each(["malformed", "wrong-approval", "pending"])(
    "retains the same approval after an uncertain %s execution response",
    async (failure) => {
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      );
      let attempts = 0;
      const executed = {
        approval: {
          ...PUBLISH_APPROVAL,
          status: "executed",
          executedAt: new Date().toISOString(),
        },
        auditId: AUDIT_ID,
        repeated: true,
      };
      const fetchMock = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (!init?.body) return json({ lastPublication: null });
          const mutation = JSON.parse(String(init.body));
          if (mutation.action === "preview_publish")
            return json({ approval: PUBLISH_APPROVAL });
          attempts += 1;
          if (attempts > 1) return json({ result: executed });
          if (failure === "malformed")
            return new Response("{", { status: 200 });
          return json({
            result: {
              ...executed,
              approval:
                failure === "pending"
                  ? PUBLISH_APPROVAL
                  : { ...executed.approval, id: SAVE_APPROVAL_ID },
            },
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      render(
        <MinkStorefrontPublicationControls
          draftId={DRAFT_ID}
          patchDigest={DIGEST}
          config={{
            html: "<h2>Echos</h2>",
            css: "",
            js: "",
            height_mode: "auto",
            fixed_height: 400,
          }}
          savedAction={SAVED_ACTION}
          initialResult={null}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /run publication checks/i }),
      );
      await screen.findByText(
        /desktop, mobile, runtime, CSP and accessibility/i,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /review storefront publication/i }),
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: /approve and publish storefront/i,
        }),
      );
      await screen.findByText(/Approve this same request again/);
      expect(screen.queryByText("Storefront published")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: /approve and publish storefront/i }),
      );
      await screen.findByText("Storefront published");
      const executions = fetchMock.mock.calls
        .filter(([, init]) => init?.body)
        .map(([, init]) => JSON.parse(String(init?.body)))
        .filter((mutation) => mutation.action === "execute");
      expect(executions).toEqual([
        { action: "execute", approvalId: PUBLISH_APPROVAL_ID },
        { action: "execute", approvalId: PUBLISH_APPROVAL_ID },
      ]);
    },
  );
});
