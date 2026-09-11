#!/usr/bin/env bun
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { profileArgs } from "./test-args";
import { diagnose, lockStamp, STAMP_FILE } from "./test-deps";

/**
 * `bun test` wrapper that refuses to run against a broken dependency tree.
 *
 * The failure this prevents: inside a git worktree, any `bunx` call creates a
 * PARTIAL `node_modules/` that shadows the parent checkout's complete one. Every
 * subsequent `bun test` then dies with resolution errors like
 * `Cannot find module 'parse5/lib/common/doctype'` across a hundred unrelated
 * files, which reads exactly like the branch broke the world. It cost a real
 * debugging detour before anyone thought to look at `node_modules`.
 *
 * The guard is a handful of `stat` calls (~1ms), so it can sit in front of every
 * run. argv, output and exit code pass straight through — this must be invisible
 * when the tree is healthy.
 */

const ROOT = dirname(import.meta.dir);
const STAMP = join(ROOT, "node_modules", STAMP_FILE);

function warn(message: string): void {
    process.stderr.write(`\x1b[33m[test] ${message}\x1b[0m\n`);
}

async function stampMatches(): Promise<boolean> {
    const file = Bun.file(STAMP);

    if (!(await file.exists())) {
        return false;
    }

    return (await file.text()).trim() === lockStamp(ROOT);
}

