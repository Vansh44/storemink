/** Eight themes / four industries. Offline exercises plumbing only; --live
 * evaluates actual generation. No database writes, no artwork calls.
 * Live requires --yes --max-usd=N; stop between themes at the spend ceiling. */
import { loadEnvConfig } from "@next/env";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runThemeGeneration } from "@/lib/theme-studio/pipeline";
import { createFakeModelClient } from "@/lib/theme-studio/fake-provider";
import {
  createVertexModelClient,
  getVertexConfig,
} from "@/lib/theme-studio/gemini-vertex";
import { resolveThemeStudioModel } from "@/lib/theme-studio/models";
import { THEME_STUDIO_PROMPT_VERSION } from "@/lib/theme-studio/prompt-features";
import { THEME_DEFINITIONS } from "@/lib/themes";
import {
  themeFingerprint,
  fingerprintDistance,
  fingerprintChoiceValues,
  type ExistingThemeFingerprint,
} from "@/lib/theme-studio/fingerprint";
import type { ThemeIndustry } from "@/lib/themes/meta";
import { validateThemePackageV2 } from "@/lib/theme-studio/contracts";

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const option = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const live = process.argv.includes("--live");
const ceiling = Number(option("max-usd") ?? 0);
if (
  live &&
  (!process.argv.includes("--yes") || !Number.isFinite(ceiling) || ceiling <= 0)
)
  throw new Error("Paid evaluation needs --yes --max-usd=<positive dollars>.");
