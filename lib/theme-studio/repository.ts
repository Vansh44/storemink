import "server-only";

import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql, sum } from "drizzle-orm";
import {
  themeCatalogEntries,
  themeReleases,
  themeStudioAssets,
  themeStudioEvents,
  themeStudioMessages,
  themeStudioPreviews,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { isBundledThemeId } from "@/lib/themes";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import type { ThemeStudioActor } from "./access";
import {
  canonicalJson,
  THEME_STUDIO_CATALOG_SIZES,
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_INDUSTRIES,
  THEME_STUDIO_LIMITS,
  validateThemePackageV2,
  type ThemePackageV2,
  type ThemeStudioProjectState,
} from "./contracts";
import { getVertexConfig } from "./gemini-vertex";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import {
  getThemeStudioConfig,
  isImplementedProvider,
  THEME_STUDIO_FAKE_PROMPT_VERSION,
} from "./config";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompts";
import {
  parseThemeStudioModelKey,
  resolveThemeStudioModel,
  type ThemeStudioModelKey,
} from "./models";
import type { SanitizedReference } from "./references";

// ---------------------------------------------------------------------------
// Theme Studio persistence. Service scope throughout, so EVERY exported
// function here assumes its caller already passed `getThemeStudioActor()`:
// this module is deliberately not a "use server" file, because an export of
// one is a public endpoint and these read platform-wide data.
//
// Invariants the database also enforces (migration 0128), repeated here only
// so a refusal can carry a sentence instead of a constraint name:
// one active run per project, the Phase 0 state machine, immutable
// messages/assets/versions, append-only events.
// ---------------------------------------------------------------------------

export class ThemeStudioError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_input"
      | "theme_id_taken"
      | "stale"
      | "illegal_state"
      | "limit"
      | "generation_disabled"
      | "provider_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ThemeStudioError";
  }
}

// ---------------------------------------------------------------- read models

export interface ThemeStudioProjectSummary {
  id: string;
  themeId: string;
  name: string;
  status: ThemeStudioProjectState;
  modelKey: ThemeStudioModelKey;
  createdByEmail: string;
  updatedAt: string;
  activeRunStatus: "queued" | "running" | null;
  versionCount: number;
}

export interface ThemeStudioReferenceView {
  id: string;
  width: number;
  height: number;
  byteSize: number;
  originalMediaType: string;
  originalByteSize: number;
  createdAt: string;
  /** Cited by a submitted message, so it can no longer be removed. */
  cited: boolean;
}

export interface ThemeStudioRunUsageView {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  estimatedCostMicroUsd: number;
  repairs: number;
}

