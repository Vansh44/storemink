# syntax=docker/dockerfile:1
# Multi-stage build for Cloud Run (GCP migration Phase 4). Produces a small
# image from Next.js standalone output. Debian-slim base (glibc) so sharp's
# prebuilt binaries work without extra system libs.

# ---- deps: install node_modules from the lockfile ----
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the app to .next/standalone ----
FROM node:24-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, so they must
# be present here (pass with --build-arg). Server-only secrets are NOT baked in —
# they're provided at runtime by Cloud Run (env / Secret Manager).
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_ROOT_DOMAIN
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_NOINDEX
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_ROOT_DOMAIN=$NEXT_PUBLIC_ROOT_DOMAIN \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_NOINDEX=$NEXT_PUBLIC_NOINDEX \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---- runner: minimal runtime image ----
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone server + its traced node_modules and runtime Markdown prompts.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets and public/ are NOT part of standalone — copy them explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# ★★ SHARP'S NATIVE LIBRARY IS COPIED EXPLICITLY, because file tracing cannot
# see it. sharp's `.node` binding dlopens `libvips-cpp.so` from a SIBLING
# package (@img/sharp-libvips-linux-x64) at runtime, so nothing in the import
# graph mentions it and Next left it out of .next/standalone. Production failed
# on 2026-09-10 with:
#
#   Could not load the "sharp" module using the linux-x64 runtime
#   ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file
#
# That is a MODULE-LOAD failure, so no route could catch it: /api/upload
# answered a bare framework 500 in 6 ms with no JSON body, and it took the
# OG-image proxy and Mink's image input down with it.
#
# ⚠ COPIED FROM `deps`, NOT `builder`. Both have the packages, but `deps` is
# where `npm ci` resolved them for THIS image's platform (node:24-slim,
# linux/x64, glibc) — so what lands here cannot be a host's darwin binary.
# next.config.ts also traces these for hosts that build without this Dockerfile;
# neither fix makes the other redundant, and this is the one that cannot be
# defeated by a tracer heuristic.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img

USER nextjs
EXPOSE 8080

# Cloud Run injects PORT (default 8080); the standalone server honours it.
CMD ["node", "server.js"]
