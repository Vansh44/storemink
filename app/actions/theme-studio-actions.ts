"use server";

// ---------------------------------------------------------------------------
// Mink AI Theme Studio — operator mutations (Phase 2).
//
// ★ EVERY EXPORT HERE IS A PUBLIC POST ENDPOINT. A server action can be called
// without the page that renders its button, so each one re-derives the actor
// from the session (`getThemeStudioActor`, superadmin only) before touching
// anything. The page gate is a courtesy; this is the boundary.
//
// ★ These are thin adapters. Validation, locking, caps and idempotency live in
// lib/theme-studio/repository.ts, which is deliberately NOT a "use server"
// module — its reads are platform-wide and must not be reachable directly.
//
// ★ Nothing here accepts an actor id, a provider model id, a file path or a
// run's inputs. The browser names a project, a run, a model KEY and an
// idempotency key; everything else is server-owned.
// ---------------------------------------------------------------------------

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  archiveThemeStudioProject,
  cancelThemeStudioRun,
  createThemeStudioProject,
  queueThemeStudioGeneration,
  removeThemeStudioReference,
  restoreThemeStudioVersion,
  retryThemeStudioRun,
  reviseThemeStudioVersion,
  submitThemeStudioDetails,
  ThemeStudioError,
  validateProjectInput,
  type CreateThemeStudioProjectInput,
} from "@/lib/theme-studio/repository";
import {
  discardProjectPreviews,
  openThemeStudioPreview,
  type OpenedPreview,
} from "@/lib/theme-studio/preview";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";
import {
  startThemeStudioAcceptance,
  submitThemeStudioBrowserEvidence,
  type AcceptanceBrowserPlan,
} from "@/lib/theme-studio/acceptance";

export interface ThemeStudioActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const NOT_AUTHORIZED: ThemeStudioActionResult = {
  ok: false,
  error: "Only a platform superadmin can use Theme Studio.",
};

const STUDIO_PATH = "/dashboard/themes/studio";

function failure(error: unknown, context: string): ThemeStudioActionResult {
  if (error instanceof ThemeStudioError)
    return { ok: false, error: error.message };
  logError(`theme studio: ${context} failed`, error);
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

/** Kick the in-process worker after the response. The per-minute heartbeat is
 * the durable backstop if this instance is recycled first. */
function kickWorker() {
  after(async () => {
    try {
      // Offline runs only: they finish instantly. A model run takes minutes
      // and is executed by the dedicated worker route instead.
      await runThemeStudioWorker({
        maxRuns: 2,
        budgetMs: 20_000,
        providers: ["fake"],
      });
    } catch (error) {
      logError("theme studio: after-response worker failed", error);
    }
  });
}

export async function createThemeStudioProjectAction(
  input: CreateThemeStudioProjectInput,
): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const valid = validateProjectInput(input);
    const { id } = await createThemeStudioProject(actor, valid);
    revalidatePath(STUDIO_PATH);
    return { ok: true, id };
  } catch (error) {
    return failure(error, "create project");
  }
}

export async function queueThemeStudioGenerationAction(input: {
  projectId: string;
  expectedRevision: number;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    const { runId } = await queueThemeStudioGeneration(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "queue generation");
  }
}

export async function cancelThemeStudioRunAction(input: {
  projectId: string;
  runId: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    await cancelThemeStudioRun(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "cancel run");
  }
}

export async function retryThemeStudioRunAction(input: {
  projectId: string;
  runId: string;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const { runId } = await retryThemeStudioRun(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "retry run");
  }
}

/** Answer the model's clarifying questions and regenerate. */
export async function submitThemeStudioDetailsAction(input: {
  projectId: string;
  expectedRevision: number;
  body: string;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    const { runId } = await submitThemeStudioDetails(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
      body: String(input.body ?? ""),
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "submit details");
  }
}

export async function removeThemeStudioReferenceAction(input: {
  projectId: string;
  assetId: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    await removeThemeStudioReference(
      actor,
      String(input.projectId),
      String(input.assetId),
    );
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "remove reference");
  }
}

export async function archiveThemeStudioProjectAction(input: {
  projectId: string;
  expectedRevision: number;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    await archiveThemeStudioProject(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
    });
    // An archived project keeps no previews. The heartbeat sweep is the
    // backstop if this instance is recycled before the discard runs.
    const projectId = String(input.projectId);
    after(async () => {
      try {
        await discardProjectPreviews(projectId);
      } catch (error) {
        logError("theme studio: preview discard failed", error);
      }
    });
    revalidatePath(STUDIO_PATH);
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "archive project");
  }
}

const MALFORMED: ThemeStudioActionResult = {
  ok: false,
  error: "The request is malformed. Reload and try again.",
};

/** Ask for a revision of one version (the current one, or an older one to
 * branch from). Bound to the version's content address on screen. */
export async function reviseThemeStudioVersionAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
  expectedPackageDigest: string;
  body: string;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const { runId } = await reviseThemeStudioVersion(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
      expectedPackageDigest: String(input.expectedPackageDigest ?? ""),
      body: String(input.body ?? ""),
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "revise version");
  }
}

/** Make an earlier version current again. */
export async function restoreThemeStudioVersionAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    await restoreThemeStudioVersion(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "restore version");
  }
}

/** Open a version's private preview, building it first if needed. Returns a
 * ten-minute token to enter it — never the grant itself, which is issued on
 * the preview host so it can be host-only. */
export async function openThemeStudioPreviewAction(input: {
  projectId: string;
  versionId: string;
}): Promise<ThemeStudioActionResult & { preview?: OpenedPreview }> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const preview = await openThemeStudioPreview(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
    });
    return { ok: true, id: preview.previewId, preview };
  } catch (error) {
    return failure(error, "open preview");
  }
}

/**
 * Run the automated acceptance gates on the project's current version. The
 * server stage runs inside this request; when it returns a plan, the browser
 * stage runs in the operator's page and reports back through the next action.
 * The operator's own session cookie travels with the server's page fetches,
 * because the preview gate requires it wherever the session is shared.
 */
export async function startThemeStudioAcceptanceAction(input: {
  projectId: string;
  versionId: string;
}): Promise<
  ThemeStudioActionResult & {
    status?: "awaiting_browser" | "failed" | "blocked";
    plan?: AcceptanceBrowserPlan | null;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const jar = await cookies();
    const result = await startThemeStudioAcceptance(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      sessionCookie: jar.get(SESSION_COOKIE)?.value ?? null,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return {
      ok: true,
      id: result.runId,
      status: result.status,
      plan: result.plan,
    };
  } catch (error) {
    return failure(error, "start acceptance");
  }
}

/** Submit the browser stage's raw measurements. The verdict is computed on
 * the server; nothing the browser claims about passing is read. */
export async function submitThemeStudioBrowserEvidenceAction(input: {
  projectId: string;
  runId: string;
  nonce: string;
  evidence: unknown;
}): Promise<
  ThemeStudioActionResult & { status?: "passed" | "failed" | "blocked" }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const result = await submitThemeStudioBrowserEvidence(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
      nonce: input.nonce,
      evidence: input.evidence,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return { ok: true, id: input.runId, status: result.status };
  } catch (error) {
    return failure(error, "submit browser evidence");
  }
}