export interface ThemeStudioRunView {
  usage: ThemeStudioRunUsageView | null;
  /** Operator-readable result that isn't a version: questions or a reason. */
  questions: string[];
  declineReason: string | null;
  refusalCategory: string | null;
  id: string;
  kind: "generate" | "revise";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  provider: string;
  modelKey: ThemeStudioModelKey;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  cancelRequested: boolean;
  retryOfRunId: string | null;
  /** Revise runs: the version being revised. */
  baseVersionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ThemeStudioPackageSummary {
  pages: number;
  sections: number;
  products: number;
  placeholders: number;
  gaps: { code: string; requestedCapability: string; blocking: boolean }[];
}

export interface ThemeStudioVersionView {
  packageSummary: ThemeStudioPackageSummary | null;
  id: string;
  versionNumber: number;
  parentVersionId: string | null;
  /** Null for a version made by replacing images, which no run produced. */
  runId: string | null;
  origin: "run" | "asset_edit";
  /** For an image edit: the slots whose images were replaced. */
  editedSlots: string[];
  intentDigest: string;
  packageDigest: string | null;
  summary: string;
  assumptions: string[];
  hasPackage: boolean;
  createdAt: string;
}

export interface ThemeStudioEventView {
  id: string;
  eventType: string;
  actorKind: "operator" | "worker";
  actorEmail: string | null;
  runId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ThemeStudioMessageView {
  id: string;
  kind: "brief" | "revision";
  body: string;
  referenceCount: number;
  createdAt: string;
}

export interface ThemeStudioProjectDetail {
  id: string;
  themeId: string;
  name: string;
  status: ThemeStudioProjectState;
  modelKey: ThemeStudioModelKey;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  baseThemeId: string | null;
  draftBrief: string;
  currentVersionId: string | null;
  revision: number;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  references: ThemeStudioReferenceView[];
  messages: ThemeStudioMessageView[];
  runs: ThemeStudioRunView[];
  versions: ThemeStudioVersionView[];
  previews: ThemeStudioPreviewView[];
  events: ThemeStudioEventView[];
}

export interface ThemeStudioPreviewView {
  id: string;
  versionId: string;
  status: "materializing" | "ready" | "failed";
  lastOpenedAt: string;
  expiresAt: string;
}

export async function listThemeStudioProjects(): Promise<
  ThemeStudioProjectSummary[]
> {
  return withService(async (db) => {
    const projects = await db
      .select({
        id: themeStudioProjects.id,
        themeId: themeStudioProjects.themeId,
        name: themeStudioProjects.name,
        status: themeStudioProjects.status,
        modelKey: themeStudioProjects.modelKey,
        createdByEmail: themeStudioProjects.createdByEmail,
        updatedAt: themeStudioProjects.updatedAt,
      })
      .from(themeStudioProjects)
      .orderBy(desc(themeStudioProjects.updatedAt))
      .limit(100);
    if (projects.length === 0) return [];
    const ids = projects.map((p) => p.id);
    // Sequential: both share this transaction's client.
    const active = await db
      .select({
        projectId: themeStudioRuns.projectId,
        status: themeStudioRuns.status,
      })
      .from(themeStudioRuns)
      .where(
        and(
          inArray(themeStudioRuns.projectId, ids),
          inArray(themeStudioRuns.status, ["queued", "running"]),
        ),
      );
    const versions = await db
      .select({
        projectId: themeStudioVersions.projectId,
        n: count(),
      })
      .from(themeStudioVersions)
      .where(inArray(themeStudioVersions.projectId, ids))
      .groupBy(themeStudioVersions.projectId);
    const activeBy = new Map(active.map((r) => [r.projectId, r.status]));
    const versionsBy = new Map(versions.map((r) => [r.projectId, Number(r.n)]));
    return projects.map((p) => ({
      ...p,
      status: p.status as ThemeStudioProjectState,
      modelKey: p.modelKey as ThemeStudioModelKey,
      activeRunStatus:
        (activeBy.get(p.id) as "queued" | "running" | undefined) ?? null,
      versionCount: versionsBy.get(p.id) ?? 0,
    }));
  });
}

function intentField(intent: unknown, key: string): unknown {
  return intent && typeof intent === "object"
    ? (intent as Record<string, unknown>)[key]
    : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runExtras(usage: unknown, detail: unknown) {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<
    string,
    unknown
  >;
  const totals = (
    u.totals && typeof u.totals === "object" ? u.totals : null
  ) as Record<string, unknown> | null;
  const repairs = (
    u.repairs && typeof u.repairs === "object" ? u.repairs : {}
  ) as Record<string, unknown>;
  const d = (detail && typeof detail === "object" ? detail : {}) as Record<
    string,
    unknown
  >;
  return {
    usage: totals
      ? {
          inputTokens: num(totals.inputTokens),
          outputTokens: num(totals.outputTokens),
          thinkingTokens: num(totals.thinkingTokens),
          cachedTokens: num(totals.cachedTokens),
          estimatedCostMicroUsd: num(u.estimatedCostMicroUsd),
          repairs: num(repairs.intent) + num(repairs.draft),
        }
      : null,
    questions:
      d.kind === "clarify" && Array.isArray(d.questions)
        ? d.questions.filter((q): q is string => typeof q === "string")
        : [],
    declineReason:
      d.kind === "declined" && typeof d.reason === "string" ? d.reason : null,
    refusalCategory: typeof d.category === "string" ? d.category : null,
  };
}

function editedSlots(detail: unknown): string[] {
  const slots =
    detail && typeof detail === "object"
      ? (detail as { slots?: unknown }).slots
      : undefined;
  return Array.isArray(slots)
    ? slots.filter((s): s is string => typeof s === "string").slice(0, 40)
    : [];
}

function packageSummary(pkg: unknown): ThemeStudioPackageSummary | null {
  if (!pkg || typeof pkg !== "object") return null;
  const p = pkg as {
    definition?: {
      preset?: {
        pages?: { sections?: unknown[] }[];
        sampleData?: { products?: unknown[] };
      };
    };
    assets?: { licenseNote?: string }[];
    capabilityGaps?: {
      code?: string;
      requestedCapability?: string;
      blocking?: boolean;
    }[];
  };
  const pages = p.definition?.preset?.pages ?? [];
  return {
    pages: pages.length,
    sections: pages.reduce((n, page) => n + (page.sections?.length ?? 0), 0),
    products: p.definition?.preset?.sampleData?.products?.length ?? 0,
    placeholders: (p.assets ?? []).filter(
      (a) => a.licenseNote === PLACEHOLDER_LICENSE_NOTE,
    ).length,
    gaps: (p.capabilityGaps ?? []).map((gap) => ({
      code: String(gap.code ?? ""),
      requestedCapability: String(gap.requestedCapability ?? ""),
      blocking: gap.blocking === true,
    })),
  };
}

export async function getThemeStudioProject(
  projectId: string,
): Promise<ThemeStudioProjectDetail | null> {
  if (!isUuid(projectId)) return null;
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, projectId))
      .limit(1);
    if (!project) return null;
    // Sequential inside one transaction on purpose: they share a client, so
    // Promise.all would serialise them anyway (CODEBASE §22 Step 20).
    const references = await db
      .select({
        id: themeStudioAssets.id,
        width: themeStudioAssets.width,
        height: themeStudioAssets.height,
        byteSize: themeStudioAssets.byteSize,
        originalMediaType: themeStudioAssets.originalMediaType,
        originalByteSize: themeStudioAssets.originalByteSize,
        createdAt: themeStudioAssets.createdAt,
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      )
      .orderBy(asc(themeStudioAssets.createdAt));
    const messages = await db
      .select({
        id: themeStudioMessages.id,
        kind: themeStudioMessages.kind,
        body: themeStudioMessages.body,
        referenceAssetIds: themeStudioMessages.referenceAssetIds,
        createdAt: themeStudioMessages.createdAt,
      })
      .from(themeStudioMessages)
      .where(eq(themeStudioMessages.projectId, projectId))
      .orderBy(asc(themeStudioMessages.createdAt));
    const runs = await db
      .select()
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.projectId, projectId))
      .orderBy(desc(themeStudioRuns.createdAt))
      .limit(50);
    const versions = await db
      .select({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
        parentVersionId: themeStudioVersions.parentVersionId,
        runId: themeStudioVersions.runId,
        origin: themeStudioVersions.origin,
        editDetail: themeStudioVersions.editDetail,
        intentDigest: themeStudioVersions.intentDigest,
        intentJson: themeStudioVersions.intentJson,
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
        createdAt: themeStudioVersions.createdAt,
      })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, projectId))
      .orderBy(desc(themeStudioVersions.versionNumber));
    const previews = await db
      .select({
        id: themeStudioPreviews.id,
        versionId: themeStudioPreviews.versionId,
        status: themeStudioPreviews.status,
        lastOpenedAt: themeStudioPreviews.lastOpenedAt,
        expiresAt: themeStudioPreviews.expiresAt,
      })
      .from(themeStudioPreviews)
      .where(eq(themeStudioPreviews.projectId, projectId))
      .orderBy(desc(themeStudioPreviews.lastOpenedAt));
    const events = await db
      .select()
      .from(themeStudioEvents)
      .where(eq(themeStudioEvents.projectId, projectId))
      .orderBy(desc(themeStudioEvents.createdAt))
      .limit(100);

    const cited = new Set(messages.flatMap((m) => m.referenceAssetIds));
    return {
      id: project.id,
      themeId: project.themeId,
      name: project.name,
      status: project.status as ThemeStudioProjectState,
      modelKey: project.modelKey as ThemeStudioModelKey,
      industries: project.industries as ThemeIndustry[],
      catalogSizes: project.catalogSizes as ThemeCatalogSize[],
      requiredFeatures: project.requiredFeatures as ThemeFeature[],
      baseThemeId: project.baseThemeId,
      draftBrief: project.draftBrief,
      currentVersionId: project.currentVersionId,
      revision: project.revision,
      createdByEmail: project.createdByEmail,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      references: references.map((r) => ({ ...r, cited: cited.has(r.id) })),
      messages: messages.map((m) => ({
        id: m.id,
        kind: m.kind as "brief" | "revision",
        body: m.body,
        referenceCount: m.referenceAssetIds.length,
        createdAt: m.createdAt,
      })),
      runs: runs.map((r) => ({
        ...runExtras(r.usage, r.outcomeDetail),
        id: r.id,
        kind: r.kind as "generate" | "revise",
        status: r.status as ThemeStudioRunView["status"],
        provider: r.provider,
        modelKey: r.modelKey as ThemeStudioModelKey,
        attemptCount: r.attemptCount,
        maxAttempts: r.maxAttempts,
        errorCode: r.errorCode,
        cancelRequested: r.cancelRequestedAt !== null,
        retryOfRunId: r.retryOfRunId,
        baseVersionId: r.baseVersionId,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      versions: versions.map((v) => {
        const summary = intentField(v.intentJson, "summary");
        const assumptions = intentField(v.intentJson, "assumptions");
        return {
          packageSummary: packageSummary(v.packageJson),
          id: v.id,
          versionNumber: v.versionNumber,
          parentVersionId: v.parentVersionId,
          runId: v.runId,
          origin: (v.origin === "asset_edit" ? "asset_edit" : "run") as
            | "run"
            | "asset_edit",
          editedSlots: editedSlots(v.editDetail),
          intentDigest: v.intentDigest,
          packageDigest: v.packageDigest,
          summary: typeof summary === "string" ? summary : "",
          assumptions: Array.isArray(assumptions)
            ? assumptions.filter((a): a is string => typeof a === "string")
            : [],
          hasPackage: v.packageDigest !== null,
          createdAt: v.createdAt,
        };
      }),
      previews: previews.map((p) => ({
        ...p,
        status: p.status as ThemeStudioPreviewView["status"],
      })),
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actorKind: e.actorKind as "operator" | "worker",
        actorEmail: e.actorEmail,
        runId: e.runId,
        detail: (e.detail ?? {}) as Record<string, unknown>,
        createdAt: e.createdAt,
      })),
    };
  });
}

