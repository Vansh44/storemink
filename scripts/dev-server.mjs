import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const devCacheDir = path.join(projectRoot, ".next", "dev");
const nextBin = path.join(
  projectRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const MB = 1024 * 1024;

function numericArg(prefix) {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = Number(raw.slice(prefix.length));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function directoryBytes(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let bytes = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(target);
    } else if (entry.isFile()) {
      bytes += (await stat(target)).size;
    }
  }
  return bytes;
}

async function resetDevCache(reason) {
  const bytes = await directoryBytes(devCacheDir);
  if (bytes === 0) return false;
  console.log(
    `[dev] ${reason}: removing ${(bytes / MB / 1024).toFixed(1)} GB of generated .next/dev cache.`,
  );
  await rm(devCacheDir, { recursive: true, force: true });
  return true;
}

if (process.argv.includes("--reset-cache")) {
  const removed = await resetDevCache("manual reset");
  if (!removed) console.log("[dev] .next/dev is already empty.");
  process.exit(0);
}

// Preserve warm compiles across restarts. Cache size is not RAM usage.
// Rotation is opt-in for machines where disk space, rather than RAM, is scarce.
const cacheLimitMb = Number(process.env.DEV_CACHE_MAX_MB ?? 0);
if (Number.isFinite(cacheLimitMb) && cacheLimitMb > 0) {
  const cacheBytes = await directoryBytes(devCacheDir);
  if (cacheBytes > cacheLimitMb * MB) {
    await resetDevCache(`cache exceeded ${cacheLimitMb} MB`);
  }
}

// Best-effort Spotlight markers, not a verified performance fix. Recreate
// after npm ci / cache reset; failure must not prevent development.
async function ensureNoIndexMarkers() {
  for (const dir of [".next", "node_modules", "coverage"]) {
    const target = path.join(projectRoot, dir);
    try {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, ".metadata_never_index"), "", {
        flag: "a",
      });
    } catch {
      // Best effort, always. A read-only volume or a permissions quirk must
      // never stop the dev server booting over a performance nicety.
    }
  }
}

await ensureNoIndexMarkers();

const memoryGb = totalmem() / 1024 ** 3;
const explicitHeapMb = numericArg("--heap-mb=");
const heapMb =
  explicitHeapMb ?? (memoryGb <= 12 ? 2048 : memoryGb <= 20 ? 3072 : 0);

const inheritedNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
  .trim();
const nodeOptions = [
  inheritedNodeOptions,
  heapMb > 0 ? `--max-old-space-size=${heapMb}` : "",
]
  .filter(Boolean)
  .join(" ");
const childEnv = { ...process.env };
if (nodeOptions) childEnv.NODE_OPTIONS = nodeOptions;
else delete childEnv.NODE_OPTIONS;
const nextArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--heap-mb=") && arg !== "--reset-cache");

// V8's old-space cap excludes native allocations and buffers. It is not a
// process-wide RAM limit, especially with Turbopack's Rust module graph.
// Swap usage is historical context, not a measurement of current paging rate.
function memoryPreflight() {
  let swapUsedMb = 0;
  let swapTotalMb = 0;
  try {
    const raw = execFileSync("sysctl", ["-n", "vm.swapusage"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    swapTotalMb = Number(/total\s*=\s*([\d.]+)M/.exec(raw)?.[1] ?? 0);
    swapUsedMb = Number(/used\s*=\s*([\d.]+)M/.exec(raw)?.[1] ?? 0);
  } catch {
    return; // Not macOS, or sysctl unavailable — a warning is a nicety, never a gate.
  }
  if (!swapTotalMb) return;

  const ratio = swapUsedMb / swapTotalMb;
  if (ratio < 0.6) return;

  console.log("");
  console.log(
    `[dev] ⚠  Swap is ${(ratio * 100).toFixed(0)}% full (${(swapUsedMb / 1024).toFixed(1)} GB of ${(swapTotalMb / 1024).toFixed(1)} GB) BEFORE this server starts.`,
  );
  console.log(
    "[dev]    Check Activity Monitor → Memory Pressure; swap usage alone does not prove active thrashing.",
  );
  console.log(
    "[dev]    Close unused heavy apps and restart the dev server if pressure is high. Keep the warm cache.",
  );
  console.log("");
}

memoryPreflight();

if (heapMb > 0) {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; capping V8's old space at ${heapMb} MB.`,
  );
  console.log(
    "[dev] Note: this bounds V8 only — native memory and buffers are outside it, so total",
  );
  console.log(
    "[dev] RSS still grows through a session. Restart the server when it feels sluggish.",
  );
} else {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; using an uncapped Next.js heap.`,
  );
}

const bundlerArgs = nextArgs.some((arg) =>
  ["--webpack", "--turbopack", "--turbo"].includes(arg),
)
  ? []
  : [memoryGb <= 12 ? "--webpack" : "--turbopack"];

console.log(
  `[dev] Bundler: ${[...bundlerArgs, ...nextArgs].includes("--webpack") ? "Webpack" : "Turbopack"}; preserving compilation caches.`,
);

const child = spawn(
  process.execPath,
  [nextBin, "dev", ...bundlerArgs, ...nextArgs],
  {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error("[dev] Failed to start Next.js:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
