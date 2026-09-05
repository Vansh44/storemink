# Local development performance

## Evidence from 2026-09-05

The machine is an Apple Silicon Mac with **8 GB RAM and 8 CPU cores**.
The system snapshot showed **6.4 GB swap used**, **3.3 GB RAM occupied by
compressed pages**, and about **61 GB available disk space**. No listener was
visible on ports 3000 or 6543 during inspection. Swap usage and cumulative
page-in counters alone cannot establish current thrashing; use Activity
Monitor's Memory Pressure and paging deltas during the slow request.

The existing `.next/dev/trace` contains:

| Operation                        | Duration |
| -------------------------------- | -------: |
| `/auth/login` compilation        |   60.1 s |
| `/auth/login` complete request   |   71.6 s |
| `/dashboard/builder` compilation |   43.3 s |
| `/dashboard` complete request    |   21.8 s |
| `/dashboard` rendering           |   13.0 s |

These are saved-session timings, not a controlled benchmark. They confirm
slow compilation and rendering, but do not reproduce the reported 5–10 minute
homepage wait. Long `/api/mink/stream` requests are streaming lifetimes and must
not be interpreted as page-load latency.

Earlier August measurements found much faster compilation and roughly 46 ms
per database round trip through the Mumbai Cloud SQL proxy. Those are historical
observations, not proof that the bundler or database cannot be the problem now.

## What the local runner does

`npm run dev:all` runs the Cloud SQL Auth Proxy and the Next.js dev
server. The runner selects Webpack on machines with ≤12 GB RAM and Turbopack
on larger machines; explicit bundler flags override this choice. It does not run a production build or test suite. Next compiles routes
on demand; the browser's compiling/rendering indicator reports this work.
Hiding the indicator will not speed it up.

The runner sets V8 old-space limits of 2 GB on machines with ≤12 GB RAM,
3 GB on machines with ≤20 GB, and no explicit limit above that. This is **not
a total process RAM cap**: native allocations, buffers and Turbopack's Rust
module graph sit outside it. `dev:lean` is already the default heap policy on
this 8 GB Mac; `dev:full` removes that protection and is not a speed fix.

Caches are now preserved across restarts. The previous runner automatically
removed `.next/dev` over 3 GB and `.next/cache` over 256 MB. Deleting caches
can force recompilation; disk cache size is not resident memory usage.
Next 16.2.12 enables Turbopack development filesystem caching by default.
`DEV_CACHE_MAX_MB=3072 npm run dev:all` restores opt-in dev-cache rotation for
machines short on disk. `npm run dev:reset` explicitly deletes `.next/dev`;
stop the server first and use it only for cache recovery or deliberate cleanup.
Neither operation removes production output. Normal startup no longer deletes
`.next/cache`.

The runner's swap warning is advisory. Quitting processes does reclaim their
memory; macOS does not need a reboot to reclaim all process memory. Allocated
swap-file capacity is different from actively used swap and current paging.
A reboot may help recover a heavily pressured session, but is not the only fix.
Spotlight marker files are best effort, not a measured improvement.

## Working commands

```bash
npm run dev:all          # memory-aware bundler choice + proxy, preserves cache
npm run dev:all:webpack  # explicit Webpack + same proxy and heap policy
npm run dev:all:turbo    # explicit Turbopack + same proxy and heap policy
npm run dev -- --webpack # Webpack only, if the proxy is already running
```

Stop the existing server with Ctrl+C before switching. The old runner forced
`--turbopack` even when `--webpack` was passed; explicit bundler selection now
works. Webpack is an alternative to measure, not a promise of lower memory or
faster compilation. Its first compile is cold and can be slow. Do not delete
caches between ordinary restarts; compare the same routes and both first and
repeat visits. Production build configuration is unchanged.

## Diagnose a slow session

1. Check Activity Monitor → Memory. Close unused high-memory apps if pressure
   is yellow/red. Restart the dev server to release its accumulated allocations,
   preserving the disk cache. Save work before rebooting if the Mac stays stuck.
2. Run one server and request one route. Compare the terminal's compile and
   render durations; a green memory graph does not rule out slow network I/O.
3. Compare a repeat visit. Fast repeat visits with slow first visits implicate
   compilation/cache warmup. Slow rendering after compilation needs database,
   authentication and external-service timing, not just compiler settings.