export interface ThemeStudioVersionPackage {
  id: string;
  versionNumber: number;
  parentVersionId: string | null;
  summary: string;
  packageDigest: string | null;
  /** Null when the version is intent-only or its package no longer
   * validates; a caller must not render a package it cannot trust. */
  package: ThemePackageV2 | null;
}

/** One project's versions with their validated packages, for compare. */
export async function getThemeStudioVersionPackages(
  projectId: string,
  versionIds: string[],
): Promise<ThemeStudioVersionPackage[]> {
  const ids = [...new Set(versionIds)].filter(isUuid).slice(0, 4);
  if (!isUuid(projectId) || ids.length === 0) return [];
  const rows = await withService((db) =>
    db
      .select({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
        parentVersionId: themeStudioVersions.parentVersionId,
        intentJson: themeStudioVersions.intentJson,
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.projectId, projectId),
          inArray(themeStudioVersions.id, ids),
        ),
      ),
  );
  return rows.map((row) => {
    const summary = intentField(row.intentJson, "summary");
    const parsed = row.packageJson
      ? validateThemePackageV2(row.packageJson)
      : null;
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      parentVersionId: row.parentVersionId,
      summary: typeof summary === "string" ? summary : "",
      packageDigest: row.packageDigest,
      package: parsed?.ok ? parsed.value : null,
    };
  });
}

