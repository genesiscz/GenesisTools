/**
 * Round-trip cost of the read-only `GenesisTools --rpc` methods.
 *
 * `runRpc` (`src/macos/GenesisTools/Sources/Notify.swift`) ends in `NSApplication.run()` and only
 * `notify.authorize` arms a deadline, so `notify.post`, `notify.remove`, `notify.list` and
 * `notify.status` wait forever on a wedged `usernoted`. The fix arms one cancellable deadline at
 * the top of `runRpc`. This script is the latency side of that change: arming a timer must not
 * make the answer slower, and a deadline that never fires must not change the answer at all.
 *
 * It does NOT prove the deadline fires. That needs a wedged `usernoted`, which this script has no
 * way to produce; the orchestrator proves it separately.
 *
 * Three methods, all read-only against the real notification daemon:
 *   - `rpc.hello`    — no XPC at all, so it measures app start plus the run loop. The floor.
 *   - `notify.status` — one `getNotificationSettings` XPC round trip.
 *   - `notify.list`   — one `getDeliveredNotifications` XPC round trip, payload-sized.
 *
 * `notify.post` and `notify.remove` are deliberately absent: posting writes a real banner into the
 * user's Notification Center, and a benchmark has no business doing that ten times in a row.
 *
 * Usage:
 *   bun scripts/benchmarks/swift/notify-rpc.ts [--runs 10] [--json]
 *   bun scripts/benchmarks/swift/notify-rpc.ts --runs 1        # smoke, not a measurement
 *   bun scripts/benchmarks/swift/notify-rpc.ts --baseline [name]
 *   bun scripts/benchmarks/swift/notify-rpc.ts --compare [name]
 */

import { existsSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";

const { log } = logger.scoped("bench-notify-rpc");

const DEFAULT_BASELINE = "swift-notify-rpc";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const METHODS = ["rpc.hello", "notify.status", "notify.list"];
/** Metric-name stem per method: `rpc.hello` → `hello`, `notify.status` → `status`. */
const STEMS: Record<string, string> = { "rpc.hello": "hello", "notify.status": "status", "notify.list": "list" };
const RPC_TIMEOUT_MS = 30_000;
const DEFAULT_RUNS = 10;
/** A recorded number needs samples; a smoke run does not. See scripts/benchmarks/README.md rule 6. */
const MIN_RUNS_FOR_A_BASELINE = 5;

interface Sample {
    ms: number;
    exitCode: number;
    ok: boolean;
    /** `notify.list` only: how many notifications the answer carried. */
    notificationCount: number | null;
}

function flagValue(flag: string, fallback: string): string {
    const index = Bun.argv.indexOf(flag);

    if (index === -1) {
        return fallback;
    }

    const next = Bun.argv[index + 1];
    return next === undefined || next.startsWith("-") ? fallback : next;
}

function hasFlag(flag: string): boolean {
    return Bun.argv.includes(flag);
}

function shell(argv: string[]): string {
    const result = Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
        log.warn({ argv, exitCode: result.exitCode, stderr: result.stderr.toString().trim() }, "probe command failed");
        return "unknown";
    }

    return result.stdout.toString().trim();
}

function callRpc(binary: string, method: string): Sample {
    const started = performance.now();
    const result = Bun.spawnSync([binary, "--rpc", SafeJSON.stringify({ method })], {
        cwd: REPO_ROOT,
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: RPC_TIMEOUT_MS,
    });
    const ms = performance.now() - started;
    const stdout = result.stdout.toString().trim();
    let ok = false;
    let notificationCount: number | null = null;

    try {
        const parsed = SafeJSON.parse(stdout, { strict: true }) as {
            ok?: boolean;
            result?: { notifications?: unknown[] };
        };
        ok = parsed.ok === true;
        notificationCount = parsed.result?.notifications?.length ?? null;
    } catch (err) {
        log.debug({ err, method, stdout: stdout.slice(0, 200) }, "rpc returned no parseable envelope");
    }

    return { ms, exitCode: result.exitCode ?? -1, ok, notificationCount };
}

/**
 * How much the machine's load changed between recording and comparing.
 *
 * These are wall-time numbers on a shared desktop. At a one-minute load average near 80 the
 * same command's median moved 24 % between two consecutive runs of this script with no code
 * change at all, which is larger than the tolerance a comparison uses. Printing both loads is
 * what stops that from being read as a regression.
 */
