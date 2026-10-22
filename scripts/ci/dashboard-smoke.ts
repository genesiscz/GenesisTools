#!/usr/bin/env bun
/**
 * Boots every Vite dashboard's dev server on a free port and fetches `/`. A dashboard whose page answers a server
 * error, or that never answers, fails the run, with the server's own error from its log.
 *
 * Why: `tools clarity ui` answered 500 on every page for a day (2026-10-22) because a shared module used Bun's
 * `import.meta.dir` at load time, which Vite's SSR runner does not set. tsc, the tests and the launch's readiness check
 * all passed. lint-rules `no-bun-only-import-meta` now stops that one cause; this run catches any other way a
 * dashboard's server stops rendering.
 *
 *   bun scripts/ci/dashboard-smoke.ts                       every dashboard
 *   bun scripts/ci/dashboard-smoke.ts --only clarity,shops  these
 *   bun scripts/ci/dashboard-smoke.ts --base <ref> [--head <ref>]
 *                                                           only the dashboards that a change between the refs can
 *                                                           reach (shared code and package files reach all of them)
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serverErrorExcerpt, waitForUrlReady } from "@genesiscz/utils/DashboardApp/readiness";
import { isPortInUse } from "@genesiscz/utils/network";

export interface SmokeDashboard {
    name: string;
    /** The Vite config, from the repository root. */
    config: string;
    /** Files under this folder reach only this dashboard. */
    folder: string;
}

export const SMOKE_DASHBOARDS: SmokeDashboard[] = [
    { name: "clarity", config: "src/clarity/ui/vite.config.ts", folder: "src/clarity/" },
    {
        name: "claude-history",
        config: "src/claude-history-dashboard/vite.config.ts",
        folder: "src/claude-history-dashboard/",
    },
    {
        name: "debugging-master",
        config: "src/debugging-master/dashboard/vite.config.ts",
        folder: "src/debugging-master/",
    },
    { name: "dev-dashboard", config: "src/dev-dashboard/ui/vite.config.ts", folder: "src/dev-dashboard/" },
    { name: "monitor", config: "src/monitor/ui/vite.config.ts", folder: "src/monitor/" },
    { name: "shops", config: "src/shops/ui/vite.config.ts", folder: "src/shops/" },
    { name: "spotify", config: "src/spotify/ui/vite.config.ts", folder: "src/spotify/" },
    { name: "youtube", config: "src/youtube/ui/vite.config.ts", folder: "src/youtube/ui/" },
];

/** Changes that every dashboard's server can load: the shared modules, the shared UI and the dependency set. */
const REACHES_ALL = /^(?:src\/utils\/|src\/dashboard\/|package\.json$|bun\.lock$|tsconfig[\w.-]*\.json$|bunfig\.toml$)/;
const PARALLEL = 3;
const READY_TIMEOUT_MS = 90_000;
const BROKEN_GRACE_MS = 3_000;
const FIRST_PORT = 39_300;

/** The dashboards a set of changed files can reach. */
export function affectedDashboards(
    changed: string[],
    dashboards: SmokeDashboard[] = SMOKE_DASHBOARDS
): SmokeDashboard[] {
    if (changed.some((file) => REACHES_ALL.test(file))) {
        return dashboards;
    }

    return dashboards.filter((dashboard) => changed.some((file) => file.startsWith(dashboard.folder)));
}

interface SmokeResult {
    name: string;
    ok: boolean;
    seconds: number;
    detail: string;
    excerpt: string[];
    log: string;
}

async function freePort(taken: Set<number>): Promise<number> {
    for (let port = FIRST_PORT; port < FIRST_PORT + 500; port++) {
        if (!taken.has(port) && !(await isPortInUse(port))) {
            taken.add(port);
            return port;
        }
    }

    throw new Error(`no free port from ${FIRST_PORT}`);
}

async function smoke(dashboard: SmokeDashboard, port: number, logDir: string): Promise<SmokeResult> {
    const started = performance.now();
    const log = join(logDir, `${dashboard.name}.log`);
    const vite = resolve("node_modules/vite/bin/vite.js");
    // One descriptor for both streams: Vite prints a server-side render error on stderr.
    const logFd = openSync(log, "a");
    const child = Bun.spawn(
        [
            "bun",
            "--bun",
            vite,
            "dev",
            "-c",
            dashboard.config,
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--strictPort",
        ],
        { stdout: logFd, stderr: logFd, stdin: "ignore", env: { ...process.env, BROWSER: "none" } }
    );
    closeSync(logFd);
    const exited = new AbortController();
    child.exited.then((code) => exited.abort(new Error(`vite exited with code ${code} before it answered`)));

    try {
        const result = await waitForUrlReady(`http://127.0.0.1:${port}/`, READY_TIMEOUT_MS, {
            signal: exited.signal,
            brokenGraceMs: BROKEN_GRACE_MS,
        });
        const seconds = (performance.now() - started) / 1000;

        if (result.broken) {
            return {
                name: dashboard.name,
                ok: false,
                seconds,
                detail: `/ answers ${result.broken.status}: ${result.broken.body}`,
                excerpt: serverErrorExcerpt(log),
                log,
            };
        }

        if (!result.ready) {
            return {
                name: dashboard.name,
                ok: false,
                seconds,
                detail: result.detail ?? "no answer",
                excerpt: serverErrorExcerpt(log),
                log,
            };
        }

        return { name: dashboard.name, ok: true, seconds, detail: result.detail ?? "ready", excerpt: [], log };
    } finally {
        child.kill("SIGTERM");
        const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);

        if (!stopped) {
            child.kill("SIGKILL");
        }
    }
}

function changedFiles(base: string, head: string): string[] {
    const diff = spawnSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" });

    if (diff.status !== 0) {
        throw new Error(`git diff ${base} ${head} failed: ${diff.stderr.trim()}`);
    }

    return diff.stdout.split("\n").filter(Boolean);
}

function option(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
    const only = option(args, "--only")?.split(",");
    const base = option(args, "--base");
    let chosen = SMOKE_DASHBOARDS.filter((dashboard) => existsSync(dashboard.config));

    if (only) {
        chosen = chosen.filter((dashboard) => only.includes(dashboard.name));
    } else if (base) {
        chosen = affectedDashboards(changedFiles(base, option(args, "--head") ?? "HEAD"), chosen);
    }

    if (chosen.length === 0) {
        console.log("dashboard-smoke: no dashboard is affected");
        return 0;
    }

    const logDir = join(tmpdir(), `dashboard-smoke-${process.pid}`);
    mkdirSync(logDir, { recursive: true });
    const taken = new Set<number>();
    const queue = [...chosen];
    const results: SmokeResult[] = [];
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            const result = await smoke(next, await freePort(taken), logDir);
            results.push(result);
            const mark = result.ok ? "✓" : "✗";
            console.log(`${mark} ${result.name} (${result.seconds.toFixed(1)}s): ${result.detail}`);
            for (const line of result.excerpt) {
                console.log(`    ${line}`);
            }

            if (!result.ok) {
                console.log(`    log: ${result.log}`);
            }
        }
    });
    await Promise.all(workers);

    const failed = results.filter((result) => !result.ok);
    console.log(
        failed.length === 0
            ? `dashboard-smoke: ${results.length} dashboard(s) render`
            : `dashboard-smoke: ${failed.length} of ${results.length} dashboard(s) do not render: ${failed.map((r) => r.name).join(", ")}`
    );
    return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
    process.exit(await main(Bun.argv.slice(2)));
}