async function assetBytes(
  assetId: string,
  purpose: "reference" | "placeholder" | "image",
): Promise<{ bytes: Buffer; mediaType: string } | null> {
  if (!isUuid(assetId)) return null;
  const rows = await withService((db) =>
    db
      .select({
        bytes: themeStudioAssets.bytes,
        mediaType: themeStudioAssets.mediaType,
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.id, assetId),
          eq(themeStudioAssets.purpose, purpose),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/** A sanitized reference, for the superadmin-gated reference route. */
export function getThemeStudioReferenceBytes(assetId: string) {
  return assetBytes(assetId, "reference");
}

/** A server-rendered placeholder, for the PUBLIC placeholder route. ★ The
 * purpose filter is the whole boundary: a reference id sent to that route
 * must find nothing, because references are someone else's website. */
export function getThemeStudioPlaceholderBytes(assetId: string) {
  return assetBytes(assetId, "placeholder");
}

/** An operator-uploaded slot image, for the PUBLIC image route. Meant for
 * publication by definition; the purpose filter still keeps references out. */
export function getThemeStudioSlotImageBytes(assetId: string) {
  return assetBytes(assetId, "image");
}

// ------------------------------------------------------------------- writes

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,80}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

async function recordEvent(
  db: Db,
  input: {
    projectId: string;
    runId?: string | null;
    actor: ThemeStudioActor | "worker";
    eventType: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(themeStudioEvents).values({
    projectId: input.projectId,
    runId: input.runId ?? null,
    actorKind: input.actor === "worker" ? "worker" : "operator",
    actorId: input.actor === "worker" ? null : input.actor.id,
    actorEmail: input.actor === "worker" ? null : input.actor.email,
    eventType: input.eventType,
    detail: input.detail ?? {},
  });
}
export { recordEvent as recordThemeStudioEvent };

/** Per-actor advisory lock, so two tabs racing a daily or concurrency cap
 * serialise on the COUNT instead of both reading the same headroom. */
async function lockActor(db: Db, scope: string, actorId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`theme-studio:${scope}:${actorId}`}))`,
  );
}

function pickFrom<T extends string>(
  values: unknown,
  allowed: readonly T[],
  { min, max }: { min: number; max: number },
  label: string,
): T[] {
  const list = Array.isArray(values) ? values : [];
  const out = [...new Set(list)].filter((v): v is T =>
    allowed.includes(v as T),
  );
  if (out.length !== new Set(list).size) {
    throw new ThemeStudioError(
      "invalid_input",
      `${label} contains an unknown value.`,
    );
  }
  if (out.length < min || out.length > max) {
    throw new ThemeStudioError(
      "invalid_input",
      min > 0
        ? `Choose between ${min} and ${max} ${label}.`
        : `Choose at most ${max} ${label}.`,
    );
  }
  return out;
}

export interface CreateThemeStudioProjectInput {
  name: unknown;
  themeId: unknown;
  brief: unknown;
  industries: unknown;
  catalogSizes: unknown;
  requiredFeatures: unknown;
  baseThemeId: unknown;
  modelKey: unknown;
}

export interface ValidatedProjectInput {
  name: string;
  themeId: string;
  brief: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  baseThemeId: string | null;
  modelKey: ThemeStudioModelKey;
}

/** Pure validation, shared by the action and its tests. */
export function validateProjectInput(
  input: CreateThemeStudioProjectInput,
): ValidatedProjectInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) {
    throw new ThemeStudioError(
      "invalid_input",
      "Give the theme a name of up to 100 characters.",
    );
  }
  const themeId =
    typeof input.themeId === "string" ? input.themeId.trim().toLowerCase() : "";
  if (themeId.length < 3 || themeId.length > 80 || !THEME_ID_RE.test(themeId)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The theme id must be 3–80 lowercase letters, numbers and single hyphens.",
    );
  }
  if (themeId.startsWith("demo-")) {
    throw new ThemeStudioError(
      "invalid_input",
      "Theme ids may not start with demo-.",
    );
  }
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";
  if (!brief || brief.length > THEME_STUDIO_LIMITS.promptChars) {
    throw new ThemeStudioError(
      "invalid_input",
      `Write a design brief of up to ${THEME_STUDIO_LIMITS.promptChars.toLocaleString("en-IN")} characters.`,
    );
  }
  const modelKey = parseThemeStudioModelKey(input.modelKey);
  if (!modelKey) {
    throw new ThemeStudioError(
      "invalid_input",
      "Choose one of the listed models.",
    );
  }
  let baseThemeId: string | null = null;
  if (
    input.baseThemeId !== null &&
    input.baseThemeId !== undefined &&
    input.baseThemeId !== ""
  ) {
    if (!isBundledThemeId(input.baseThemeId)) {
      throw new ThemeStudioError(
        "invalid_input",
        "Choose a listed base theme or none.",
      );
    }
    baseThemeId = input.baseThemeId;
  }
  return {
    name,
    themeId,
    brief,
    industries: pickFrom(
      input.industries,
      THEME_STUDIO_INDUSTRIES,
      { min: 1, max: 5 },
      "industries",
    ),
    catalogSizes: pickFrom(
      input.catalogSizes,
      THEME_STUDIO_CATALOG_SIZES,
      { min: 1, max: 4 },
      "catalog sizes",
    ),
    requiredFeatures: pickFrom(
      input.requiredFeatures,
      THEME_STUDIO_FEATURES,
      { min: 0, max: 10 },
      "features",
    ),
    baseThemeId,
    modelKey,
  };
}

export async function createThemeStudioProject(
  actor: ThemeStudioActor,
  input: ValidatedProjectInput,
): Promise<{ id: string }> {
  // A new theme id must not shadow a bundled theme or any runtime release,
  // including a hidden or unpublished one: publication would otherwise be
  // an attempt to overwrite somebody else's release line.
  if (isBundledThemeId(input.themeId)) {
    throw new ThemeStudioError(
      "theme_id_taken",
      "That id belongs to a bundled theme.",
    );
  }
  try {
    return await withService(async (db) => {
      await lockActor(db, "projects", actor.id);
      const [{ n }] = await db
        .select({ n: count() })
        .from(themeStudioProjects)
        .where(
          and(
            eq(themeStudioProjects.createdBy, actor.id),
            sql`${themeStudioProjects.createdAt} > now() - interval '24 hours'`,
          ),
        );
      if (Number(n) >= THEME_STUDIO_LIMITS.projectsPerOperatorPerDay) {
        throw new ThemeStudioError(
          "limit",
          `You can start at most ${THEME_STUDIO_LIMITS.projectsPerOperatorPerDay} projects a day.`,
        );
      }
      const [released] = await db
        .select({ id: themeReleases.id })
        .from(themeReleases)
        .where(eq(themeReleases.themeId, input.themeId))
        .limit(1);
      const [listed] = await db
        .select({ id: themeCatalogEntries.themeId })
        .from(themeCatalogEntries)
        .where(eq(themeCatalogEntries.themeId, input.themeId))
        .limit(1);
      if (released || listed) {
        throw new ThemeStudioError(
          "theme_id_taken",
          "That id already has a theme release.",
        );
      }
      const [project] = await db
        .insert(themeStudioProjects)
        .values({
          themeId: input.themeId,
          name: input.name,
          industries: input.industries,
          catalogSizes: input.catalogSizes,
          requiredFeatures: input.requiredFeatures,
          baseThemeId: input.baseThemeId,
          modelKey: input.modelKey,
          draftBrief: input.brief,
          createdBy: actor.id,
          createdByEmail: actor.email,
        })
        .returning({ id: themeStudioProjects.id });
      await recordEvent(db, {
        projectId: project.id,
        actor,
        eventType: "project_created",
        detail: { themeId: input.themeId, modelKey: input.modelKey },
      });
      return { id: project.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ThemeStudioError(
        "theme_id_taken",
        "Another active project already uses that id.",
      );
    }
    throw error;
  }
}

async function lockProject(db: Db, projectId: string) {
  const rows = await db
    .select()
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .for("update")
    .limit(1);
  const project = rows[0];
  if (!project)
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  return project;
}

const EDITABLE_REFERENCE_STATES: readonly string[] = [
  "draft",
  "ready",
  "failed",
  "blocked",
];

export async function addThemeStudioReference(
  actor: ThemeStudioActor,
  projectId: string,
  reference: SanitizedReference,
): Promise<{ id: string; duplicate: boolean }> {
  if (!isUuid(projectId))
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  return withService(async (db) => {
    const project = await lockProject(db, projectId);
    if (!EDITABLE_REFERENCE_STATES.includes(project.status)) {
      throw new ThemeStudioError(
        "illegal_state",
        "References can't change while a run is active or after the project is closed.",
      );
    }
    const [existing] = await db
      .select({ id: themeStudioAssets.id })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "reference"),
          eq(themeStudioAssets.sha256, reference.sha256),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, duplicate: true };

    const [totals] = await db
      .select({
        n: count(),
        bytes: sum(themeStudioAssets.originalByteSize),
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      );
    if (Number(totals?.n ?? 0) >= THEME_STUDIO_LIMITS.referenceImages) {
      throw new ThemeStudioError(
        "limit",
        `A project can hold at most ${THEME_STUDIO_LIMITS.referenceImages} references.`,
      );
    }
    if (
      Number(totals?.bytes ?? 0) + reference.originalByteSize >
      THEME_STUDIO_LIMITS.referenceTotalBytes
    ) {
      throw new ThemeStudioError(
        "limit",
        `References for one project may total at most ${THEME_STUDIO_LIMITS.referenceTotalBytes / 1024 / 1024} MB.`,
      );
    }
    const [asset] = await db
      .insert(themeStudioAssets)
      .values({
        projectId,
        mediaType: reference.mediaType,
        bytes: reference.bytes,
        byteSize: reference.bytes.byteLength,
        width: reference.width,
        height: reference.height,
        sha256: reference.sha256,
        originalMediaType: reference.originalMediaType,
        originalByteSize: reference.originalByteSize,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioAssets.id });
    await recordEvent(db, {
      projectId,
      actor,
      eventType: "reference_added",
      detail: {
        assetId: asset.id,
        sha256: reference.sha256,
        width: reference.width,
        height: reference.height,
      },
    });
    return { id: asset.id, duplicate: false };
  });
}

export async function removeThemeStudioReference(
  actor: ThemeStudioActor,
  projectId: string,
  assetId: string,
): Promise<void> {
  if (!isUuid(projectId) || !isUuid(assetId)) {
    throw new ThemeStudioError("not_found", "That reference no longer exists.");
  }
  await withService(async (db) => {
    const project = await lockProject(db, projectId);
    if (!EDITABLE_REFERENCE_STATES.includes(project.status)) {
      throw new ThemeStudioError(
        "illegal_state",
        "References can't change right now.",
      );
    }
    const [citing] = await db
      .select({ id: themeStudioMessages.id })
      .from(themeStudioMessages)
      .where(
        and(
          eq(themeStudioMessages.projectId, projectId),
          sql`${themeStudioMessages.referenceAssetIds} @> ARRAY[${assetId}::uuid]`,
        ),
      )
      .limit(1);
    if (citing) {
      throw new ThemeStudioError(
        "illegal_state",
        "That reference was sent with a generation request, so it is kept with that history.",
      );
    }
    const deleted = await db
      .delete(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.id, assetId),
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      )
      .returning({ id: themeStudioAssets.id });
    if (deleted.length === 0) {
      throw new ThemeStudioError(
        "not_found",
        "That reference no longer exists.",
      );
    }
    await recordEvent(db, {
      projectId,
      actor,
      eventType: "reference_removed",
      detail: { assetId },
    });
  });
}

function resolveProviderForQueue(modelKey: ThemeStudioModelKey) {
  const config = getThemeStudioConfig();
  if (!config.generationEnabled) {
    throw new ThemeStudioError(
      "generation_disabled",
      "Theme generation is switched off platform-wide right now.",
    );
  }
  if (!isImplementedProvider(config.provider)) {
    throw new ThemeStudioError(
      "provider_unavailable",
      "No theme generation provider is available in this environment.",
    );
  }
  if (config.disabledModels.has(modelKey)) {
    throw new ThemeStudioError(
      "provider_unavailable",
      "That model is switched off in this environment. Nothing was queued.",
    );
  }
  if (config.provider === "vertex-gemini" && !getVertexConfig()) {
    throw new ThemeStudioError(
      "provider_unavailable",
      "Vertex AI is not configured in this environment.",
    );
  }
  // Resolve the model even for the fake provider, so an invalid deployment
  // override fails the queue here rather than silently at run time.
  const model = resolveThemeStudioModel(modelKey);
  return {
    provider: config.provider,
    providerModel: config.provider === "fake" ? "fake" : model.providerModel,
    promptVersion:
      config.provider === "fake"
        ? THEME_STUDIO_FAKE_PROMPT_VERSION
        : THEME_STUDIO_PROMPT_VERSION,
    dailySpendMicroUsd: config.dailySpendMicroUsd,
  };
}

/** Estimated model spend this operator started in the last 24 hours. Only a
 * paid provider counts; the offline provider records zero. */
async function assertSpendHeadroom(
  db: Db,
  actor: ThemeStudioActor,
  resolved: ReturnType<typeof resolveProviderForQueue>,
) {
  if (resolved.provider === "fake") return;
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum((${themeStudioRuns.usage} ->> 'estimatedCostMicroUsd')::bigint), 0)`,
    })
    .from(themeStudioRuns)
    .where(
      and(
        eq(themeStudioRuns.createdBy, actor.id),
        sql`${themeStudioRuns.createdAt} > now() - interval '24 hours'`,
      ),
    );
  if (Number(row?.spent ?? 0) >= resolved.dailySpendMicroUsd) {
    throw new ThemeStudioError(
      "limit",
      "You have reached today's Theme Studio spending limit. Try again tomorrow.",
    );
  }
}