function loadAdvice(before: number[], after: number[]): string[] {
    const beforeOne = before[0] ?? 0;
    const afterOne = after[0] ?? 0;
    const lines = [
        `  Load average then: ${before.map((n) => n.toFixed(2)).join(" ")}`,
        `  Load average now:  ${after.map((n) => n.toFixed(2)).join(" ")}`,
    ];
    const ratio = beforeOne === 0 ? 1 : afterOne / beforeOne;

    if (afterOne > 8 || beforeOne > 8 || ratio > 1.5 || ratio < 0.67) {
        lines.push(
            "  Warning: these loads are far apart, or high. A wall-time delta here is not decidable;",
            "  re-run both arms on a quiet machine before believing a REGRESSED row."
        );
    }

    return lines;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const runs = Math.max(1, Number(flagValue("--runs", String(DEFAULT_RUNS))) || DEFAULT_RUNS);
const wantsJson = hasFlag("--json");
const baselineName = hasFlag("--baseline") ? flagValue("--baseline", DEFAULT_BASELINE) : null;
const compareName = hasFlag("--compare") ? flagValue("--compare", DEFAULT_BASELINE) : null;
const binary = genesisAppLauncherPath();

// A smoke run may use one sample; a recorded number may not. One sample cannot support a
// confidence claim at all, and a baseline is read months later by someone who was not here.
if ((baselineName !== null || compareName !== null) && runs < MIN_RUNS_FOR_A_BASELINE) {
    out.log.error(
        `--runs ${runs} is a smoke run, not a measurement. Recording or comparing needs at least ` +
            `${MIN_RUNS_FOR_A_BASELINE} samples per method, and both sides must use the same --runs.`
    );
    process.exit(1);
}

if (!existsSync(binary)) {
    out.log.error(`GenesisTools.app is not installed at ${binary}. Build and install it with \`bun run app\`.`);
    process.exit(1);
}

const samples = new Map<string, Sample[]>(METHODS.map((method) => [method, []]));

// Warmup, untimed: the first launch pays for a cold bundle and a cold connection to usernoted.
for (const method of METHODS) {
    const warm = callRpc(binary, method);

    if (!warm.ok) {
        out.log.error(`${method} answered with ok=false (exit ${warm.exitCode}); the numbers below would be noise.`);
        process.exit(1);
    }
}

// Interleaved: one round calls every method, so a load change cannot land on one method alone.
for (let round = 0; round < runs; round++) {
    for (const method of METHODS) {
        samples.get(method)?.push(callRpc(binary, method));
    }
}

const perMethod = METHODS.map((method) => {
    const rows = samples.get(method) ?? [];
    const times = rows.map((row) => row.ms);
    return {
        method,
        stem: STEMS[method],
        medianMs: median(times),
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        ok: rows.every((row) => row.ok),
        exitCode: rows[rows.length - 1]?.exitCode ?? -1,
        notificationCount: rows[rows.length - 1]?.notificationCount ?? null,
    };
});

const metrics: Record<string, number> = {};

for (const row of perMethod) {
    metrics[`${row.stem}Ms`] = Number(row.medianMs.toFixed(2));
    // The minimum is the decidable row on a shared machine. Measured across three consecutive
    // runs of this script at a one-minute load average between 57 and 79, the medians moved 26 %
    // (86.08 → 91.93 → 117.19 ms for rpc.hello) while the minimums moved 4 %
    // (65.86 → 71.22 → 68.01 ms). A preempted sample only ever adds time, so the minimum
    // estimates the uncontended cost and the median estimates the machine's mood.
    metrics[`${row.stem}MinMs`] = Number(row.minMs.toFixed(2));
    metrics[`${row.stem}ExitCode`] = row.exitCode;
}

/**
 * Recorded and printed, never compared: `notify.list` serializes every delivered notification,
 * so its cost follows whatever is sitting in Notification Center at the time. A reader comparing
 * two `listMs` numbers needs to know whether the payload was the same size.
 */
const listCount = perMethod.find((row) => row.method === "notify.list")?.notificationCount;
const facts: Record<string, number> =
    listCount === null || listCount === undefined ? {} : { listNotificationCount: listCount };

renderCliHeader("GenesisTools --rpc round trip", `median of ${runs} interleaved runs`);
const table = createBoxTable(["METHOD", "MEDIAN ms", "MIN ms", "MAX ms", "ENVELOPE", "EXIT"]);

for (const row of perMethod) {
    table.push([
        pc.white(row.method),
        row.medianMs.toFixed(2),
        row.minMs.toFixed(2),
        row.maxMs.toFixed(2),
        formatDotStatus(row.ok ? "ok" : "err", row.ok ? "ok" : "not ok"),
        String(row.exitCode),
    ]);
}

out.println(table.toString());
renderCliSection("Reading this");
out.println("  rpc.hello is the floor: app start and run loop, no XPC. The other two add one round");
out.println("  trip to usernoted each. Arming a deadline must leave all three where they are.");
out.println("  These run against the real notification daemon and post nothing.");
out.println("  MIN is the row to judge by under load; MEDIAN tracks what else the machine is doing.");

if (facts.listNotificationCount !== undefined) {
    out.println(`  notify.list serialized ${facts.listNotificationCount} delivered notifications this run.`);
}

const uptime = shell(["uptime"]);
const commit = shell(["git", "rev-parse", "--short", "HEAD"]);
const appMtime = statSync(binary).mtime.toISOString();
const notes = `commit ${commit}; uptime ${uptime}; GenesisTools mtime ${appMtime}; runs ${runs}`;
let comparison: unknown;

if (baselineName !== null) {
    const recorded = await recordBaseline({ name: baselineName, metrics: { ...metrics, ...facts }, notes });
    out.println("");
    out.println(`Baseline "${recorded.name}" recorded at commit ${recorded.commit}.`);
}

if (compareName !== null) {
    const cmp = await compareToBaseline({
        name: compareName,
        metrics,
        tolerancePct: 20,
        lowerIsBetter: Object.keys(metrics),
    });
    out.println("");
    out.println(formatComparison(cmp));

    if (cmp.baseline !== null) {
        renderCliSection("Is this comparison decidable?");

        for (const line of loadAdvice(cmp.baseline.loadAvg, loadavg())) {
            out.println(line);
        }

        const beforeCount = cmp.baseline.metrics.listNotificationCount;

        if (beforeCount !== undefined && facts.listNotificationCount !== undefined) {
            out.println(
                `  notify.list payload: ${beforeCount} notifications then, ${facts.listNotificationCount} now.`
            );
        }
    }

    comparison = { ok: cmp.ok, deltas: cmp.deltas, missing: cmp.missing };
    process.exitCode = cmp.ok ? 0 : 1;
}

if (wantsJson) {
    out.result({
        ok: true,
        runs,
        binary,
        metrics,
        facts,
        perMethod,
        notes,
        ...(comparison === undefined ? {} : { comparison }),
    });
}
