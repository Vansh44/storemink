import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    // ★★ NODE BY DEFAULT, jsdom ONLY WHERE IT IS ACTUALLY NEEDED. Every one of
    // the ~490 test files used to pay for a jsdom instance and only 68 use the
    // DOM, so the other 420 were building a browser to test a pure function.
    // It was by far the largest cost in CI: measured on this suite,
    // `environment` fell from 740s of worker time to 37ms and the whole run
    // went 180s -> 38s locally, which on the 2-core GitHub runner is the
    // difference between a 27-minute pipeline and a single-digit one.
    //
    // ★ THE 68 OPT IN PER FILE with `// @vitest-environment jsdom` on line 1,
    // NOT through a glob in this file. A glob is an allowlist, and the coverage
    // `include` note below records what allowlists do here: they describe the
    // files someone remembered to add. A docblock travels with the file when it
    // moves, and a new DOM test that forgets one fails immediately and
    // unambiguously with `document is not defined` -- which is the whole reason
    // it is safe to default to the cheaper environment.
    //
    // ⚠ `.tsx` IS NOT THE RULE. Twelve of the 68 are plain `.test.ts` (they
    // reach for localStorage, window or a portal), and some `.test.tsx` files
    // test pure helpers and run fine in node. The list was derived by running
    // the suite under `--environment node` and taking what actually failed, not
    // by guessing from the extension.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // ★★ EVERY MOCK IS RESET BEFORE EVERY TEST, so a stubbed implementation
    // cannot leak forward into a test that never asked for it. That leak is
    // the single cause behind every order-dependent test this repo has found:
    // `vi.clearAllMocks()` clears CALLS, not IMPLEMENTATIONS, so a
    // `mockResolvedValue` set inside one test survived into all of them, and
    // the offenders were declared LAST in their files so nothing followed them
    // and nothing went red. One hid a razorpay suite charging ₹150 for a ₹200
    // order (CODEBASE.md §8).
    //
    // ★ IT WAS A PREREQUISITE REFACTOR, NOT A FLAG, and that is why it took
    // until now. In this Vitest `mockReset` restores the implementation a mock
    // was CREATED with — so `vi.fn(() => x)` survives and
    // `vi.fn().mockResolvedValue(x)` is WIPED, because that one was created
    // with no implementation at all. This repo used both forms, including at
    // `vi.mock` factory level where nothing re-establishes them per test.
    // Turning the flag on without converting those is a suite that fails for
    // reasons unrelated to the code under test. Four files needed it; the
    // conversions and one genuinely order-dependent describe block landed with
    // this change.
    //
    // ⚠ SO WRITE FACTORY MOCKS AS `vi.fn(impl)`. `vi.fn().mockResolvedValue()`
    // inside a `vi.mock` factory now yields `undefined` from the second test
    // onward — and an undefined return usually fails somewhere other than the
    // line that caused it ("not iterable", a whole-object mismatch, a bogus
    // "Not authenticated"). Per-test overrides in `beforeEach`/`it` are
    // unaffected: they run after the reset.
    //
    // ⚠ IT DOES NOT RETIRE `test:shuffle`. This removes the dominant cause of
    // order-dependence, not the category: module-level mutable state, shared
    // fixtures and holder objects can still couple one test to another, and
    // only running the files in a different order can show that.
    mockReset: true,
    // ★ A GIT WORKTREE IS A SECOND COPY OF THIS REPO, INSIDE IT. Background
    // agents create them under .claude/worktrees/, so test discovery found every
    // spec twice — the run reported 384 files instead of 195, and failures from
    // ANOTHER branch's half-finished work appeared as failures of this one. That
    // is worse than noise: it is a red suite nobody can act on, and the habit it
    // teaches is to ignore the number.
    //
    // `configDefaults.exclude` is SPREAD, not replaced. Assigning a bare array
    // here silently drops vitest's own defaults — node_modules first among them —
    // so the run would then descend into every dependency's shipped tests.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    alias: {
      "@": path.resolve(__dirname, "./"),
      // `server-only` throws when resolved outside an RSC graph; stub it so
      // server modules can be imported directly in unit tests.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // ★ MEASURE EVERYTHING. This used to be an allowlist of ~100 hand-listed
      // files, and the number it printed (63.86%) was not a fact about the
      // codebase — it was a fact about the list. True coverage was 33.77%. An
      // allowlist reports on the code someone remembered to add to it, so the
      // files most likely to be missing are the ones nobody has thought about
      // recently: exactly the ones a coverage report exists to find. The list
      // it replaced had already learned this once — lib/returns, lib/credit and
      // lib/payments were added to it in 2026-08 after the highest-stakes
      // directory in the codebase turned out to be entirely unmeasured, with
      // the number staying reassuring throughout. This generalises that fix
      // instead of waiting to rediscover it per directory.
      //
      // Files that NO test imports are counted too — that is Vitest 4's default
      // (the old `all` flag is gone). It matters: without it a module with zero
      // tests is simply absent from the denominator, so deleting the last test
      // for one makes coverage go UP.
      include: [
        "app/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "proxy.ts",
      ],
      // Everything excluded here is excluded because executing it proves
      // nothing, NOT because it is hard to test.
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/_test-helpers.ts",
        "**/*.d.ts",
        // Introspected from the live database by drizzle-kit. Regenerated, not
        // authored; a test asserting a column exists would assert the
        // generator ran.
        "drizzle/**",
        // Declarative shadcn/ui primitives, vendored from the generator.
        "components/ui/**",
      ],
    },
  },
});