async function assertRunCapacity(db: Db, actor: ThemeStudioActor) {
  await lockActor(db, "runs", actor.id);
  const [{ n }] = await db
    .select({ n: count() })
    .from(themeStudioRuns)
    .where(
      and(
        eq(themeStudioRuns.createdBy, actor.id),
        inArray(themeStudioRuns.status, ["queued", "running"]),
      ),
    );
  if (Number(n) >= THEME_STUDIO_LIMITS.concurrentRunsPerOperator) {
    throw new ThemeStudioError(
      "limit",
      `You can have at most ${THEME_STUDIO_LIMITS.concurrentRunsPerOperator} generations running at once.`,
    );
  }
}

/** Submit the draft brief. Snapshots brief + every current reference into an
 * immutable message and queues one run against it. Idempotent on the key. */
export async function queueThemeStudioGeneration(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
    idempotencyKey: string;
  },
): Promise<{ runId: string; duplicate: boolean }> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  if (!IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    const [prior] = await db
      .select({ id: themeStudioRuns.id, projectId: themeStudioRuns.projectId })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (prior) {
      if (prior.projectId !== project.id) {
        throw new ThemeStudioError(
          "invalid_input",
          "The request is malformed. Reload and try again.",
        );
      }
      return { runId: prior.id, duplicate: true };
    }
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (project.status !== "draft") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only a draft project can start its first generation.",
      );
    }
    const resolved = resolveProviderForQueue(
      project.modelKey as ThemeStudioModelKey,
    );
    await assertRunCapacity(db, actor);
    await assertSpendHeadroom(db, actor, resolved);

    const refs = await db
      .select({ id: themeStudioAssets.id })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      )
      .orderBy(asc(themeStudioAssets.createdAt));
    const [message] = await db
      .insert(themeStudioMessages)
      .values({
        projectId: project.id,
        kind: "brief",
        body: project.draftBrief,
        referenceAssetIds: refs.map((r) => r.id),
        createdBy: actor.id,
      })
      .returning({ id: themeStudioMessages.id });
    const [run] = await db
      .insert(themeStudioRuns)
      .values({
        projectId: project.id,
        messageId: message.id,
        kind: "generate",
        provider: resolved.provider,
        modelKey: project.modelKey,
        providerModel: resolved.providerModel,
        promptVersion: resolved.promptVersion,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1 + THEME_STUDIO_LIMITS.modelRetries,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioRuns.id });
    await db
      .update(themeStudioProjects)
      .set({ status: "generating", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      runId: run.id,
      actor,
      eventType: "run_queued",
      detail: {
        provider: resolved.provider,
        modelKey: project.modelKey,
        references: refs.length,
      },
    });
    return { runId: run.id, duplicate: false };
  });
}

