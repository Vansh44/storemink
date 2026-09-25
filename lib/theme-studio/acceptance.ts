import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  themeStudioAcceptanceRuns,
  themeStudioAssets,
  themeStudioProjects,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { logError } from "@/lib/observability/logger";
import { cookieDomainForHost } from "@/lib/store/host";
import { MERCHANT_AUTHORED_SLUGS } from "@/lib/themes/validation";
import type { ThemeStudioActor } from "./access";
import {
  ACCEPTANCE_REPORT_VERSION,
  acceptanceAssetsDigest,
  acceptanceEvidenceDigest,
  acceptanceOutcome,
  evaluateBrowserGates,
  evaluatePackageGates,
  gate,
  internalLinks,
  linkFindings,
  markupFindings,
  parseBrowserEvidence,
  readAcceptanceReport,
  renderedWithTheme,
  routeRenderFindings,
  sha256Hex,
  type AcceptanceAssetRow,
  type AcceptanceOutcome,
  type AcceptanceSurface,
  type GateResult,
  type LinkCheckResult,
  type RouteFetchResult,
} from "./acceptance-gates";
import { fetchInternalPageWithRetry } from "./acceptance-http";
import { THEME_STUDIO_VIEWPORTS, validateThemePackageV2 } from "./contracts";
import { openThemeStudioPreview, type PreviewPage } from "./preview";
import {
  PREVIEW_COOKIE,
  signPreviewToken,
  verifyPreviewToken,
} from "./preview-token";
import { isUuid, recordThemeStudioEvent, ThemeStudioError } from "./repository";

// ---------------------------------------------------------------------------
// Theme Studio automated acceptance: the orchestration.
//
// A run judges ONE version and is bound to exactly what it judged — the
// version's package digest, a digest of every asset row the package renders,
// and the application build that rendered it. It has two stages:
//
//   1. SERVER. Package, design, security and asset gates (pure, in
//      acceptance-gates.ts); then the preview store is built from the version
//      and its rendered pages are fetched through this same server to check
//      status, theming, noindex, links and markup.
//   2. BROWSER. Whenever a preview was built and the security scan is clean
//      (a quality failure above does not skip it): the operator's browser loads
//      each surface at each acceptance viewport and reports raw measurements
//      (overflow, axe, broken images, LCP/CLS), bound to a one-time nonce.
//      The thresholds are applied here, never by the client.
//
// ★ A PASS IS WHAT MAKES A CANDIDATE, AND THE DATABASE SAYS SO. The project
// guard (migration 0131) refuses `candidate` unless the current version has a
// passed run over its exact package digest, so no action written later can
// skip this module.
//
// ★ FAILURE DOES NOT BLOCK UNLESS IT IS A SECURITY FAILURE. A quality failure
// leaves the project `ready` (demoting a candidate) for a revision to fix; a
// security failure moves it to `blocked`.
//
// ★ EVIDENCE GOES STALE WITHOUT CHANGING. A new deploy renders the storefront
// with different code, so a passing run made under another build no longer
// describes what a merchant would get. verifyThemeStudioCandidateEvidence is
// the check approval must make; the project is not demoted automatically,
// because a deploy should not rewrite project state behind an operator.
// ---------------------------------------------------------------------------

/** How long the browser stage may take before its nonce expires. */
export const ACCEPTANCE_BROWSER_TTL_MINUTES = 30;
/** A server stage older than this was abandoned (a crashed request). */
const RUNNING_STALE_MINUTES = 15;
/** Links crawled from the home and shop pages, at most. */
const MAX_LINKS = 20;
/** Links fetched at once: enough to finish quickly, few enough not to swamp a
 * small instance that is also serving the operator. */
const LINK_CONCURRENCY = 2;
/** The first request may compile the storefront in development. */
const FIRST_PAGE_TIMEOUT_MS = 90_000;
const PAGE_TIMEOUT_MS = 45_000;
/** Shopper-account pages redirect or render a sign-in prompt for any visitor;
 * crawling them proves nothing about the theme. */
const SKIPPED_LINK_PREFIXES = [
  "/auth",
  "/checkout",
  "/profile",
  "/orders",
  "/notifications",
  "/blogs/write",
  "/blogs/my-submissions",
];