const out = option("out") ?? "/tmp/theme-studio-variety-report.json";
const packages = option("packages");
const cases: { id: string; industry: ThemeIndustry; brief: string }[] = [
  {
    id: "fashion-a",
    industry: "clothing",
    brief:
      "An independent contemporary apparel label. Expressive, confident collections and a memorable storefront. Choose a coherent original art direction.",
  },
  {
    id: "fashion-b",
    industry: "clothing",
    brief:
      "A considered apparel atelier selling beautifully made essentials. Premium editorial shopping with a distinct original visual identity.",
  },
  {
    id: "beauty-a",
    industry: "beauty",
    brief:
      "A small botanical skincare range. Make ingredient education and product discovery inviting, with an original coherent visual identity.",
  },
  {
    id: "beauty-b",
    industry: "beauty",
    brief:
      "A modern beauty brand selling colour cosmetics. Confident merchandising and a recognisable original visual identity.",
  },
  {
    id: "home-a",
    industry: "home",
    brief:
      "A ceramic and home objects studio. Emphasise craft, material texture and thoughtful shopping with original art direction.",
  },
  {
    id: "home-b",
    industry: "home",
    brief:
      "A contemporary home accessories store selling lighting and textiles. Clear commerce and an original visual identity.",
  },
  {
    id: "food-a",
    industry: "food-and-drink",
    brief:
      "An independent pantry shop selling snacks and preserves. Accessible shopping and a memorable original visual identity.",
  },
  {
    id: "food-b",
    industry: "food-and-drink",
    brief:
      "A specialty tea and coffee roastery. Rich product storytelling and a recognisable original visual identity.",
  },
];
const vertex = live ? getVertexConfig() : null;
if (live && !vertex) throw new Error("Vertex project configuration missing.");
const model = resolveThemeStudioModel("gemini-3.8-flash");
const context: ExistingThemeFingerprint[] = THEME_DEFINITIONS.map((t) => ({
  themeId: t.id,
  direction: null,
  fingerprint: themeFingerprint(t),
}));
const rows: Record<string, unknown>[] = [];
const successful: ExistingThemeFingerprint[] = [];
let spent = 0;
let reportWrites = Promise.resolve();
let exitCriteriaMet = false;
async function report() {
  const distances = successful
    .flatMap((a, i) =>
      successful
        .slice(i + 1)
        .map((b) => fingerprintDistance(a.fingerprint, b.fingerprint)),
    )
    .sort((a, b) => a - b);
  const median = distances.length
    ? (distances[Math.floor((distances.length - 1) / 2)] +
        distances[Math.ceil((distances.length - 1) / 2)]) /
      2
    : null;
  const identicalFingerprintFields = successful.length
    ? Object.keys(successful[0].fingerprint).filter(
        (key) =>
          new Set(
            successful.map((t) =>
              JSON.stringify(t.fingerprint[key as keyof typeof t.fingerprint]),
            ),
          ).size === 1,
      )
    : [];
  const choices = successful.map((t) => fingerprintChoiceValues(t.fingerprint));
  const identicalSettings = choices.length
    ? Object.keys(choices[0]).filter(
        (key) => new Set(choices.map((c) => c[key])).size === 1,
      )
    : [];
  const nonWhite = successful.filter(
    (t) => t.fingerprint.pageColour !== "near-white",
  ).length;
  const graded = live && successful.length === 8;
  exitCriteriaMet =
    graded &&
    median !== null &&
    median >= 0.45 &&
    !identicalSettings.length &&
    nonWhite / successful.length >= 0.3;
  const content =
    JSON.stringify(
      {
        promptVersion: THEME_STUDIO_PROMPT_VERSION,
        live,
        graded,
        estimatedUsd: spent / 1e6,
        completed: rows.length,
        successful: successful.length,
        medianPairwise: live ? median : null,
        identicalSettings: live ? identicalSettings : null,
        identicalFingerprintFields: live ? identicalFingerprintFields : null,
        nonNearWhiteShare:
          live && successful.length ? nonWhite / successful.length : null,
        exitCriteriaMet,
        rows,
      },
      null,
      2,
    ) + "\n";
  reportWrites = reportWrites.then(() => writeFile(out, content));
  await reportWrites;
}
async function main() {
  // Reproduce a converged catalogue without production data or DB writes.
  const seeds = option("seed-packages");
  if (seeds) {
    for (const file of (await readdir(seeds))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(0, 20)) {
      const parsed = validateThemePackageV2(
        JSON.parse(await readFile(join(seeds, file), "utf8")),
      );
      if (!parsed.ok) throw new Error(`Invalid seed package: ${file}`);
      context.unshift({
        themeId: `seed-${parsed.value.definition.id}`,
        direction: null,
        fingerprint: themeFingerprint(parsed.value.definition),
      });
    }
  }
  const queue = cases.filter(
    (c) => !option("cases") || option("cases")!.split(",").includes(c.id),
  );
  const concurrency = Number(option("concurrency") ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new Error("Concurrency must be 1 or 2.");
  const worker = async () => {
    while (queue.length) {
      if (live && spent >= ceiling * 1e6) break;
      const c = queue.shift()!;
      const facts = {
        name: c.id,
        themeId: `eval-${c.id}`,
        industries: [c.industry],
        catalogSizes: ["small" as const],
        requiredFeatures: [],
      };
      const client = live
        ? createVertexModelClient(vertex!)
        : createFakeModelClient({
            ...facts,
            brief: c.brief,
            referenceCount: 0,
          });
      const started = Date.now();
      console.log(`Starting ${c.id}`);
      try {
        const outcome = await runThemeGeneration(
          client,
          {
            facts: { ...facts, baseThemeName: null },
            compile: {
              ...facts,
              baseEngine: null,
              versionNumber: 1,
              modelKey: model.key,
              modelLabel: model.label,
              referenceDigests: [],
            },
            providerModel: model.providerModel,
            promptVersion: THEME_STUDIO_PROMPT_VERSION,
            messages: [{ kind: "brief", body: c.brief }],
            references: [],
            existingThemes: structuredClone(context),
          },
          AbortSignal.timeout(19 * 60 * 1000),
        );
        spent += outcome.telemetry.estimatedCostMicroUsd;
        rows.push({
          id: c.id,
          industry: c.industry,
          kind: outcome.kind,
          durationMs: Date.now() - started,
          telemetry: outcome.telemetry,
          ...(outcome.kind === "version"
            ? {
                direction: outcome.intent.designDirection,
                paletteFamily: outcome.intent.paletteFamily,
                distinctness: outcome.distinctness,
              }
            : outcome.kind === "failed"
              ? { error: outcome.errorCode, detail: outcome.detail }
              : {}),
        });
        if (outcome.kind === "version") {
          const entry = {
            themeId: facts.themeId,
            direction: outcome.intent.designDirection ?? null,
            fingerprint: themeFingerprint(outcome.package.definition),
          };
          successful.push(entry);
          context.unshift(entry);
          if (packages) {
            await mkdir(packages, { recursive: true });
            await writeFile(
              join(packages, `${c.id}.json`),
              JSON.stringify(outcome.package, null, 2) + "\n",
            );
          }
        }
        console.log(
          `${c.id}: ${outcome.kind}, ${Math.round((Date.now() - started) / 1000)}s, $${(spent / 1e6).toFixed(3)} total`,
        );
      } catch (error) {
        rows.push({
          id: c.id,
          kind: "exception",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        console.log(`${c.id}: exception`);
      }
      await report();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await report();
  console.log(
    `Saved ${out}; ${live ? "live quality evaluation" : "offline plumbing only, no model quality graded"}.`,
  );
  if (live && !exitCriteriaMet) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