async function lockRun(db: Db, projectId: string, runId: string) {
  const rows = await db
    .select()
    .from(themeStudioRuns)
    .where(
      and(
        eq(themeStudioRuns.id, runId),
        eq(themeStudioRuns.projectId, projectId),
      ),
    )
    .for("update")
    .limit(1);
  const run = rows[0];
  if (!run)
    throw new ThemeStudioError("not_found", "That run no longer exists.");
  return run;
}

/** The status a project returns to when its active run ends without a new
 * version: its last good version if it has one, otherwise `failed`. Both are
 * legal from `generating`. */
function restingState(
  currentVersionId: string | null,
): ThemeStudioProjectState {
  return currentVersionId ? "ready" : "failed";
}

export async function cancelThemeStudioRun(
  actor: ThemeStudioActor,
  input: { projectId: string; runId: string },
): Promise<{ status: "cancelled" | "cancel_requested" }> {
  if (!isUuid(input.projectId) || !isUuid(input.runId)) {
    throw new ThemeStudioError("not_found", "That run no longer exists.");
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    const run = await lockRun(db, project.id, input.runId);
    if (run.status === "queued") {
      await db
        .update(themeStudioRuns)
        .set({
          status: "cancelled",
          cancelRequestedAt: sql`now()`,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(themeStudioRuns.id, run.id));
      await db
        .update(themeStudioProjects)
        .set({
          status: restingState(project.currentVersionId),
          revision: project.revision + 1,
        })
        .where(eq(themeStudioProjects.id, project.id));
      await recordEvent(db, {
        projectId: project.id,
        runId: run.id,
        actor,
        eventType: "run_cancelled",
      });
      return { status: "cancelled" as const };
    }
    if (run.status === "running") {
      if (!run.cancelRequestedAt) {
        await db
          .update(themeStudioRuns)
          .set({ cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(themeStudioRuns.id, run.id));
        await recordEvent(db, {
          projectId: project.id,
          runId: run.id,
          actor,
          eventType: "run_cancel_requested",
        });
      }
      return { status: "cancel_requested" as const };
    }
    throw new ThemeStudioError(
      "illegal_state",
      "That run has already finished.",
    );
  });
}

export async function retryThemeStudioRun(
  actor: ThemeStudioActor,
  input: { projectId: string; runId: string; idempotencyKey: string },
): Promise<{ runId: string; duplicate: boolean }> {
  if (!isUuid(input.projectId) || !isUuid(input.runId)) {
    throw new ThemeStudioError("not_found", "That run no longer exists.");
  }
  if (!IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    const [prior] = await db
      .select({ id: themeStudioRuns.id, projectId: themeStudioRuns.projectId })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (prior) {
      if (prior.projectId !== project.id) {
        throw new ThemeStudioError(
          "invalid_input",
          "The request is malformed. Reload and try again.",
        );
      }
      return { runId: prior.id, duplicate: true };
    }
    const run = await lockRun(db, project.id, input.runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only a failed or cancelled run can be retried.",
      );
    }
    if (project.status !== "failed" && project.status !== "ready") {
      throw new ThemeStudioError(
        "illegal_state",
        "This project can't start a run right now.",
      );
    }
    const resolved = resolveProviderForQueue(
      project.modelKey as ThemeStudioModelKey,
    );
    await assertRunCapacity(db, actor);
    await assertSpendHeadroom(db, actor, resolved);
    const [retry] = await db
      .insert(themeStudioRuns)
      .values({
        projectId: project.id,
        messageId: run.messageId,
        kind: run.kind,
        provider: resolved.provider,
        modelKey: project.modelKey,
        providerModel: resolved.providerModel,
        promptVersion: resolved.promptVersion,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1 + THEME_STUDIO_LIMITS.modelRetries,
        retryOfRunId: run.id,
        // A retried revision revises the same version with the same messages.
        baseVersionId: run.baseVersionId,
        basePackageDigest: run.basePackageDigest,
        contextMessageIds: run.contextMessageIds,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioRuns.id });
    await db
      .update(themeStudioProjects)
      .set({ status: "generating", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      runId: retry.id,
      actor,
      eventType: "run_retried",
      detail: { retryOfRunId: run.id },
    });
    return { runId: retry.id, duplicate: false };
  });
}