/**
 * The build that renders the storefront. On Cloud Run each deploy is a new
 * revision, so K_REVISION moves on every release; an explicit override exists
 * for other hosts. Local development is one build for as long as it runs.
 */
export function currentAcceptanceBuildId(): string {
  const configured =
    process.env.THEME_STUDIO_BUILD_ID?.trim() || process.env.K_REVISION?.trim();
  if (configured) return configured.slice(0, 200);
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export interface AcceptanceBrowserPlan {
  runId: string;
  nonce: string;
  origin: string;
  enterToken: string;
  pages: PreviewPage[];
  viewports: typeof THEME_STUDIO_VIEWPORTS;
  expiresAt: string;
}

export interface AcceptanceStartResult {
  runId: string;
  status: "awaiting_browser" | "failed" | "blocked";
  plan: AcceptanceBrowserPlan | null;
}

type RunRow = typeof themeStudioAcceptanceRuns.$inferSelect;

export async function assetRowsFor(
  db: Db,
  projectId: string,
  packageJson: unknown,
): Promise<AcceptanceAssetRow[]> {
  const parsed = validateThemePackageV2(packageJson);
  const digests = parsed.ok
    ? parsed.value.assets
        .map((asset) => asset.sha256)
        .filter((sha): sha is string => typeof sha === "string")
    : [];
  if (digests.length === 0) return [];
  return db
    .select({
      id: themeStudioAssets.id,
      purpose: themeStudioAssets.purpose,
      mediaType: themeStudioAssets.mediaType,
      byteSize: themeStudioAssets.byteSize,
      width: themeStudioAssets.width,
      height: themeStudioAssets.height,
      sha256: themeStudioAssets.sha256,
    })
    .from(themeStudioAssets)
    .where(
      and(
        eq(themeStudioAssets.projectId, projectId),
        inArray(themeStudioAssets.sha256, digests),
      ),
    );
}

/** Retire this version's abandoned runs so a new one can start. */
async function retireStaleRuns(db: Db, versionId: string): Promise<void> {
  await db
    .update(themeStudioAcceptanceRuns)
    .set({
      status: "error",
      completedAt: sql`now()`,
      serverReport: sql`${themeStudioAcceptanceRuns.serverReport} || '{"abandoned":true}'::jsonb`,
    })
    .where(
      and(
        eq(themeStudioAcceptanceRuns.versionId, versionId),
        eq(themeStudioAcceptanceRuns.status, "running"),
        lt(
          themeStudioAcceptanceRuns.createdAt,
          sql`now() - (${RUNNING_STALE_MINUTES}::int * interval '1 minute')`,
        ),
      ),
    );
  // A browser stage that was never finished is superseded by a new start:
  // the same inputs are about to be judged again.
  await db
    .update(themeStudioAcceptanceRuns)
    .set({
      status: "expired",
      completedAt: sql`now()`,
      browserNonceHash: null,
      browserExpiresAt: null,
    })
    .where(
      and(
        eq(themeStudioAcceptanceRuns.versionId, versionId),
        eq(themeStudioAcceptanceRuns.status, "awaiting_browser"),
      ),
    );
}

/** Stage one's rendered-route checks against a built preview. */
async function routeGates(input: {
  actor: ThemeStudioActor;
  versionId: string;
  origin: string;
  enterToken: string;
  pages: PreviewPage[];
  sessionCookie: string | null;
}): Promise<GateResult[]> {
  const claims = verifyPreviewToken(input.enterToken, "enter");
  if (!claims) {
    const reason = "The preview could not be entered from the server.";
    return [
      gate("routes.render", [{ code: "token", message: reason }]),
      gate("routes.links", [], { status: "skipped" }),
      gate("routes.markup", [], { status: "skipped" }),
    ];
  }
  const host = new URL(input.origin).host;
  const cookies: Record<string, string> = {
    [PREVIEW_COOKIE]: signPreviewToken(
      "grant",
      {
        storeId: claims.sid,
        versionId: input.versionId,
        actorId: input.actor.id,
      },
      15 * 60,
    ),
  };
  // Where the platform session reaches the preview host, the gate requires it
  // (preview-access.ts), so the operator's own session travels with the grant.
  if (cookieDomainForHost(host) && input.sessionCookie) {
    cookies[SESSION_COOKIE] = input.sessionCookie;
  }

  const routes: RouteFetchResult[] = [];
  const bodies: { path: string; html: string }[] = [];
  const crawlSources: string[] = [];
  for (const [index, page] of input.pages.entries()) {
    const response = await fetchInternalPageWithRetry({
      host,
      path: page.path,
      cookies,
      timeoutMs: index === 0 ? FIRST_PAGE_TIMEOUT_MS : PAGE_TIMEOUT_MS,
    });
    const robotsHeader = String(response.headers["x-robots-tag"] ?? "");
    routes.push({
      surface: page.surface as AcceptanceSurface,
      path: page.path,
      status: response.status,
      themed: renderedWithTheme(response.body),
      noindex:
        /noindex/i.test(robotsHeader) ||
        /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(
          response.body,
        ),
      error: response.error,
    });
    if (response.status === 200 || response.status === 404) {
      bodies.push({ path: page.path, html: response.body });
    }
    if (
      (page.surface === "home" || page.surface === "shop") &&
      response.status === 200
    ) {
      crawlSources.push(response.body);
    }
  }

  const visited = new Set(input.pages.map((page) => page.path));
  const toCrawl = [
    ...new Set(crawlSources.flatMap((html) => internalLinks(html))),
  ]
    .filter(
      (path) =>
        !visited.has(path) &&
        // Policy pages are the merchant's to write (validation.ts): a theme
        // cannot fix a missing one, so it is not the theme's broken link.
        !MERCHANT_AUTHORED_SLUGS.has(path.slice(1).split(/[?#]/)[0]) &&
        !SKIPPED_LINK_PREFIXES.some(
          (prefix) =>
            path === prefix ||
            path.startsWith(`${prefix}/`) ||
            path.startsWith(`${prefix}?`),
        ),
    )
    .slice(0, MAX_LINKS);
  const links: LinkCheckResult[] = [];
  for (let i = 0; i < toCrawl.length; i += LINK_CONCURRENCY) {
    const batch = await Promise.all(
      toCrawl.slice(i, i + LINK_CONCURRENCY).map(async (path) => {
        const response = await fetchInternalPageWithRetry({
          host,
          path,
          cookies,
          timeoutMs: PAGE_TIMEOUT_MS,
        });
        return { path, status: response.status, error: response.error };
      }),
    );
    links.push(...batch);
  }

  return [
    gate("routes.render", routeRenderFindings(routes), {
      metrics: { pages: routes.length },
    }),
    gate("routes.links", linkFindings(links), {
      metrics: { checked: links.length },
    }),
    gate("routes.markup", markupFindings(bodies, input.origin)),
  ];
}

const OUTCOME_STATUS: Record<
  AcceptanceOutcome,
  "passed" | "failed" | "blocked"
> = { pass: "passed", fail: "failed", blocked: "blocked" };

/**
 * Record a verdict and move the project. Runs inside one transaction with the
 * project locked, and writes the run BEFORE the project, because the project
 * guard looks for the passed run when a candidate is created.
 */
async function finishRun(
  db: Db,
  actor: ThemeStudioActor,
  run: RunRow,
  input: {
    outcome: AcceptanceOutcome;
    gates: GateResult[];
    serverReport: Record<string, unknown>;
    browserReport?: Record<string, unknown>;
  },
): Promise<void> {
  const [project] = await db
    .select()
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, run.projectId))
    .for("update")
    .limit(1);
  const evidenceDigest = acceptanceEvidenceDigest(
    {
      runId: run.id,
      versionId: run.versionId,
      packageDigest: run.packageDigest,
      assetsDigest: run.assetsDigest,
      buildId: run.buildId,
    },
    input.gates,
  );
  const status = OUTCOME_STATUS[input.outcome];
  await db
    .update(themeStudioAcceptanceRuns)
    .set({
      status,
      serverReport: input.serverReport,
      ...(input.browserReport ? { browserReport: input.browserReport } : {}),
      evidenceDigest,
      browserNonceHash: null,
      browserExpiresAt: null,
      completedAt: sql`now()`,
    })
    .where(eq(themeStudioAcceptanceRuns.id, run.id));

  let nextState: string | null = null;
  if (project && project.currentVersionId === run.versionId) {
    if (input.outcome === "pass" && project.status === "ready") {
      nextState = "candidate";
    } else if (input.outcome === "fail" && project.status === "candidate") {
      nextState = "ready";
    } else if (
      input.outcome === "blocked" &&
      (project.status === "ready" || project.status === "candidate")
    ) {
      nextState = "blocked";
    }
  }
  if (project && nextState) {
    await db
      .update(themeStudioProjects)
      .set({ status: nextState, revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
  }
  if (project) {
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: `acceptance_${status}`,
      detail: {
        runId: run.id,
        versionId: run.versionId,
        evidenceDigest,
        failedGates: input.gates
          .filter((g) => g.required && g.status !== "pass")
          .map((g) => g.id),
        ...(nextState ? { projectStatus: nextState } : {}),
      },
    });
  }
}

/**
 * Start an acceptance run on the project's CURRENT version and run the server
 * stage. Returns a browser plan when the server stage passed. The caller must
 * have passed getThemeStudioActor(); this module is not a "use server" file.
 */
export async function startThemeStudioAcceptance(
  actor: ThemeStudioActor,
  input: { projectId: string; versionId: string; sessionCookie: string | null },
): Promise<AcceptanceStartResult> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  const buildId = currentAcceptanceBuildId();
  const started = await withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    if (!project) {
      throw new ThemeStudioError("not_found", "That project no longer exists.");
    }
    if (project.status !== "ready" && project.status !== "candidate") {
      throw new ThemeStudioError(
        "illegal_state",
        project.status === "generating"
          ? "Wait for the active run to finish before checking this version."
          : project.status === "blocked"
            ? "This project is blocked. Revise it, or make a version current again, before checking."
            : "This project can't be checked right now.",
      );
    }
    if (project.currentVersionId !== input.versionId) {
      throw new ThemeStudioError(
        "illegal_state",
        "Only the current version can be checked. Make this version current first.",
      );
    }
    const [version] = await db
      .select()
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!version?.packageJson || !version.packageDigest) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version has no theme to check.",
      );
    }
    await retireStaleRuns(db, version.id);
    const rows = await assetRowsFor(db, project.id, version.packageJson);
    const parsed = validateThemePackageV2(version.packageJson);
    const assetsDigest = parsed.ok
      ? acceptanceAssetsDigest(parsed.value, rows)
      : sha256Hex("invalid-package");
    const inserted = await db
      .insert(themeStudioAcceptanceRuns)
      .values({
        projectId: project.id,
        versionId: version.id,
        packageDigest: version.packageDigest,
        assetsDigest,
        buildId,
        createdBy: actor.id,
        createdByEmail: actor.email,
      })
      .onConflictDoNothing()
      .returning();
    const run = inserted[0];
    if (!run) {
      throw new ThemeStudioError(
        "illegal_state",
        "A check of this version is already running.",
      );
    }
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "acceptance_started",
      detail: { runId: run.id, versionId: version.id, buildId },
    });
    return { run, packageJson: version.packageJson, rows };
  });

  const { run } = started;
  try {
    const packageStage = evaluatePackageGates(
      started.packageJson,
      started.rows,
    );
    const gates: GateResult[] = [...packageStage.gates];
    let plan: AcceptanceBrowserPlan | null = null;
    let surfaces: AcceptanceSurface[] = [];

    if (!packageStage.pkg) {
      const reason = "The package contract failed, so no preview was built.";
      gates.push(
        gate("demo.materialize", [{ code: "skipped", message: reason }], {
          status: "skipped",
        }),
        gate("routes.render", [{ code: "skipped", message: reason }], {
          status: "skipped",
        }),
        gate("routes.links", [{ code: "skipped", message: reason }], {
          status: "skipped",
        }),
        gate("routes.markup", [{ code: "skipped", message: reason }], {
          status: "skipped",
        }),
      );
    } else {
      let opened: Awaited<ReturnType<typeof openThemeStudioPreview>> | null =
        null;
      try {
        opened = await openThemeStudioPreview(actor, {
          projectId: input.projectId,
          versionId: input.versionId,
        });
        gates.push(gate("demo.materialize", []));
      } catch (error) {
        gates.push(
          gate("demo.materialize", [
            {
              code: "materialize",
              message:
                error instanceof ThemeStudioError
                  ? error.message
                  : "The preview store could not be built.",
            },
          ]),
        );
        if (!(error instanceof ThemeStudioError)) {
          logError("theme studio: acceptance materialization threw", error, {
            runId: run.id,
          });
        }
      }
      if (opened) {
        surfaces = opened.pages.map(
          (page) => page.surface as AcceptanceSurface,
        );
        gates.push(
          ...(await routeGates({
            actor,
            versionId: input.versionId,
            origin: opened.origin,
            enterToken: opened.enterToken,
            pages: opened.pages,
            sessionCookie: input.sessionCookie,
          })),
        );
        plan = {
          runId: run.id,
          nonce: "",
          origin: opened.origin,
          enterToken: opened.enterToken,
          pages: opened.pages,
          viewports: THEME_STUDIO_VIEWPORTS,
          expiresAt: "",
        };
      } else {
        const reason = "No preview was built, so no page could be fetched.";
        gates.push(
          gate("routes.render", [{ code: "skipped", message: reason }], {
            status: "skipped",
          }),
          gate("routes.links", [{ code: "skipped", message: reason }], {
            status: "skipped",
          }),
          gate("routes.markup", [{ code: "skipped", message: reason }], {
            status: "skipped",
          }),
        );
      }
    }

    const serverReport = {
      version: ACCEPTANCE_REPORT_VERSION,
      gates,
      surfaces,
    };
    // The browser stage runs whenever a preview exists and nothing tripped
    // the security scan, even if another server gate already failed: a
    // reviewer needs every problem at once, not one stage per round trip.
    const outcome = acceptanceOutcome(gates);
    if (outcome === "blocked" || !plan) {
      await withService((db) =>
        finishRun(db, actor, run, {
          outcome: outcome === "pass" ? "fail" : outcome,
          gates,
          serverReport,
        }),
      );
      return {
        runId: run.id,
        status: outcome === "blocked" ? "blocked" : "failed",
        plan: null,
      };
    }

    const nonce = randomBytes(24).toString("base64url");
    const [updated] = await withService((db) =>
      db
        .update(themeStudioAcceptanceRuns)
        .set({
          status: "awaiting_browser",
          serverReport,
          browserNonceHash: sha256Hex(nonce),
          browserExpiresAt: sql`now() + (${ACCEPTANCE_BROWSER_TTL_MINUTES}::int * interval '1 minute')`,
        })
        .where(
          and(
            eq(themeStudioAcceptanceRuns.id, run.id),
            eq(themeStudioAcceptanceRuns.status, "running"),
          ),
        )
        .returning({ expiresAt: themeStudioAcceptanceRuns.browserExpiresAt }),
    );
    if (!updated) {
      throw new ThemeStudioError(
        "stale",
        "This check was superseded by another one. Start it again.",
      );
    }
    return {
      runId: run.id,
      status: "awaiting_browser",
      plan: { ...plan, nonce, expiresAt: updated.expiresAt ?? "" },
    };
  } catch (error) {
    await withService((db) =>
      db
        .update(themeStudioAcceptanceRuns)
        .set({ status: "error", completedAt: sql`now()` })
        .where(
          and(
            eq(themeStudioAcceptanceRuns.id, run.id),
            eq(themeStudioAcceptanceRuns.status, "running"),
          ),
        ),
    ).catch(() => undefined);
    if (error instanceof ThemeStudioError) throw error;
    logError("theme studio: acceptance server stage threw", error, {
      runId: run.id,
    });
    throw new ThemeStudioError(
      "illegal_state",
      "The acceptance check could not finish. Try again.",
    );
  }
}

