import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkArtifacts } from "./mink-artifacts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Mink storefront artifacts", () => {
  it("renders bounded builder context without inventory-specific truncation copy", () => {
    const artifact: MinkArtifact = {
      type: "records",
      title: "Storefront pages",
      recordType: "storefront",
      records: [
        {
          id: "home",
          title: "Home",
          subtitle: "home · 4 draft sections",
          value: "Unpublished changes",
          status: "published",
          dashboardPath: "/dashboard/builder?page=home",
        },
      ],
      filters: [{ label: "Scope", value: "Current store" }],
      dashboardPath: "/dashboard/builder",
      truncated: true,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText("Storefront pages")).toBeInTheDocument();
    expect(screen.getByText("Home")).toHaveAttribute(
      "href",
      "/dashboard/builder?page=home",
    );
    expect(
      screen.getByText(
        "Showing a bounded result set. Open the dashboard for the full list.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/lowest-stock matches/i)).not.toBeInTheDocument();
  });

  it("renders an owner-loaded, network-isolated desktop/mobile code preview with escaped source", async () => {
    const draftId = "11111111-1111-4111-8111-111111111111";
    const target = {
      pageSlug: "home",
      sectionId: "hero-code",
      expectedPageVersion: "2026-09-04T10:20:30.123456+00:00",
      expectedSectionDigest: "a".repeat(64),
    };
    const beforeConfig = {
      html: "<section>Current</section>",
      css: "section { color: black; }",
      js: "",
      height_mode: "auto",
      fixed_height: 480,
    };
    const proposedConfig = {
      html: "<section>Premium arrivals</section>",
      css: "section { color: rebeccapurple; }",
      js: "",
      height_mode: "auto",
      fixed_height: 480,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          preview: {
            id: draftId,
            draftVersion: 0,
            title: "Storefront code for Home",
            destinationLabel: "Home · custom code",
            destinationPath: "/dashboard/builder?page=home&section=hero-code",
            explanation: "A responsive private hero preview.",
            target,
            targetState: "current",
            targetMessage: "The Website Builder target still matches.",
            patchDigest: "b".repeat(64),
            beforeConfig,
            proposedConfig,
            changedFields: ["html", "css"],
            validationChecks: ["Exact target matched", "No write authority"],
            sandbox: {
              schemaVersion: 1,
              phase: "7B",
              mode: "private_proposal_preview",
              target: {
                pageSlug: "exact",
                sectionId: "exact",
                pageVersion: "required",
                sectionDigest: "required",
              },
              limits: {
                maxCharactersPerCodeField: 65_536,
                maxCharactersPerPatch: 98_304,
                codeReadChunkCharacters: 8_000,
                minFixedHeight: 120,
                maxFixedHeight: 1_200,
              },
              iframe: {
                sandboxAttribute: "allow-scripts",
                opaqueOrigin: true,
                sameOrigin: false,
                topNavigation: false,
              },
              prohibitedCapabilities: ["network requests"],
              authority: {
                canReadBuilderContext: true,
                canValidatePatchShape: true,
                canCreatePrivateProposal: true,
                canPreviewGeneratedCode: true,
                canSaveCode: false,
                canPublish: false,
                canAccessRepository: false,
                canDeploy: false,
              },
            },
            authority: {
              canPreview: true,
              canEditProposal: false,
              canSaveBuilderDraft: false,
              canPublish: false,
            },
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "storefront_code_proposal",
      draftId,
      title: "Storefront code for Home",
      destinationLabel: "Home · custom code",
      destinationPath: "/dashboard/builder?page=home&section=hero-code",
      explanation: "A responsive private hero preview.",
      target,
      patchDigest: "b".repeat(64),
      changedFields: ["html", "css"],
      beforeCharacters: 50,
      afterCharacters: 70,
      validationChecks: ["Exact target matched", "No write authority"],
      status: "private_preview",
      expectedCredits: 5,
      chargedCredits: 5,
      creditSource: "plan",
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    const frame = await screen.findByTitle(
      "Home · custom code private Mink preview",
    );
    expect(fetch).toHaveBeenCalledWith(
      `/api/mink/drafts/${draftId}/storefront-code-preview`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(
      screen.getByRole("button", { name: /review builder draft save/i }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /publish/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /mobile/i }));
    expect(
      screen.getByTestId("mink-storefront-preview-viewport"),
    ).toHaveAttribute("data-viewport", "mobile");
    fireEvent.click(screen.getByRole("button", { name: /html/i }));
    expect(screen.getByText("<section>Current</section>")).toBeVisible();
    expect(
      screen.getByText("<section>Premium arrivals</section>"),
    ).toBeVisible();
  });
});

describe("Mink catalogue artifact", () => {
  it("renders product and SKU counts with inspectable publication and stock tags", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 8,
        published: 6,
        unpublished: 2,
        draft: 2,
        archived: 0,
        inventoryItems: 12,
        lowStock: 1,
        outOfStock: 4,
      },
      items: [
        {
          id: "variant-1",
          title: "Cobalt Lounge Chair",
          variant: "Bone",
          sku: "SKU10080001V026",
          publicationStatus: "published",
          publicationTags: ["published"],
          inventoryStatus: "out",
          stock: 0,
          threshold: 5,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      filters: [
        { label: "Publication", value: "Current store" },
        { label: "Inventory", value: "Shop" },
      ],
      dashboardPath: "/dashboard/products",
      inventoryDashboardPath: "/dashboard/inventory?location=shop-1",
    };

    render(<MinkArtifacts artifacts={[artifact]} />);

    expect(screen.getByText("Unpublished")).toBeVisible();
    expect(screen.getByText("Low-stock SKUs")).toBeVisible();
    expect(screen.getByText("Out-of-stock SKUs")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Cobalt Lounge Chair" }),
    ).toHaveAttribute("href", "/dashboard/products/product-1");
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.getByText("published")).toBeVisible();
    expect(screen.getByText("Out of stock")).toBeVisible();
    expect(screen.getByText("Shop")).toBeVisible();
  });

  it("renders permission-safe inventory choices as one-click follow-ups", () => {
    const onPrompt = vi.fn();
    const artifact: MinkArtifact = {
      type: "clarification",
      title: "Choose inventory scope",
      question: "Stock can differ by location. Which scope should I use?",
      choices: [
        {
          label: "Compare locations",
          description: "See location counts side by side.",
          prompt: "Compare inventory by location",
        },
        { label: "Shop", prompt: "Show Shop inventory" },
      ],
    };

    render(<MinkArtifacts artifacts={[artifact]} onPrompt={onPrompt} />);
    fireEvent.click(screen.getByRole("button", { name: /shop/i }));
    expect(onPrompt).toHaveBeenCalledWith("Show Shop inventory");
  });

  it("does not present an untracked zero as an in-stock quantity", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 1,
        published: 1,
        unpublished: 0,
        draft: 0,
        archived: 0,
        inventoryItems: 1,
        lowStock: 0,
        outOfStock: 0,
      },
      items: [
        {
          id: "product-1",
          title: "Carrots",
          sku: "SKU-CARROTS",
          publicationStatus: "published",
          publicationTags: ["published"],
          inventoryStatus: "untracked",
          stock: 0,
          threshold: 5,
        },
      ],
      filters: [{ label: "Inventory", value: "Shop" }],
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText("Not tracked")).toBeVisible();
    expect(screen.queryByText("in stock")).toBeNull();
  });

  it("renders location comparisons without an empty product-list fallback", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 14,
        published: 14,
        unpublished: 0,
        draft: 0,
        archived: 0,
        inventoryItems: 16,
        lowStock: null,
        outOfStock: null,
      },
      items: [],
      locations: [
        {
          id: "shop-1",
          name: "Shop",
          type: "shop",
          inventoryItems: 16,
          trackedItems: 9,
          lowStock: 1,
          outOfStock: 2,
          dashboardPath: "/dashboard/inventory?location=shop-1",
          prompt: "Show Shop inventory",
        },
      ],
      filters: [{ label: "Inventory", value: "Each accessible location" }],
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText("Inventory by location")).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) => element?.textContent === "shop · 9 tracked SKUs",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching products or variants.")).toBeNull();
  });

  it("polls and renders a completed durable workflow with safe dashboard links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "11111111-1111-4111-8111-111111111111",
            template: "weekly_trading_report",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              rangeLabel: "Last 7 days",
              comparisonLabel: "Previous 7 days",
              fromInclusive: "2026-08-25T00:00:00.000Z",
              toExclusive: "2026-09-01T00:00:00.000Z",
              timeZone: "Asia/Kolkata",
              currency: "INR",
              locationLabel: "Shop",
              netSales: 12500,
              netSalesTrendPercent: 12.5,
              orders: 20,
              ordersTrendPercent: 10,
              averageOrderValue: 625,
              averageOrderValueTrendPercent: 2,
              unitsSold: 31,
              unitsSoldTrendPercent: 8,
              topProducts: [
                {
                  id: "product-1",
                  name: "Basmati Rice",
                  units: 12,
                  amount: 4800,
                  dashboardPath: "https://attacker.example/product",
                },
              ],
              channels: [],
              dataAsOf: "2026-09-01T00:01:00.000Z",
              highlights: ["Net sales grew 12.5% versus the previous period."],
              analyticsPath: "/dashboard/analytics?range=7d&compare=previous",
            },
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:01:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "11111111-1111-4111-8111-111111111111",
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description: "A durable report.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText(/Queued for background processing/i)).toBeVisible();
    await waitFor(() => expect(screen.getByText("₹12,500.00")).toBeVisible());
    expect(screen.getByRole("link", { name: /Basmati Rice/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(
      screen.getByRole("link", { name: /Open Analytics/i }),
    ).toHaveAttribute("href", "/dashboard/analytics?range=7d&compare=previous");
  });

  it("renders a bounded revenue investigation with evidence caveats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "22222222-2222-4222-8222-222222222222",
            template: "revenue_decline_investigation",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              period: "30d",
              rangeLabel: "Last 30 days",
              comparisonLabel: "Previous 30 days",
              fromInclusive: "2026-08-02T00:00:00.000Z",
              toExclusive: "2026-09-01T00:00:00.000Z",
              comparisonFromInclusive: "2026-07-03T00:00:00.000Z",
              comparisonToExclusive: "2026-08-02T00:00:00.000Z",
              timeZone: "Asia/Kolkata",
              currency: "INR",
              locationLabel: "Shop and Delhi",
              current: {
                netSales: 8000,
                orders: 16,
                averageOrderValue: 500,
                unitsSold: 25,
              },
              previous: {
                netSales: 10000,
                orders: 20,
                averageOrderValue: 500,
                unitsSold: 30,
              },
              currentChannels: [],
              previousChannels: [],
              currentLocations: [],
              previousLocations: [],
              currentProducts: [],
              previousProducts: [],
              dataAsOf: "2026-09-01T00:01:00.000Z",
              metrics: [
                {
                  key: "netSales",
                  label: "Net sales",
                  current: 8000,
                  previous: 10000,
                  delta: -2000,
                  deltaPercent: -20,
                  format: "currency",
                },
              ],
              findings: ["Recognized net sales fell 20%."],
              channelMovements: [
                {
                  key: "online",
                  name: "Online",
                  currentAmount: 5000,
                  previousAmount: 7000,
                  delta: -2000,
                  deltaPercent: -28.6,
                },
              ],
              locationMovements: [],
              productMovements: [],
              caveats: [
                "These are correlations in StoreMink data, not proof of causation.",
              ],
              analyticsPath: "/dashboard/analytics?range=30d&compare=previous",
            },
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:01:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "22222222-2222-4222-8222-222222222222",
      template: "revenue_decline_investigation",
      title: "Revenue decline investigation",
      description: "A durable investigation.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    await waitFor(() =>
      expect(screen.getByText("Evidence summary")).toBeVisible(),
    );
    expect(screen.getByText(/not proof of causation/i)).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Verify in Analytics/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/analytics?range=30d&compare=previous",
    );
  });

  it("renders a private launch package and sanitizes product links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "33333333-3333-4333-8333-333333333333",
            template: "product_launch_preparation",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              storeName: "Echos",
              productId: "product-1",
              productName: "Basmati Rice (Sample)",
              requestedSku: "SKU10010007V028",
              requestedVariantName: "5 kg",
              status: "published",
              categoryName: "Groceries",
              featured: false,
              descriptionLength: 120,
              seoTitleLength: 40,
              seoDescriptionLength: 120,
              imageCount: 2,
              variantsTruncated: false,
              locationLabel: "Shop and Delhi",
              timeZone: "Asia/Kolkata",
              currency: "INR",
              skus: [
                {
                  productId: "product-1",
                  variantId: "variant-1",
                  productName: "Basmati Rice (Sample)",
                  variantName: "5 kg",
                  sku: "SKU10010007V028",
                  basePrice: 500,
                  sellingPrice: 450,
                  specialPrice: null,
                  trackInventory: true,
                  lowStockThreshold: 5,
                  totalStock: 20,
                  locationStocks: [],
                  requiresShipping: true,
                  shippingMeasurementsComplete: true,
                  dashboardPath: "https://attacker.example/product",
                },
              ],
              locationStock: [
                {
                  id: "shop-1",
                  name: "Shop",
                  type: "shop",
                  stock: 20,
                  dashboardPath: "/dashboard/inventory?location=shop-1",
                },
              ],
              dataAsOf: "2026-09-01T00:01:00.000Z",
              productDashboardPath: "/dashboard/products/product-1",
              inventoryDashboardPath: "/dashboard/inventory",
              readinessScore: 100,
              readinessLabel: "ready",
              checks: [
                {
                  key: "publication",
                  label: "Publication state",
                  status: "ready",
                  detail: "Product is published.",
                },
              ],
              blockers: [],
              warnings: [],
              checklist: ["Review the final product page."],
              suggestedCopy: {
                headline: "Meet Basmati Rice (Sample) — 5 kg",
                subheading: "Discover it from Echos.",
                callToAction: "Shop now",
              },
            },
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:01:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "33333333-3333-4333-8333-333333333333",
      template: "product_launch_preparation",
      title: "Product launch preparation",
      description: "A private readiness package.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    await waitFor(() =>
      expect(screen.getByText(/Launch readiness/i)).toBeVisible(),
    );
    expect(screen.getByText("Grounded starter copy")).toBeVisible();
    expect(screen.getByRole("link", { name: /5 kg/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(
      screen.getByText(/Nothing was published, repriced, generated or sent/i),
    ).toBeVisible();
  });

  it("renders a location-aware slow-stock proposal with an explicit approval boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "44444444-4444-4444-8444-444444444444",
            template: "slow_inventory_promotion",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              storeName: "Echos",
              period: "30d",
              periodDays: 30,
              rangeLabel: "Last 30 days",
              fromInclusive: "2026-08-03T00:00:00.000Z",
              toExclusive: "2026-09-02T00:00:00.000Z",
              timeZone: "Asia/Kolkata",
              currency: "INR",
              locationLabel: "Shop and Delhi",
              locationCount: 2,
              totalCandidateShelves: 1,
              truncated: false,
              storeDiscountCeilingPercent: 50,
              dataAsOf: "2026-09-02T00:01:00.000Z",
              candidates: [
                {
                  productId: "product-1",
                  variantId: "variant-1",
                  productName: "Basmati Rice (Sample)",
                  variantName: "5 kg",
                  sku: "SKU10010007V028",
                  locationId: "delhi-1",
                  locationName: "Delhi",
                  stock: 20,
                  unitsSold: 2,
                  salesAmount: 900,
                  effectivePrice: 450,
                  unitCost: 300,
                  productDashboardPath: "https://attacker.example/product",
                  inventoryDashboardPath:
                    "/dashboard/inventory?location=delhi-1",
                  daysOfCover: 300,
                  sellThroughPercent: 9.1,
                  grossMarginPercent: 33.3,
                  reason: "excess_cover",
                },
              ],
              promotionProposal: {
                status: "needs_terms",
                name: "Move slow stock · Shop and Delhi",
                objective: "Test demand for one evidence-backed slow SKU.",
                targetSkus: ["SKU10010007V028"],
                suggestedDiscountPercent: 10,
                durationDays: 7,
                budgetRequired: true,
                activationRequiresSeparateApproval: true,
                note: "Review actual basket economics before use.",
              },
              approvalBoundary: [
                "This is private; Mink did not create or activate an offer.",
                "Choose a budget before saving.",
                "The analysed location is evidence scope, not an offer-eligibility boundary.",
                "Activation needs separate human approval.",
              ],
              caveats: [
                "Online or unassigned orders are not assigned to a shelf.",
              ],
              inventoryDashboardPath: "/dashboard/inventory",
              offersDashboardPath: "/dashboard/offers/new",
            },
            createdAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:01:00.000Z",
            completedAt: "2026-09-02T00:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "44444444-4444-4444-8444-444444444444",
      template: "slow_inventory_promotion",
      title: "Slow-inventory promotion proposal",
      description: "A private slow-stock analysis.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    await waitFor(() =>
      expect(
        screen.getByText("Private promotion recommendation"),
      ).toBeVisible(),
    );
    expect(screen.getByText("Approval boundary")).toBeVisible();
    expect(screen.getByText(/₹900\.00 sales/i)).toBeVisible();
    expect(
      screen.getByText(/not an offer-eligibility boundary/i),
    ).toBeVisible();
    expect(screen.getByText(/No offer, price, inventory/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /Basmati Rice/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(
      screen.getByRole("link", { name: /Open Offers manually/i }),
    ).toHaveAttribute("href", "/dashboard/offers/new");
  });

  it("renders PII-minimized delayed pickups and withholds duplicate reminder copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "55555555-5555-4555-8555-555555555555",
            template: "delayed_pickup_review",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              locationLabel: "Shop",
              locationCount: 1,
              timeZone: "Asia/Kolkata",
              reviewedAt: "2026-09-03T12:00:00.000Z",
              riskWindowHours: 48,
              totalActionableOrders: 1,
              preparationOverdueCount: 0,
              preparationAtRiskCount: 0,
              collectionDueCount: 1,
              truncated: false,
              dataAsOf: "2026-09-03T12:00:00.000Z",
              pickups: [
                {
                  orderRef: "ECH-1003",
                  locationName: "Shop",
                  pickupStatus: "ready",
                  createdAt: "2026-09-01T08:00:00.000Z",
                  promisedReadyAt: "2026-09-02T08:00:00.000Z",
                  preparedAt: "2026-09-02T09:00:00.000Z",
                  expiresAt: "2026-09-04T08:00:00.000Z",
                  warnedAt: "2026-09-03T11:00:00.000Z",
                  orderDashboardPath: "/dashboard/orders?q=ECH-1003",
                  issue: "collection_due",
                  hoursUntilExpiry: 20,
                  hoursPastPromise: null,
                  reminderState: "already_recorded",
                },
              ],
              communications: [
                {
                  kind: "automatic_collection_reminder",
                  title: "Collection reminder",
                  status: "automatic_reminder_already_recorded",
                  orderReferences: ["ECH-1003"],
                  subject: null,
                  body: null,
                  note: "StoreMink already recorded the one-time pickup reminder, so Mink withheld duplicate message copy.",
                },
              ],
              safetyNotes: [
                "Customer names, email addresses, phone numbers, postal addresses and collection codes are never included.",
              ],
              ordersDashboardPath: "/dashboard/orders",
            },
            createdAt: "2026-09-03T12:00:00.000Z",
            updatedAt: "2026-09-03T12:01:00.000Z",
            completedAt: "2026-09-03T12:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "55555555-5555-4555-8555-555555555555",
      template: "delayed_pickup_review",
      title: "Delayed pickup review",
      description: "Private pickup review.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    await waitFor(() =>
      expect(screen.getByText(/Pickup review complete/i)).toBeVisible(),
    );
    expect(screen.getByText("Duplicate withheld")).toBeVisible();
    expect(screen.getByText(/withheld duplicate message copy/i)).toBeVisible();
    expect(screen.queryByText(/customer@example\.com/i)).toBeNull();
    expect(screen.getByRole("link", { name: /ECH-1003/i })).toHaveAttribute(
      "href",
      "/dashboard/orders?q=ECH-1003",
    );
  });
});