/** Answer the model's clarifying questions. Only a project the model paused
 * (`blocked` after a clarify outcome) takes details; the answer becomes an
 * immutable message citing the current references, and a new run reads every
 * message so far. */
export async function submitThemeStudioDetails(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
    body: string;
    idempotencyKey: string;
  },
): Promise<{ runId: string; duplicate: boolean }> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  if (!IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > THEME_STUDIO_LIMITS.promptChars) {
    throw new ThemeStudioError(
      "invalid_input",
      `Write your answer in up to ${THEME_STUDIO_LIMITS.promptChars.toLocaleString("en-IN")} characters.`,
    );
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    const [prior] = await db
      .select({ id: themeStudioRuns.id, projectId: themeStudioRuns.projectId })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (prior) {
      if (prior.projectId !== project.id) {
        throw new ThemeStudioError(
          "invalid_input",
          "The request is malformed. Reload and try again.",
        );
      }
      return { runId: prior.id, duplicate: true };
    }
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (project.status !== "blocked") {
      throw new ThemeStudioError(
        "illegal_state",
        "This project isn't waiting for more details.",
      );
    }
    const resolved = resolveProviderForQueue(
      project.modelKey as ThemeStudioModelKey,
    );
    // ★ The questions may have come from a REVISION. Answering them continues
    // that revision — same base version, its messages plus this answer — not a
    // fresh generation that would discard the version being revised.
    const [asked] = await db
      .select({
        kind: themeStudioRuns.kind,
        baseVersionId: themeStudioRuns.baseVersionId,
        basePackageDigest: themeStudioRuns.basePackageDigest,
        contextMessageIds: themeStudioRuns.contextMessageIds,
      })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.projectId, project.id))
      .orderBy(desc(themeStudioRuns.createdAt))
      .limit(1);
    const continuing = asked?.kind === "revise" ? asked : null;
    if (
      continuing &&
      continuing.contextMessageIds.length >= MAX_REVISION_MESSAGES
    ) {
      throw new ThemeStudioError(
        "limit",
        "This revision has had too many rounds of questions. Start a new revision instead.",
      );
    }
    await assertRunCapacity(db, actor);
    await assertSpendHeadroom(db, actor, resolved);
    const refs = await db
      .select({ id: themeStudioAssets.id })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      )
      .orderBy(asc(themeStudioAssets.createdAt));
    const [message] = await db
      .insert(themeStudioMessages)
      .values({
        projectId: project.id,
        kind: "revision",
        body,
        referenceAssetIds: refs.map((r) => r.id),
        createdBy: actor.id,
      })
      .returning({ id: themeStudioMessages.id });
    const [run] = await db
      .insert(themeStudioRuns)
      .values({
        projectId: project.id,
        messageId: message.id,
        kind: continuing ? "revise" : "generate",
        baseVersionId: continuing?.baseVersionId ?? null,
        basePackageDigest: continuing?.basePackageDigest ?? null,
        contextMessageIds: continuing
          ? [...continuing.contextMessageIds, message.id]
          : [],
        provider: resolved.provider,
        modelKey: project.modelKey,
        providerModel: resolved.providerModel,
        promptVersion: resolved.promptVersion,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1 + THEME_STUDIO_LIMITS.modelRetries,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioRuns.id });
    await db
      .update(themeStudioProjects)
      .set({ status: "generating", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      runId: run.id,
      actor,
      eventType: "details_added",
      detail: { messageId: message.id, references: refs.length },
    });
    return { runId: run.id, duplicate: false };
  });
}

/** A revision reads at most this many messages: the request plus answers.
 * Mirrors the cardinality bound in theme_studio_runs_base_check. */
const MAX_REVISION_MESSAGES = 20;

