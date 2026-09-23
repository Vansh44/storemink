#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const registryPath = fileURLToPath(
  new URL("../lib/theme-studio/models.json", import.meta.url),
);
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const args = new Set(process.argv.slice(2));
const requested = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--model="))
  ?.slice("--model=".length);
const json = args.has("--json");
const dryRun = args.has("--dry-run");
const projectId =
  process.env.THEME_STUDIO_GCP_PROJECT_ID?.trim() ||
  process.env.GCP_PROJECT_ID?.trim();
const location = process.env.THEME_STUDIO_VERTEX_LOCATION?.trim() || "global";

const selected = requested
  ? registry.filter((model) => model.key === requested)
  : registry;

if (selected.length === 0) {
  process.stderr.write(`Unknown Theme Studio model key: ${requested}\n`);
  process.exit(2);
}

const resolved = selected.map((model) => ({
  ...model,
  providerModel: process.env[model.envOverride]?.trim() || model.providerModel,
}));
for (const model of resolved) {
  const base = registry.find(
    (candidate) => candidate.key === model.key,
  ).providerModel;
  // Same rule as lib/theme-studio/models.ts: a published version of the same
  // model ("-001", "-09-2026", "-09-15"), never a different model sharing the
  // prefix, such as "-lite".
  const suffix = model.providerModel.slice(base.length);
  if (
    model.providerModel !== base &&
    !(
      model.providerModel.startsWith(base) &&
      /^-(?:\d{3}|\d{2}-\d{4}|\d{2}-\d{2})$/.test(suffix)
    )
  ) {
    process.stderr.write(
      `${model.envOverride} must stay within the ${base} model family.\n`,
    );
    process.exit(2);
  }
}

if (dryRun) {
  emit(
    resolved.map((model) => ({
      key: model.key,
      providerModel: model.providerModel,
      location,
      status: "not-probed",
    })),
  );
  process.exit(0);
}

if (!projectId) {
  process.stderr.write(
    "Set THEME_STUDIO_GCP_PROJECT_ID (or GCP_PROJECT_ID) before probing Vertex.\n",
  );
  process.exit(2);
}

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const headers = await client.getRequestHeaders();
const endpointHost =
  location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;

const results = [];
for (const model of resolved) {
  const started = Date.now();
  // countTokens, not a generation: it is free of charge, and answering it
  // still proves the model id exists at this location and that this project's
  // credentials may call it — which is everything the probe needs to know.
  const url = `https://${endpointHost}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model.providerModel)}:countTokens`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(headers),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "OK" }] }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    results.push({
      key: model.key,
      providerModel: model.providerModel,
      location,
      status: response.ok ? "available" : "unavailable",
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : providerErrorCode(body),
    });
  } catch (error) {
    results.push({
      key: model.key,
      providerModel: model.providerModel,
      location,
      status: "probe-failed",
      httpStatus: null,
      latencyMs: Date.now() - started,
      errorCode:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "request_failed",
    });
  }
}

emit(results);
if (results.some((result) => result.status !== "available")) process.exit(1);

function providerErrorCode(body) {
  try {
    const parsed = JSON.parse(body);
    const status = parsed?.error?.status;
    return typeof status === "string" ? status : "provider_rejected";
  } catch {
    return "provider_rejected";
  }
}

function emit(results) {
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) {
    const suffix =
      result.status === "available"
        ? ` (${result.latencyMs} ms)`
        : result.errorCode
          ? ` (${result.errorCode})`
          : "";
    process.stdout.write(
      `${result.key}: ${result.status} — ${result.providerModel} @ ${result.location}${suffix}\n`,
    );
  }
}