4. Try the Webpack command for the same route if Turbopack remains problematic.
   Record elapsed time and process memory when comparing bundlers.
5. Inspect proxy errors. It connects to the Mumbai Cloud SQL instance; local
   `DB_NAME` should select `storemink_staging`. Remote database latency and
   connection failures can delay rendering independently of compilation.

The root layout also declares nine Google font families. On a cold compile,
font fetching is another dependency to inspect if logs show network retries;
it has not been established as the cause of this incident. Heavy editors and
charts should be assessed via the route's import graph rather than removed
solely because they appear in package.json.

For a focused Turbopack trace, use `NEXT_TURBOPACK_TRACING=1 npm run dev:all:turbo`,
reproduce one slow route, then stop. Trace files may be large; do not enable
tracing permanently. See the installed Next.js guides in
`node_modules/next/dist/docs/01-app/02-guides/local-development.md` and
`memory-usage.md`.

These changes affect developer tooling only. No merchant/customer flow changes,
Help Centre migration, POS acceptance updates or roadmap phase changes apply.

## Webpack tuning from official guidance

The development phase of `next.config.ts` now applies these settings:

| Setting                     | Value                                           | Purpose / tradeoff                                                                                                                                             |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallelism`               | 8 per compiler on ≤12 GB RAM, 32 above          | Fewer concurrent module builds; can increase cold compile duration while reducing concurrent work.                                                             |
| `output.pathinfo`           | `false`                                         | Omit module-path comments and their garbage-collection overhead; source maps remain intact.                                                                    |
| `onDemandEntries` on ≤12 GB | `maxInactiveAge: 25000`, `pagesBufferLength: 2` | Retain fewer inactive entries than Next's 60 s / five-page defaults; revisits may recompile. Active pages stay active. This does not unload every Node module. |

`DEV_WEBPACK_PARALLELISM=16 npm run dev:all:webpack` overrides concurrency with
a positive integer. This limits module work, not CPU threads or total RSS.
The values are conservative starting points, not a proven optimum.

Next 16.2.12 already supplies filesystem caching, a garbage-collected memory
cache (`MemoryWithGcCachePlugin`), and `maxMemoryGenerations: 0` for its filesystem
cache. Those defaults are preserved, along with cache names, compression,
invalidation, loaders and chunking. No extra worker pool, polling watcher,
minification, typecheck process, or new dependency was added. Source maps retain
Next's defaults: its config builder explicitly reverts custom development
`devtool` values. `experimental.webpackMemoryOptimizations` is only consumed in
the installed production webpack build implementation, so it is not enabled as
a supposed local-dev fix.

The custom Webpack callback exists only in the development phase. Production
build configuration and its worker selection remain unchanged. An empty dev
`turbopack` config acknowledges the explicit alternative bundler; Webpack knobs
do not tune Turbopack.

Official sources consulted:

- [Webpack build performance](https://webpack.js.org/guides/build-performance/): persistent caches, incremental compilation, avoiding unnecessary tooling and path comments.
- [Webpack parallelism](https://webpack.js.org/configuration/other-options/#parallelism): concurrent module limits and the memory/throughput tradeoff.
- [Webpack cache](https://webpack.js.org/configuration/cache/): cache lifecycle and memory collection.
- [Next custom Webpack configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/webpack): extend framework configuration; the callback is invoked for client/server targets.
- [Next on-demand entries](https://nextjs.org/docs/app/api-reference/config/next-config-js/onDemandEntries): development entry retention.

### Live verification

The existing server was already using Webpack (confirmed through webpack
compilation spans in `.next/dev/trace`). One homepage request before the change
returned HTTP 200 in **8.91 s** (8.29 s to first byte). After config reload, a
request returned HTTP 200 in **4.58 s** (4.04 s to first byte), and a repeat
visit returned HTTP 200 in **0.30 s** (0.297 s to first byte). These are live
observations with different cache states and other browser tabs making requests,
not a controlled A/B benchmark or proof of a fixed 5–10 minute delay. Current
swap usage during the investigation was about **10.7 GB**; this remains an 8 GB
machine with substantial system-wide memory demands.

Configuration checks verify the development values, override validation, retained
source-map/cache settings, and absence of the callback in production. Targeted
ESLint and formatting checks also pass. No production build is needed for these
internal development settings.
