import "server-only";
import { eq, and, isNull, sql } from "drizzle-orm";
import { themeStudioRuns } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { validateThemePackageV2, validateThemeIntent } from "./contracts";
import {
  readVarietyContext,
  themeFingerprint,
  type ExistingThemeFingerprint,
} from "./fingerprint";

/** Snapshot once before any model call, so a changing catalogue never changes
 * the request digest during cooldown/reclaim. No copy, photos or other tenants. */
export async function loadVarietyContext(
  db: Db,
  runId: string,
  projectId: string,
  themeId: string,
): Promise<ExistingThemeFingerprint[]> {
  const [run] = await db
    .select({ context: themeStudioRuns.varietyContext })
    .from(themeStudioRuns)
    .where(eq(themeStudioRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Variety run missing.");
  if (run.context !== null) {
    const saved = readVarietyContext(run.context);
    if (!saved) throw new Error("Invalid frozen variety context.");
    return saved;
  }
  const recent = await db.execute(sql`
    SELECT theme_id, package_json, intent_json FROM (
      SELECT DISTINCT ON (v.project_id) p.theme_id, v.package_json, v.intent_json, v.created_at
      FROM theme_studio_versions v JOIN theme_studio_projects p ON p.id=v.project_id
      WHERE v.project_id <> ${projectId}::uuid AND p.theme_id <> ${themeId}
        AND v.package_json IS NOT NULL AND p.status <> 'archived'
      ORDER BY v.project_id, v.version_number DESC
    ) latest ORDER BY created_at DESC, theme_id LIMIT 20
  `);
  const published = await db.execute(sql`
    SELECT c.theme_id, r.package_json FROM theme_catalog_entries c
    JOIN theme_releases r ON r.id=c.current_release_id
    WHERE c.visibility='public' AND r.release_status='published' AND c.theme_id <> ${themeId}
    ORDER BY c.updated_at DESC, c.theme_id LIMIT 76
  `);
  const entries = new Map<string, ExistingThemeFingerprint>();
  for (const row of [...recent.rows, ...published.rows] as {
    theme_id: string;
    package_json: unknown;
    intent_json?: unknown;
  }[]) {
    const pkg = validateThemePackageV2(row.package_json);
    if (!pkg.ok || entries.has(row.theme_id)) continue;
    const intent = validateThemeIntent(row.intent_json);
    entries.set(row.theme_id, {
      themeId: row.theme_id,
      direction: intent.ok ? (intent.value.designDirection ?? null) : null,
      fingerprint: themeFingerprint(pkg.value.definition),
    });
  }
  for (const theme of THEME_DEFINITIONS)
    if (theme.id !== themeId && !entries.has(theme.id))
      entries.set(theme.id, {
        themeId: theme.id,
        direction: null,
        fingerprint: themeFingerprint(theme),
      });
  // Bundled fallback can grow independently of the published catalogue.
  const context = readVarietyContext([...entries.values()].slice(0, 100));
  if (!context)
    throw new Error("Catalogue fingerprint exceeded its bounded shape.");
  await db
    .update(themeStudioRuns)
    .set({ varietyContext: context })
    .where(
      and(
        eq(themeStudioRuns.id, runId),
        isNull(themeStudioRuns.varietyContext),
      ),
    );
  // First writer wins even if a lease expires between reading and writing.
  const [stored] = await db
    .select({ context: themeStudioRuns.varietyContext })
    .from(themeStudioRuns)
    .where(eq(themeStudioRuns.id, runId))
    .limit(1);
  const frozen = readVarietyContext(stored?.context);
  if (!frozen) throw new Error("Variety context was not stored.");
  return frozen;
}