function nonceMatches(nonce: unknown, hash: string | null): boolean {
  if (typeof nonce !== "string" || !hash || nonce.length > 200) return false;
  const a = Buffer.from(sha256Hex(nonce), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Record the browser stage and reach a verdict. Every threshold is applied
 * here from raw measurements; the surfaces the report must cover come from the
 * server's own record of the run, not from the report.
 */
export async function submitThemeStudioBrowserEvidence(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    runId: string;
    nonce: unknown;
    evidence: unknown;
  },
): Promise<{ status: "passed" | "failed" | "blocked" }> {
  if (!isUuid(input.projectId) || !isUuid(input.runId)) {
    throw new ThemeStudioError("not_found", "That check no longer exists.");
  }
  const parsed = parseBrowserEvidence(input.evidence);
  if (!parsed.ok) {
    throw new ThemeStudioError("invalid_input", parsed.error);
  }
  return withService(async (db) => {
    const [project] = await db
      .select({ id: themeStudioProjects.id })
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    const [run] = await db
      .select()
      .from(themeStudioAcceptanceRuns)
      .where(
        and(
          eq(themeStudioAcceptanceRuns.id, input.runId),
          eq(themeStudioAcceptanceRuns.projectId, input.projectId),
        ),
      )
      .for("update")
      .limit(1);
    if (!project || !run) {
      throw new ThemeStudioError("not_found", "That check no longer exists.");
    }
    if (run.status !== "awaiting_browser") {
      throw new ThemeStudioError(
        "stale",
        "This check has already finished. Start a new one.",
      );
    }
    if (!nonceMatches(input.nonce, run.browserNonceHash)) {
      throw new ThemeStudioError(
        "invalid_input",
        "This browser report does not belong to that check.",
      );
    }
    const expired =
      !run.browserExpiresAt || Date.parse(run.browserExpiresAt) < Date.now();
    const redeployed = run.buildId !== currentAcceptanceBuildId();
    if (expired || redeployed) {
      await db
        .update(themeStudioAcceptanceRuns)
        .set({
          status: expired ? "expired" : "error",
          browserNonceHash: null,
          browserExpiresAt: null,
          completedAt: sql`now()`,
        })
        .where(eq(themeStudioAcceptanceRuns.id, run.id));
      throw new ThemeStudioError(
        "stale",
        expired
          ? "The browser checks took too long. Start the check again."
          : "The application was redeployed during the check. Start it again.",
      );
    }
    const serverReport = readAcceptanceReport(run.serverReport);
    const surfaces = serverReport.surfaces ?? [];
    const browserGates = evaluateBrowserGates(parsed.value, surfaces);
    const gates = [...serverReport.gates, ...browserGates];
    const outcome = acceptanceOutcome(gates);
    await finishRun(db, actor, run, {
      outcome,
      gates,
      serverReport: run.serverReport as Record<string, unknown>,
      browserReport: {
        version: ACCEPTANCE_REPORT_VERSION,
        gates: browserGates,
        userAgent: parsed.value.userAgent,
      },
    });
    return { status: OUTCOME_STATUS[outcome] };
  });
}

// ------------------------------------------------------------ read model

export interface ThemeStudioAcceptanceRunView {
  id: string;
  versionId: string;
  status:
    | "running"
    | "awaiting_browser"
    | "passed"
    | "failed"
    | "blocked"
    | "error"
    | "expired";
  packageDigest: string;
  assetsDigest: string;
  buildId: string;
  evidenceDigest: string | null;
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
  gates: GateResult[];
  userAgent: string | null;
  /** Rendered by the build serving this request. */
  currentBuild: boolean;
}

function toView(row: RunRow, buildId: string): ThemeStudioAcceptanceRunView {
  const server = readAcceptanceReport(row.serverReport);
  const browser = readAcceptanceReport(row.browserReport);
  return {
    id: row.id,
    versionId: row.versionId,
    status: row.status as ThemeStudioAcceptanceRunView["status"],
    packageDigest: row.packageDigest,
    assetsDigest: row.assetsDigest,
    buildId: row.buildId,
    evidenceDigest: row.evidenceDigest,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    gates: [...server.gates, ...browser.gates],
    userAgent: browser.userAgent ?? null,
    currentBuild: row.buildId === buildId,
  };
}

/** A project's recent acceptance runs, newest first. */
export async function listThemeStudioAcceptanceRuns(
  projectId: string,
  limit = 30,
): Promise<ThemeStudioAcceptanceRunView[]> {
  if (!isUuid(projectId)) return [];
  const rows = await withService((db) =>
    db
      .select()
      .from(themeStudioAcceptanceRuns)
      .where(eq(themeStudioAcceptanceRuns.projectId, projectId))
      .orderBy(desc(themeStudioAcceptanceRuns.createdAt))
      .limit(limit),
  );
  const buildId = currentAcceptanceBuildId();
  return rows.map((row) => toView(row, buildId));
}

export type CandidateEvidence =
  | { ok: true; runId: string; evidenceDigest: string }
  | { ok: false; reason: string };

/**
 * Is the candidate's evidence still true? Re-derives every binding — the
 * version is current, a PASSED run covers its package digest, that run was
 * rendered by this build, and the asset rows still hash to what it judged.
 * Approval (Phase 6) must call this; the candidate state alone is not enough.
 */
export async function verifyThemeStudioCandidateEvidence(
  projectId: string,
): Promise<CandidateEvidence> {
  if (!isUuid(projectId)) return { ok: false, reason: "Unknown project." };
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, projectId))
      .limit(1);
    if (!project) return { ok: false, reason: "Unknown project." };
    return verifyCandidateEvidenceWithDb(db, project);
  });
}

