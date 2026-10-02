/** Complete-theme benchmark against the actual deployed worker/capture/QA
 * pipeline. Default is READ ONLY: --projects=<ids> collects existing runs.
 * --create --actor-id=<superadmin UUID> --yes queues four isolated unpublished
 * themes. --wait-minutes=60 polls outcomes and saves the report every 15s.
 * Resume after interruption with --projects=<ids>; never re-create the batch.
 * Requires service DB credentials pointing at the same deployment as workers.
 * No publication, retries, edits to existing themes or hidden quality bypass.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

const option = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);

async function main() {
  const { writeFile, mkdir, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { eq, inArray } = await import("drizzle-orm");
  const schema = await import("@/drizzle/schema");
  const { withService } = await import("@/lib/db/client");
  const { themeBenchmarkReport, THEME_BENCHMARK_CASES } =
    await import("@/lib/theme-studio/benchmark");
  const {
    isUuid,
    createThemeStudioProject,
    queueThemeStudioGeneration,
    validateProjectInput,
  } = await import("@/lib/theme-studio/repository");
  const { getThemeStudioConfig } = await import("@/lib/theme-studio/config");
  const { currentAcceptanceBuildId } =
    await import("@/lib/theme-studio/acceptance");
  const out = option("out") ?? "/tmp/theme-studio-benchmark.json";
  const minutes = Number(option("wait-minutes") ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120)
    throw new Error("--wait-minutes must be 0..120.");
  const ids = (option("projects") ?? "").split(",").filter(Boolean);
  if (ids.some((id) => !isUuid(id)))
    throw new Error("--projects requires UUIDs.");
  const created: string[] = [];
  const persist = async (results: unknown[]) => {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      `${out}.tmp`,
      JSON.stringify(
        {
          version: 1,
          measuredAt: new Date().toISOString(),
          reporterBuildId: currentAcceptanceBuildId(),
          projectIds: ids,
          createdProjectIds: created,
          results,
        },
        null,
        2,
      ),
    );
    await rename(`${out}.tmp`, out);
  };
  const collect = async () => {
    const data = await withService(async (db) => ({
      projects: await db
        .select()
        .from(schema.themeStudioProjects)
        .where(inArray(schema.themeStudioProjects.id, ids)),
      runs: await db
        .select()
        .from(schema.themeStudioRuns)
        .where(inArray(schema.themeStudioRuns.projectId, ids)),
      captures: await db
        .select()
        .from(schema.themeStudioCaptures)
        .where(inArray(schema.themeStudioCaptures.projectId, ids)),
      qa: await db
        .select()
        .from(schema.themeStudioVisualQaRuns)
        .where(inArray(schema.themeStudioVisualQaRuns.projectId, ids)),
      versions: await db
        .select({
          id: schema.themeStudioVersions.id,
          projectId: schema.themeStudioVersions.projectId,
        })
        .from(schema.themeStudioVersions)
        .where(inArray(schema.themeStudioVersions.projectId, ids)),
    }));
    if (data.projects.length !== new Set(ids).size)
      throw new Error("A requested benchmark project was not found.");
    const results = data.projects.map((project) =>
      themeBenchmarkReport({
        project,
        runs: data.runs.filter((r) => r.projectId === project.id),
        captures: data.captures.filter((r) => r.projectId === project.id),
        qa: data.qa.filter((r) => r.projectId === project.id),
        versions: data.versions.filter((r) => r.projectId === project.id),
        measuredAt: new Date().toISOString(),
      }),
    );
    await persist(results);
    return results;
  };
  if (process.argv.includes("--create")) {
    if (ids.length) throw new Error("Use --create or --projects, separately.");
    const config = getThemeStudioConfig();
    if (
      !process.argv.includes("--yes") ||
      !config.generationEnabled ||
      !config.autoQaEnabled ||
      config.provider !== "vertex-gemini"
    )
      throw new Error(
        "Complete live benchmarks require --yes and deployed Vertex generation, capture and automatic QA enabled.",
      );
    const actorId = option("actor-id");
    if (!isUuid(actorId))
      throw new Error("--actor-id requires a superadmin UUID.");
    const [actor] = await withService((db) =>
      db
        .select()
        .from(schema.platformAdmins)
        .where(eq(schema.platformAdmins.id, actorId))
        .limit(1),
    );
    if (actor?.role !== "superadmin")
      throw new Error("Benchmark actor must be a current superadmin.");
    const cases = THEME_BENCHMARK_CASES;
    const modelKey = option("model") ?? "gemini-3.8-flash";
    // Queue sequentially, respecting the existing per-operator capacity guard.
    // Persist each ID before queueing so interruption cannot hide a project.
    for (const entry of cases) {
      const suffix = randomUUID().slice(0, 8);
      const project = await createThemeStudioProject(
        actor,
        validateProjectInput({
          name: `Benchmark ${entry.name} ${suffix}`,
          themeId: `benchmark-${entry.name.toLowerCase()}-${suffix}`,
          brief: entry.brief,
          industries: [entry.industry],
          catalogSizes: ["small"],
          requiredFeatures: ["category-navigation"],
          baseThemeId: null,
          modelKey,
        }),
      );
      ids.push(project.id);
      created.push(project.id);
      await persist([]);
      await queueThemeStudioGeneration(actor, {
        projectId: project.id,
        expectedRevision: 0,
        idempotencyKey: `benchmark_${randomUUID()}`,
      });
      console.log(`Queued ${entry.name}: ${project.id}`);
      // Only one active benchmark at a time. Wait for a terminal state before
      // queueing the next; a timeout preserves IDs and stops new paid work.
      const until = Date.now() + Math.max(1, minutes) * 60_000;
      for (;;) {
        await collect();
        const [current] = await withService((db) =>
          db
            .select({ status: schema.themeStudioProjects.status })
            .from(schema.themeStudioProjects)
            .where(eq(schema.themeStudioProjects.id, project.id))
            .limit(1),
        );
        if (current?.status !== "generating") break;
        if (Date.now() >= until) {
          console.log(
            "Benchmark still running; resume reporting with --projects. No further themes queued.",
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
      const [current] = await withService((db) =>
        db
          .select({ status: schema.themeStudioProjects.status })
          .from(schema.themeStudioProjects)
          .where(eq(schema.themeStudioProjects.id, project.id))
          .limit(1),
      );
      if (current?.status === "generating") break;
    }
  }
  if (!ids.length)
    throw new Error(
      "Provide --projects=<UUIDs>, or explicitly queue a batch with --create --actor-id=<UUID> --yes --wait-minutes=60.",
    );
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    const results = await collect();
    if (results.every((r) => r.terminal) || Date.now() >= until) {
      console.log(
        JSON.stringify(
          results.map((r) => ({
            projectId: r.projectId,
            status: r.status,
            wallMs: r.wallMs,
            firstFinalQaPassed: r.firstFinalQaPassed,
            firstPassQaPassed: r.firstPassQaPassed,
            designRevisions: r.designRevisions,
          })),
          null,
          2,
        ),
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  console.log(`Saved ${out}`);
  // DB pools are intentionally process-lifetime in the app; this CLI exits.
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Benchmark failed");
    process.exit(1);
  });
