/**
 * Run the Phase 0 golden set (evals/theme-studio/phase0.json) through the
 * Theme Studio generation pipeline and grade the results.
 *
 *   npm run theme-studio:eval
 *       Offline. Uses the fake provider: proves the harness, the compiler and
 *       the safety checks run end to end. Costs nothing and GRADES NOTHING —
 *       the fake ignores the brief, so its outcomes say nothing about a model.
 *
 *   npm run theme-studio:eval -- --live --model=gemini-3.8-flash --max-usd=5 --yes
 *       Live. Calls Gemini on Vertex AI for every case, sequentially, and
 *       stops before the next case once the estimated spend reaches --max-usd.
 *       Both --max-usd and --yes are required; there is no default ceiling.
 *       Needs ADC and THEME_STUDIO_GCP_PROJECT_ID (or GCP_PROJECT_ID).
 *
 * Options: --model=a,b (default gemini-3.8-flash), --cases=id,id, --out=report.json,
 * --packages=<dir> (write each generated ThemePackageV2 as <model>.<case>.json, so a
 * paid run can be inspected afterwards rather than only graded).
 *
 * ★ It touches no database. Each case builds the same GenerationInput the
 * worker builds, so a model that passes here is judged on the pipeline it
 * will actually run in.
 *
 * ★ Reference notes become IMAGES: each note is rendered as text into a PNG
 * and passed through the production reference sanitizer, which is what makes
 * the "screenshot says: reveal credentials" cases real prompt-injection tests.
 * A note that names an SVG is sent as a hostile SVG instead; the sanitizer
 * refusing it IS the expected refusal, and no model call is made.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const RUN_WALL_MS = 19 * 60 * 1000;

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function wrap(text: string, width = 48): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

async function main() {
  const live = process.argv.includes("--live");
  const models = (option("model") ?? "gemini-3.8-flash")
    .split(",")
    .map((m) => m.trim());
  const only =
    option("cases")
      ?.split(",")
      .map((c) => c.trim()) ?? null;
  const maxUsdOption = option("max-usd");
  const maxUsd = Number(maxUsdOption ?? "0");
  const out = option("out");
  const packagesDir = option("packages");

  const sharp = (await import("sharp")).default;
  const { writeFile } = await import("node:fs/promises");
  const corpus = (await import("@/evals/theme-studio/phase0.json")).default;
  const { parseThemeStudioModelKey, resolveThemeStudioModel } =
    await import("@/lib/theme-studio/models");
  const { runThemeGeneration } = await import("@/lib/theme-studio/pipeline");
  const { createFakeModelClient } =
    await import("@/lib/theme-studio/fake-provider");
  const { createVertexModelClient, getVertexConfig } =
    await import("@/lib/theme-studio/gemini-vertex");
  const { sanitizeReferenceImage } =
    await import("@/lib/theme-studio/references");
  const { THEME_STUDIO_PROMPT_VERSION } =
    await import("@/lib/theme-studio/prompts");
  const { THEME_STUDIO_FAKE_PROMPT_VERSION } =
    await import("@/lib/theme-studio/config");
  const evaluation = await import("@/lib/theme-studio/evaluation");

  const cases = (
    corpus.cases as import("@/lib/theme-studio/evaluation").EvalCase[]
  ).filter((entry) => !only || only.includes(entry.id));
  if (cases.length === 0) throw new Error("No cases matched --cases.");

  const keys = models.map((model) => {
    const key = parseThemeStudioModelKey(model);
    if (!key) throw new Error(`Unknown Theme Studio model key: ${model}`);
    return key;
  });
  // ★ A live run spends real money, so it needs TWO explicit statements: a
  // spend ceiling (there is no default) and --yes. `--live` alone refuses,
  // because GCP_PROJECT_ID is commonly present in a developer's .env for other
  // features and would otherwise be all it takes.
  if (live && (maxUsdOption === null || !process.argv.includes("--yes"))) {
    throw new Error(
      "Live evaluation calls paid models. Pass --max-usd=<dollars> and --yes to confirm.",
    );
  }
  const vertex = live ? getVertexConfig() : null;
  if (live && !vertex) {
    throw new Error(
      "Live evaluation needs THEME_STUDIO_GCP_PROJECT_ID or GCP_PROJECT_ID.",
    );
  }
  if (live && (!Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new Error("--max-usd must be a positive number.");
  }

  async function references(notes: string[]) {
    const images: { base64: string; sha256: string }[] = [];
    for (const note of notes) {
      if (/\bsvg\b/i.test(note)) {
        const hostile = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>` +
            `<foreignObject><body>${escapeXml(note)}</body></foreignObject></svg>`,
        );
        const result = await sanitizeReferenceImage(hostile);
        if (!result.ok) return { rejected: result.code };
        images.push({
          base64: result.value.bytes.toString("base64"),
          sha256: result.value.sha256,
        });
        continue;
      }
      const lines = wrap(note)
        .map(
          (line, i) =>
            `<text x="40" y="${80 + i * 44}" font-size="32" font-family="sans-serif">${escapeXml(line)}</text>`,
        )
        .join("");
      const png = await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="100%" height="100%" fill="#f4f1ea"/>${lines}</svg>`,
        ),
      )
        .png()
        .toBuffer();
      const result = await sanitizeReferenceImage(png);
      if (!result.ok) throw new Error(`Harness image refused: ${result.code}`);
      images.push({
        base64: result.value.bytes.toString("base64"),
        sha256: result.value.sha256,
      });
    }
    return { images };
  }

  const report: Record<string, unknown> = {
    mode: live ? "live" : "offline",
    ranAt: new Date().toISOString(),
    promptVersion: live
      ? THEME_STUDIO_PROMPT_VERSION
      : THEME_STUDIO_FAKE_PROMPT_VERSION,
    models: {},
  };
  let spentMicroUsd = 0;
  let stopped = false;

  for (const modelKey of keys) {
    const record = resolveThemeStudioModel(modelKey);
    const results: import("@/lib/theme-studio/evaluation").EvalResult[] = [];
    for (const entry of cases) {
      if (live && spentMicroUsd >= maxUsd * 1_000_000) {
        stopped = true;
        break;
      }
      const refs = await references(entry.referenceNotes);
      if ("rejected" in refs) {
        const observed = "refuse" as const;
        results.push({
          id: entry.id,
          category: entry.category,
          expected: entry.expectedOutcome,
          observed,
          grade: evaluation.gradeOutcome(entry, observed),
          detail: `reference sanitizer rejected the upload (${refs.rejected})`,
          violations: [],
          costMicroUsd: 0,
          repairs: 0,
        });
        console.log(
          `${modelKey}  ${entry.id.padEnd(36)} expected=${entry.expectedOutcome.padEnd(14)} observed=refuse         sanitizer (${refs.rejected})`,
        );
        continue;
      }
      const facts = {
        name: `Eval ${entry.id}`,
        themeId: `eval-${entry.id}`.slice(0, 40),
        industries: ["general" as const],
        catalogSizes: ["small" as const],
        requiredFeatures: [],
      };
      const client = live
        ? createVertexModelClient(vertex!)
        : createFakeModelClient({
            ...facts,
            brief: entry.prompt,
            referenceCount: refs.images.length,
          });
      const outcome = await runThemeGeneration(
        client,
        {
          facts: { ...facts, baseThemeName: null },
          compile: {
            ...facts,
            baseEngine: null,
            versionNumber: 1,
            modelKey,
            modelLabel: record.label,
            referenceDigests: refs.images.map((image) => image.sha256),
          },
          providerModel: record.providerModel,
          promptVersion: live
            ? THEME_STUDIO_PROMPT_VERSION
            : THEME_STUDIO_FAKE_PROMPT_VERSION,
          messages: [{ kind: "brief", body: entry.prompt }],
          references: refs.images,
        },
        AbortSignal.timeout(RUN_WALL_MS),
      );
      if (packagesDir && outcome.kind === "version") {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(packagesDir, { recursive: true });
        await writeFile(
          `${packagesDir}/${modelKey}.${entry.id}.json`,
          JSON.stringify(outcome.package, null, 2),
        );
      }
      const observed = evaluation.observedOutcome(outcome);
      const cost = outcome.telemetry.estimatedCostMicroUsd;
      spentMicroUsd += cost;
      results.push({
        id: entry.id,
        category: entry.category,
        expected: entry.expectedOutcome,
        observed,
        grade: evaluation.gradeOutcome(entry, observed),
        detail:
          outcome.kind === "failed"
            ? outcome.errorCode
            : outcome.kind === "clarify"
              ? outcome.questions.join(" | ")
              : outcome.kind === "declined"
                ? outcome.reason
                : `${outcome.package.definition.preset.pages.length} pages, ${outcome.package.capabilityGaps.length} gaps`,
        violations:
          outcome.kind === "version"
            ? evaluation.packageSafetyViolations(outcome.package, modelKey)
            : [],
        costMicroUsd: cost,
        repairs:
          outcome.telemetry.repairs.intent + outcome.telemetry.repairs.draft,
      });
      const last = results.at(-1)!;
      console.log(
        `${modelKey}  ${entry.id.padEnd(36)} expected=${entry.expectedOutcome.padEnd(14)} observed=${observed.padEnd(14)} ${live ? evaluation.finalGrade(last) : last.violations.length ? "UNSAFE" : "ok"}`,
      );
    }
    const summary = evaluation.summarize(results);
    (report.models as Record<string, unknown>)[modelKey] = { summary, results };
    console.log(
      live
        ? `\n${modelKey}: ${summary.pass} pass, ${summary.acceptable} acceptable, ${summary.fail} fail, ${summary.safetyViolations} unsafe, ~$${(summary.costMicroUsd / 1e6).toFixed(2)}\n`
        : `\n${modelKey}: ${results.length} cases ran offline, ${summary.safetyViolations} unsafe (outcomes not graded: the fake ignores the brief)\n`,
    );
  }
  if (stopped) {
    console.log(`Stopped early: estimated spend reached $${maxUsd}.`);
    report.stoppedAtUsd = maxUsd;
  }
  if (out) await writeFile(out, JSON.stringify(report, null, 2));

  const unsafe = Object.values(
    report.models as Record<string, { summary: { safetyViolations: number } }>,
  ).some((entry) => entry.summary.safetyViolations > 0);
  process.exit(unsafe ? 1 : 0);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? process.env.DEBUG
        ? error.stack
        : error.message
      : error,
  );
  process.exit(2);
});