/**
 * The same check inside a caller's transaction, over a project row it has
 * already read (usually locked). Phase 6 approval runs it with the candidate
 * row it holds; publication runs it for an APPROVED project and skips the
 * build binding — a deploy between approval and publication must not strand
 * an approved theme, and the published demo is rendered and checked again.
 */
export async function verifyCandidateEvidenceWithDb(
  db: Db,
  project: { id: string; status: string; currentVersionId: string | null },
  options: {
    status?: "candidate" | "approved";
    requireCurrentBuild?: boolean;
  } = {},
): Promise<CandidateEvidence> {
  const status = options.status ?? "candidate";
  const requireCurrentBuild = options.requireCurrentBuild ?? true;
  if (!project.currentVersionId) {
    return { ok: false, reason: "The project has no current version." };
  }
  if (project.status !== status) {
    return {
      ok: false,
      reason:
        status === "candidate"
          ? "The project is not a candidate."
          : "The project is not approved.",
    };
  }
  const [version] = await db
    .select()
    .from(themeStudioVersions)
    .where(eq(themeStudioVersions.id, project.currentVersionId))
    .limit(1);
  const [run] = await db
    .select()
    .from(themeStudioAcceptanceRuns)
    .where(
      and(
        eq(themeStudioAcceptanceRuns.versionId, project.currentVersionId),
        eq(themeStudioAcceptanceRuns.status, "passed"),
      ),
    )
    // The same order the project guard reads (migration 0134): the latest
    // passing run is the evidence reviews must bind to.
    .orderBy(
      desc(themeStudioAcceptanceRuns.completedAt),
      desc(themeStudioAcceptanceRuns.createdAt),
    )
    .limit(1);
  if (!version?.packageDigest || !run?.evidenceDigest) {
    return {
      ok: false,
      reason: "No passing acceptance run covers this version.",
    };
  }
  if (run.packageDigest !== version.packageDigest) {
    return { ok: false, reason: "The evidence judged a different package." };
  }
  if (requireCurrentBuild && run.buildId !== currentAcceptanceBuildId()) {
    return {
      ok: false,
      reason:
        "The evidence was rendered by an earlier build. Run the checks again.",
    };
  }
  const parsed = validateThemePackageV2(version.packageJson);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "The version no longer passes its contract.",
    };
  }
  const rows = await assetRowsFor(db, project.id, version.packageJson);
  if (acceptanceAssetsDigest(parsed.value, rows) !== run.assetsDigest) {
    return {
      ok: false,
      reason: "The version's assets changed since it was checked.",
    };
  }
  return { ok: true, runId: run.id, evidenceDigest: run.evidenceDigest };
}
