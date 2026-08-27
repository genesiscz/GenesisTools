#!/usr/bin/env bun
/**
 * Entrypoint-import guard (2026-08-27, after the whole suite stopped finishing).
 *
 * THE BUG THIS CATCHES. A tool's `index.ts` ends by RUNNING the CLI at module
 * top level:
 *
 *     await runTool(program, { tool: "transcribe" });
 *
 * That is fine when Bun executes the file. It is fatal when a test *imports* it
 * for a helper, because an import evaluates the module — so collecting the test
 * launches the CLI, which reaches an interactive prompt and blocks forever.
 *
 * `src/transcribe/transcribe.test.ts` imported `formatOutput`/`toSRT`/`toVTT`
 * from `./index` and did exactly that. `bun run test` never terminated; CI's
 * "full suite" step died on its 4-minute timeout and, because that step is
 * `continue-on-error: true`, nothing surfaced it. Every PR's test signal was a
 * timeout rather than a pass for at least a day. After the fix the same suite
 * finishes in 55s with 7201 passing.
 *
 * WHAT IT CHECKS. Not "every entrypoint must be guarded" — 40-odd tools run
 * unguarded quite happily, because nothing imports them. The hang needs BOTH
 * halves, so the guard fails only on the intersection:
 *
 *   1. a module whose top level invokes the CLI runner without `import.meta.main`
 *   2. AND a test file that imports that module
 *
 * That keeps it precise: it fires on the situation that actually hangs, and it
 * fires the moment someone adds the import — before the suite starts timing out.
 *
 * THE FIX, when it fires: wrap the call in `if (import.meta.main) { … }`, which
 * is the existing convention (`src/time-machine/index.ts` has the same
 * test-imports-entrypoint shape and was already guarded). If the imported
 * helper is genuinely library code, the better fix is to move it into
 * `src/<tool>/lib/` and import it from there.
 */
import { $ } from "bun";

/** Top-level invocations that hand control to the CLI. */
const RUNNER_CALL = /^\s*(?:await\s+)?(?:runTool\s*\(|main\s*\(\s*\)|program\s*\.\s*parse(?:Async)?\s*\()/;

async function trackedFiles(pattern: string): Promise<string[]> {
    const result = await $`git ls-files ${pattern}`.nothrow().quiet();

    if (result.exitCode !== 0) {
        console.error(`::error:: \`git ls-files\` failed (exit ${result.exitCode}) — refusing to report a clean scan.`);
        process.exit(1);
    }

    return result.stdout.toString().split("\n").filter(Boolean);
}

/** Remove the brace-matched body that follows the first `{` at or after `from`. */
function cutBlock(source: string, from: number): string {
    const open = source.indexOf("{", from);

    if (open === -1) {
        return source;
    }

    let depth = 0;

    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") {
            depth++;
        } else if (source[i] === "}") {
            depth--;

            if (depth === 0) {
                return source.slice(0, from) + source.slice(i + 1);
            }
        }
    }

    return source.slice(0, from);
}

/** Drop every block whose opening line matches `head`, innermost-safe by re-scanning. */
function cutAll(source: string, head: RegExp): string {
    let out = source;

    for (;;) {
        const m = head.exec(out);

        if (!m) {
            return out;
        }

        const next = cutBlock(out, m.index);

        if (next === out) {
            return out;
        }

        out = next;
    }
}

/**
 * Does this module hand control to the CLI when merely imported?
 *
 * Function bodies are removed first — `await runTool(...)` INSIDE
 * `async function main()` is a definition, not an invocation, and an early
 * version of this guard reported every tool in the repo because of it. Then the
 * `if (import.meta.main)` blocks go, since that is precisely the fix. Whatever
 * runner call survives both cuts is reached by a bare `import`.
 */
function runsOnImport(source: string): boolean {
    const withoutFunctions = cutAll(source, /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m);
    const withoutGuard = cutAll(withoutFunctions, /^\s*if\s*\(\s*import\.meta\.main\s*\)/m);

    return withoutGuard.split("\n").some((line) => RUNNER_CALL.test(line));
}

/** `./index`, `../index`, `./index.ts`, `@app/<tool>/index` — all reach the same module. */
function importsFrom(source: string, moduleDir: string, toolName: string): boolean {
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

    return specifiers.some((spec) => {
        const bare = spec.replace(/\.tsx?$/, "");
        if (bare === "./index" || bare === "../index") {
            return true;
        }

        return bare === `@app/${toolName}/index` || bare === `@app/${toolName}` || bare === moduleDir;
    });
}

const entrypoints = await trackedFiles("src/*/index.ts");

// One `git ls-files` for every test in the repo, then group in memory. Asking
// git once per tool cost ~735 ms against ~148 ms for a comparable guard, all of
// it subprocess spawns.
const testsByTool = new Map<string, string[]>();

for (const file of await trackedFiles("src/")) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) {
        continue;
    }

    const tool = file.split("/")[1];
    const bucket = testsByTool.get(tool);

    if (bucket) {
        bucket.push(file);
    } else {
        testsByTool.set(tool, [file]);
    }
}

const offenders: { entry: string; test: string }[] = [];

for (const entry of entrypoints) {
    const source = await Bun.file(entry).text();

    if (!runsOnImport(source)) {
        continue;
    }

    const toolName = entry.split("/")[1];
    const moduleDir = `src/${toolName}/index`;

    // NB: never `git ls-files "src/x/**/*.test.ts"` — that matches NOTHING,
    // because git's `*` already crosses `/`, so `**/` is two stars and a slash
    // no path contains. An earlier version used it, found zero tests, and passed
    // with the planted bug sitting in front of it.
    for (const test of testsByTool.get(toolName) ?? []) {
        const testSource = await Bun.file(test).text();

        if (importsFrom(testSource, moduleDir, toolName)) {
            offenders.push({ entry, test });
        }
    }
}

if (offenders.length > 0) {
    for (const { entry, test } of offenders) {
        console.error(`${test}: imports ${entry}, which runs the CLI at module top level`);
    }

    console.error(
        "::error:: a test imports an entrypoint that executes on import — collecting it launches the CLI and the suite hangs. Wrap the runner call in `if (import.meta.main) { … }` (see src/time-machine/index.ts), or move the imported helper into src/<tool>/lib/."
    );
    process.exit(1);
}

console.log(
    `entrypoint-import-guard: OK (${entrypoints.length} entrypoints, none imported by a test while self-running)`
);