async function install(reason: string): Promise<void> {
    warn(`${reason} — running bun install`);

    const proc = Bun.spawn(["bun", "install"], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;

    if (code === 0) {
        await Bun.write(STAMP, lockStamp(ROOT));
        return;
    }

    // A non-zero exit is usually a POSTINSTALL failing (puppeteer downloading a
    // browser, a native build), which says nothing about whether the packages
    // the tests import actually landed. Re-check the tree instead of assuming:
    // blocking a green suite over an unrelated postinstall would make this guard
    // worse than the problem it prevents.
    const stillBroken = diagnose(ROOT);

    if (stillBroken) {
        process.stderr.write(`\x1b[31m[test] bun install failed (exit ${code}) and ${stillBroken}\x1b[0m\n`);
        process.exit(code);
    }

    warn(`bun install exited ${code} (likely a postinstall), but the tree resolves — continuing`);
    // No stamp after a partial install: re-verify next run rather than recording
    // a state we are not sure about.
}

const broken = diagnose(ROOT);

if (broken) {
    await install(broken);
} else if (!(await stampMatches())) {
    // Lockfile moved since the last verified install (branch switch, pull).
    await install("dependencies are stale");
}

/**
 * Standalone sub-projects with their own dependency trees (own package.json,
 * NOT workspace members), whose tests the default sweep includes. Without their
 * install, module resolution fails in ways that read like broken code —
 * apps/eve's `Cannot find module 'eve/channels/auth'` sat in the full suite as
 * a phantom failure for exactly this reason.
 */
const SUBPROJECTS = ["apps/eve"];

for (const rel of SUBPROJECTS) {
    const dir = join(ROOT, rel);

    if (!(await Bun.file(join(dir, "package.json")).exists())) {
        continue;
    }

    // Empty canary list: only the node_modules-missing check applies — the
    // root canaries name root-tree packages a sub-project never has.
    const subBroken = diagnose(dir, []);
    if (!subBroken) {
        continue;
    }

    warn(`${rel}: ${subBroken} — running bun install`);
    const proc = Bun.spawn(["bun", "install"], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;

    if (code !== 0 && diagnose(dir, [])) {
        process.stderr.write(
            `\x1b[31m[test] ${rel}: bun install failed (exit ${code}) and node_modules is still missing\x1b[0m\n`
        );
        process.exit(code);
    }
}

/**
 * Opt-in gates are silent by design: a suite can be green while whole categories
 * (real APIs, e2e, native models, Apple Mail) never ran. Printing the skipped set
 * once per run makes that visible instead of folklore, and names the variable that
 * turns each one on.
 */
/**
 * Mirrors the opt-in gates in src/utils/test/skip.ts.
 *
 * Deliberately duplicated rather than imported: this runner executes BEFORE
 * `bun install` has repaired the dependency tree, and inside a worktree the
 * @genesiscz/utils alias resolves to the main checkout, so importing app code
 * here is exactly the fragility the runner exists to work around.
 * skip.test.ts asserts the two lists stay in step.
 */
const GATE_ENV_VARS: Record<string, string> = {
    network: "RUN_NETWORK_TESTS",
    live: "RUN_LIVE",
    liveSmoke: "RUN_LIVE_SMOKE",
    e2e: "RUN_E2E",
    notifyE2E: "RUN_NOTIFY_E2E",
    wip: "RUN_WIP_E2E",
    darwinkit: "RUN_DARWINKIT",
    solid: "RUN_SOLID",
    mailInfra: "RUN_MAIL_INFRA",
    integration: "RUN_INTEGRATION",
    agentsE2E: "RUN_AGENTS_E2E",
    aiAccounts: "RUN_AI_ACCOUNTS",
    claudeData: "RUN_CLAUDE_DATA",
    localModels: "RUN_LOCAL_MODELS",
    audioDevice: "RUN_AUDIO_DEVICE",
    realApis: "RUN_REAL_APIS",
    spotifyData: "RUN_SPOTIFY_DATA",
};

function describeGates(): { enabled: string[]; disabled: string[] } {
    const enabled: string[] = [];
    const disabled: string[] = [];

    for (const [gate, variable] of Object.entries(GATE_ENV_VARS)) {
        const value = process.env[variable];
        const on = value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false";
        (on ? enabled : disabled).push(gate);
    }

    return { enabled: enabled.sort(), disabled: disabled.sort() };
}

function reportGates(): void {
    if (process.env.GENESIS_TOOLS_TEST_QUIET_GATES === "1") {
        return;
    }

    const { enabled, disabled } = describeGates();

    if (enabled.length > 0) {
        process.stderr.write(`\x1b[32m[test] gates ON: ${enabled.join(", ")}\x1b[0m\n`);
    }

    if (disabled.length > 0) {
        const hints = disabled.map((gate) => GATE_ENV_VARS[gate]).join(" ");
        process.stderr.write(
            `\x1b[90m[test] skipped gates (${disabled.length}): ${disabled.join(", ")}\n` +
                `[test] enable with: ${hints
                    .split(" ")
                    .map((v) => `${v}=1`)
                    .join(" ")}\x1b[0m\n`
        );
    }

    process.stderr.write(`\x1b[90m[test] e2e suites are excluded from this run — use \`bun run test:e2e\`\x1b[0m\n`);

    if (skipDevDashboard()) {
        process.stderr.write(
            `\x1b[90m[test] DevDashboard is excluded (GENESIS_TOOLS_TEST_SKIP_DEVDASHBOARD) — run it with \`bun run test DevDashboard/mobile/src\`\x1b[0m\n`
        );
    }
}

reportGates();

/**
 * Files whose tests are correct but LOAD-SENSITIVE: under the 16x parallel run
 * this machine hits fd/vnode pressure and FSEvents latency, and these suites —
 * real-filesystem walks, watchers, git subprocesses — start failing in ways
 * that vanish the moment they run alone (verified repeatedly: 0 failures in
 * isolation, the same 4-6 failures only inside the full parallel run). A full
 * suite therefore runs them in a SERIAL second phase after the parallel bulk.
 * Targeted runs (explicit paths) are untouched.
 */
const LOAD_SENSITIVE_FILES = [
    "src/utils/fs/disk-usage.test.ts",
    "src/utils/fs/watcher.test.ts",
    "src/macos/lib/clones/audit.test.ts",
    "src/stash/lib/patch.test.ts",
    // Direct native-syscall suites: getattrlistbulk intermittently answers
    // EINVAL under the parallel run's fd/vnode pressure, and these test the
    // syscall itself, so no readdir fallback can absorb it.
    "src/utils/macos/getattrlistbulk.test.ts",
    "src/utils/macos/getattrlistbulk-privatesize.test.ts",
    // @opentui's zig.ts dynamic-imports its per-platform native package at
    // module top level, and under parallel workers that import races into
    // "Cannot access 'default' before initialization" — bun records it as an
    // "Unhandled error between tests": +1 fail, ZERO failing testcases (junit
    // says failures=0), no (fail) line anywhere. This was the long-standing
    // phantom failure in every full run, on master too.
    "src/doctor/ui/tui/views/__tests__/drawer-content-packing.test.ts",
    "src/utils/prompts/p/backend.test.ts",
];

/**
 * Excluded from every full run unless targeted explicitly. These lived only in
 * package.json's `test` script for a long time, which meant a direct
 * `bun scripts/test.ts` (agents do this constantly) silently INCLUDED them —
 * and the e2e suites among them spawn real servers: every such run leaked two
 * orphaned dev-dashboard agents, dozens accumulated over days. The wrapper is
 * the single entrypoint, so the excludes live here.
 */
const DEFAULT_EXCLUDES = [
    "**/dashboard/**",
    "**/dev-dashboard/**",
    "**/claude-history-dashboard/**",
    "**/Internal/**",
    "**/shops/**",
    "**/task/tests/**",
    "**/*.e2e.test.ts",
    "**/matrix-e2e.test.ts",
];

/**
 * DevDashboard is a sub-project carrying three test runners of its own: bun for
 * the mobile unit suites, WDIO for the Appium specs, vitest for the cloud. bun's
 * discovery picks up all three, so the 34 WDIO and Playwright specs error on an
 * undefined `this.skip` and the cloud files cannot load `better-sqlite3` — 30
 * phantom failures that are green under their own runners.
 *
 * Those phantoms are cheap (~1.4s). The real cost is the 55 mobile unit files
 * (~15s locally), and together the tree adds 97 files and ~31s to the ubuntu
 * job — against a 4-minute budget that master already fills to 218.83s. A job
 * killed by that budget writes no `[test] suite complete` marker, which is the
 * ONE thing that turns this workflow red, so the whole run fails without a
 * single test having failed.
 *
 * CI therefore sets the variable below and skips the tree. Nothing changes
 * locally, and a targeted run (`bun run test DevDashboard/mobile/src`) ignores
 * every exclude anyway, so the mobile suites stay one command away.
 */
const DEVDASHBOARD_EXCLUDES = ["**/DevDashboard/**"];

function skipDevDashboard(): boolean {
    const value = process.env.GENESIS_TOOLS_TEST_SKIP_DEVDASHBOARD;

    return value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

const EXCLUDES = skipDevDashboard() ? [...DEFAULT_EXCLUDES, ...DEVDASHBOARD_EXCLUDES] : DEFAULT_EXCLUDES;

// Force NODE_ENV=test even when the caller's shell exports something else:
// two of the keychain safety layers (os-keyring's under-test block and the
// keychainService() sandboxed item name) key off it, and they must hold in
// subprocesses tests spawn, which inherit this env.
const testEnv = { ...process.env, NODE_ENV: "test" };
const args = process.argv.slice(2);
const hasExplicitPaths = args.some((arg) => !arg.startsWith("-"));

async function runBunTest(testArgs: string[]): Promise<number> {
    const proc = Bun.spawn(["bun", "test", ...testArgs], {
        cwd: ROOT,
        stdio: ["inherit", "inherit", "inherit"],
        env: testEnv,
    });

    return await proc.exited;
}

/**
 * The one line CI greps to tell "the suite finished" from "the suite was killed".
 *
 * bun prints its own `Ran N tests across M files.` once per PROCESS, and a full
 * run is TWO processes (the parallel bulk, then the serial load-sensitive
 * phase). That line being present therefore proves only that one of them got
 * there — a stalled serial phase would still show a completed parallel one.
 * This marker is written after every phase has exited, and nowhere else.
 */
function finish(code: number): never {
    process.stderr.write(`[test] suite complete (exit ${code})\n`);
    process.exit(code);
}

// ---------------------------------------------------------------------------
// --profile: one isolated `bun test <file>` per worker, exact wall time per file.
//
// bun's own --parallel run is opaque about time: its junit reporter writes
// time="0" for every suite (bun 1.3.13, serial and parallel alike), and its
// console reporter prints passing files only on GitHub Actions. So when the
// question is "which files are slow", the wrapper answers it itself: a pool of
// isolated processes, wall clock per file, sorted, plus a JSON copy under
// .claude/work/ for anything that wants to diff two runs. Isolation costs a
// module cache per file, so totals here run above a bun-native run; the
// ranking is what this mode is for, not the sum.
//
// Read the ranking with one caveat, measured 2026-09-09: a file that spawns
// child processes in a loop inflates 6-10x under --jobs 8 (ai-credentials-guard
// 22 s in the profile, 2.1 s alone; tdd-gate 20 s vs 2.0 s). That is
// contention, not work, and optimising such a file buys nothing on a machine
// that is not already saturated. Confirm any suspect with --jobs 1 before
// touching it; only a file that stays heavy alone is really heavy.
// ---------------------------------------------------------------------------

interface ProfileRow {
    file: string;
    ms: number;
    pass: number;
    fail: number;
    exitCode: number;
    loadSensitive: boolean;
}

function matchesAny(file: string, patterns: string[]): boolean {
    return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

async function discoverTestFiles(roots: string[]): Promise<string[]> {
    const glob = new Bun.Glob("**/*.test.{ts,tsx}");
    const found = new Set<string>();

    for (const root of roots) {
        if (/\.test\.tsx?$/.test(root)) {
            found.add(root);
            continue;
        }

        for await (const file of glob.scan({ cwd: join(ROOT, root), dot: false })) {
            const relative = root === "." ? file : join(root, file);

            if (relative.includes("node_modules/") || matchesAny(relative, EXCLUDES)) {
                continue;
            }

            found.add(relative);
        }
    }

    return [...found].sort();
}

function countsIn(output: string): { pass: number; fail: number } {
    return {
        pass: Number(/^\s*(\d+) pass$/m.exec(output)?.[1] ?? 0),
        fail: Number(/^\s*(\d+) fail$/m.exec(output)?.[1] ?? 0),
    };
}

async function profileFile(file: string): Promise<ProfileRow> {
    const started = performance.now();
    const proc = Bun.spawn(["bun", "test", file], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: testEnv });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const { pass, fail } = countsIn(`${stdout}\n${stderr}`);

    return {
        file,
        ms: Math.round(performance.now() - started),
        pass,
        fail,
        exitCode,
        loadSensitive: LOAD_SENSITIVE_FILES.includes(file),
    };
}

async function runProfile(jobs: number, roots: string[]): Promise<number> {
    const files = await discoverTestFiles(roots.length > 0 ? roots : ["."]);
    const rows: ProfileRow[] = [];
    const started = performance.now();
    let next = 0;
    process.stderr.write(`\x1b[90m[test] profile: ${files.length} file(s), ${jobs} worker(s)\x1b[0m\n`);

    await Promise.all(
        Array.from({ length: Math.min(jobs, files.length) }, async () => {
            while (next < files.length) {
                const file = files[next++];
                rows.push(await profileFile(file));
            }
        })
    );

    rows.sort((a, b) => b.ms - a.ms);
    const wall = Math.round(performance.now() - started);
    const summed = rows.reduce((sum, row) => sum + row.ms, 0);
    const failed = rows.filter((row) => row.exitCode !== 0);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const report = join(ROOT, ".claude", "work", `test-profile-${stamp}.json`);
    // biome-ignore lint/style/noRestrictedGlobals: this runner executes before node_modules exist, so it cannot import SafeJSON
    await Bun.write(report, JSON.stringify({ wallMs: wall, summedMs: summed, jobs, files: rows }, null, 2));

    const shown = rows.slice(0, 30);
    process.stderr.write(`\n     wall   pass  fail  file  (LS = load-sensitive, runs serially in a normal run)\n`);

    for (const row of shown) {
        const flag = row.loadSensitive ? " LS" : "";
        const status = row.exitCode === 0 ? "" : `  EXIT ${row.exitCode}`;
        process.stderr.write(
            `${String((row.ms / 1000).toFixed(1)).padStart(8)}s ${String(row.pass).padStart(5)} ${String(row.fail).padStart(5)}  ${row.file}${flag}${status}\n`
        );
    }

    process.stderr.write(
        `\n[test] profile: ${rows.length} files, wall ${(wall / 1000).toFixed(0)}s on ${jobs} workers, summed ${(summed / 1000).toFixed(0)}s, ${failed.length} file(s) failed; full table: ${report}\n`
    );

    return failed.length > 0 ? 1 : 0;
}

const profileIndex = args.indexOf("--profile");

if (profileIndex !== -1) {
    const { jobs, roots } = profileArgs(args, Math.min(8, cpus().length));
    finish(await runProfile(jobs, roots));
}

if (hasExplicitPaths) {
    finish(await runBunTest(args));
}

const parallelExit = await runBunTest([
    ...args,
    ...EXCLUDES.map((glob) => `--path-ignore-patterns=${glob}`),
    ...LOAD_SENSITIVE_FILES.map((file) => `--path-ignore-patterns=${file}`),
]);
process.stderr.write(`\x1b[90m[test] serial phase: ${LOAD_SENSITIVE_FILES.length} load-sensitive file(s)\x1b[0m\n`);
const serialExit = await runBunTest([...args.filter((arg) => arg !== "--parallel"), ...LOAD_SENSITIVE_FILES]);

finish(parallelExit !== 0 ? parallelExit : serialExit);