/** States a version can be revised from. Each may move to `generating`. */
const REVISABLE_STATES: readonly ThemeStudioProjectState[] = [
  "ready",
  "candidate",
  "approved",
];

/**
 * Ask for a revision of one version. Bound to that version and to the content
 * address the operator was looking at; revising a version that is not the
 * current one is how a branch starts, and the new version's parent is the
 * version revised. Idempotent on the key; refused if the project moved on.
 */
export async function reviseThemeStudioVersion(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    versionId: string;
    expectedRevision: number;
    expectedPackageDigest: string;
    body: string;
    idempotencyKey: string;
  },
): Promise<{ runId: string; duplicate: boolean }> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  if (!IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > THEME_STUDIO_LIMITS.promptChars) {
    throw new ThemeStudioError(
      "invalid_input",
      `Describe the change in up to ${THEME_STUDIO_LIMITS.promptChars.toLocaleString("en-IN")} characters.`,
    );
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    const [prior] = await db
      .select({ id: themeStudioRuns.id, projectId: themeStudioRuns.projectId })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (prior) {
      if (prior.projectId !== project.id) {
        throw new ThemeStudioError(
          "invalid_input",
          "The request is malformed. Reload and try again.",
        );
      }
      return { runId: prior.id, duplicate: true };
    }
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (!REVISABLE_STATES.includes(project.status as ThemeStudioProjectState)) {
      throw new ThemeStudioError(
        "illegal_state",
        "This project can't start a revision right now.",
      );
    }
    const [version] = await db
      .select({
        id: themeStudioVersions.id,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!version) {
      throw new ThemeStudioError("not_found", "That version no longer exists.");
    }
    if (!version.packageDigest) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version has no theme to revise.",
      );
    }
    // Versions are immutable, so this only fails when the browser's copy of
    // the version is not the one on the server — which is exactly the case in
    // which the operator would be revising something they have not seen.
    if (version.packageDigest !== input.expectedPackageDigest) {
      throw new ThemeStudioError(
        "stale",
        "That version is not the one on your screen. Reload to see it.",
      );
    }
    const resolved = resolveProviderForQueue(
      project.modelKey as ThemeStudioModelKey,
    );
    await assertRunCapacity(db, actor);
    await assertSpendHeadroom(db, actor, resolved);
    const refs = await db
      .select({ id: themeStudioAssets.id })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          eq(themeStudioAssets.purpose, "reference"),
        ),
      )
      .orderBy(asc(themeStudioAssets.createdAt));
    const [message] = await db
      .insert(themeStudioMessages)
      .values({
        projectId: project.id,
        kind: "revision",
        body,
        referenceAssetIds: refs.map((r) => r.id),
        createdBy: actor.id,
      })
      .returning({ id: themeStudioMessages.id });
    const [run] = await db
      .insert(themeStudioRuns)
      .values({
        projectId: project.id,
        messageId: message.id,
        kind: "revise",
        baseVersionId: version.id,
        basePackageDigest: version.packageDigest,
        contextMessageIds: [message.id],
        provider: resolved.provider,
        modelKey: project.modelKey,
        providerModel: resolved.providerModel,
        promptVersion: resolved.promptVersion,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1 + THEME_STUDIO_LIMITS.modelRetries,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioRuns.id });
    await db
      .update(themeStudioProjects)
      .set({ status: "generating", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      runId: run.id,
      actor,
      eventType: "revision_requested",
      detail: {
        versionId: version.id,
        messageId: message.id,
        references: refs.length,
        branch: version.id !== project.currentVersionId,
      },
    });
    return { runId: run.id, duplicate: false };
  });
}

/**
 * Make an earlier version current again. Nothing is copied or deleted —
 * versions are immutable — so restoring is only a pointer move, and the
 * version that was current stays one click away. From `blocked` (a revision
 * waiting on answers) it also sets those questions aside.
 */
export async function restoreThemeStudioVersion(
  actor: ThemeStudioActor,
  input: { projectId: string; versionId: string; expectedRevision: number },
): Promise<{ changed: boolean }> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  return withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    // A candidate may be restored too: changing the current version drops it
    // back to ready, because its acceptance evidence covered another version.
    if (
      project.status !== "ready" &&
      project.status !== "blocked" &&
      project.status !== "candidate"
    ) {
      throw new ThemeStudioError(
        "illegal_state",
        project.status === "generating"
          ? "Wait for the active run to finish, or cancel it, before restoring."
          : "This project can't change its current version right now.",
      );
    }
    const [version] = await db
      .select({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!version) {
      throw new ThemeStudioError("not_found", "That version no longer exists.");
    }
    if (!version.packageDigest) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version has no theme to restore.",
      );
    }
    if (
      version.id === project.currentVersionId &&
      (project.status === "ready" || project.status === "candidate")
    ) {
      return { changed: false };
    }
    await db
      .update(themeStudioProjects)
      .set({
        status: "ready",
        currentVersionId: version.id,
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      actor,
      eventType: "version_restored",
      detail: {
        versionId: version.id,
        versionNumber: version.versionNumber,
        previousVersionId: project.currentVersionId,
      },
    });
    return { changed: true };
  });
}

export async function archiveThemeStudioProject(
  actor: ThemeStudioActor,
  input: { projectId: string; expectedRevision: number },
): Promise<void> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  await withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (project.status === "generating") {
      throw new ThemeStudioError(
        "illegal_state",
        "Cancel the active run before archiving.",
      );
    }
    if (project.status === "archived") return;
    await db
      .update(themeStudioProjects)
      .set({
        status: "archived",
        archivedAt: sql`now()`,
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, project.id));
    await recordEvent(db, {
      projectId: project.id,
      actor,
      eventType: "project_archived",
    });
  });
}

/** Content address for an intent, key-order independent (jsonb reorders). */
export function digestThemeStudioJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
