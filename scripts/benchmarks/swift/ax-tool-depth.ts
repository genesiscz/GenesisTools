/**
 * `ax-tool --id` lookup cost against a known accessibility-hierarchy depth.
 *
 * `findByIdentifier` (`native/ax-tool/Sources/main.swift`) recurses the accessibility tree with
 * `maxDepth: 50`. The depth-60 arm of this fixture must stay unfound — that is the cap working —
 * while every sibling walker in the same file caps at 10 or 15. This script builds a fixture app
 * whose third window holds a chain of nested `NSBox`es of a chosen depth with one button at the
 * bottom, then times `ax-tool get --id deep-leaf` against it.
 *
 * ONE NSBox IS ONE ACCESSIBILITY LEVEL, measured, not assumed: with a 60-box chain the leaf first
 * appears at `ax-tool list --depth 61`. So a `maxDepth` of 15 puts the leaf out of reach at every
 * depth measured here except the depth-10 control arm.
 *
 * That makes `foundAtDepth*` a BEHAVIOUR FACT, not a regression metric. It is recorded into the
 * baseline and printed, but never handed to `compareToBaseline`: after the cap lands it flips
 * 1 → 0 by design, and a comparison would have to call that either a pass or a failure when it is
 * neither. The depth-10 arm is the negative control — it must stay found and stay fast, or the cap
 * broke ordinary lookups instead of bounding pathological ones.
 *
 * Wall time here is mostly process startup: the launcher plus `ax-tool` cost about 49 ms before
 * any accessibility call happens, so the depth signal rides on top of a large constant. Read these
 * numbers as "an `--id` lookup still costs what it used to", not as a measurement of the walk.
 *
 * Usage:
 *   bun scripts/benchmarks/swift/ax-tool-depth.ts [--runs 5] [--depths 10,20,40,60] [--json]
 *   bun scripts/benchmarks/swift/ax-tool-depth.ts --runs 1 --depths 20   # smoke, not a measurement
 *   bun scripts/benchmarks/swift/ax-tool-depth.ts --baseline [name]
 *   bun scripts/benchmarks/swift/ax-tool-depth.ts --compare [name]
 *
 * Requires the Accessibility grant on GenesisTools.app — check with `tools macos permissions`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { ensureBinary } from "@app/control/lib/runner";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";

const { log } = logger.scoped("bench-ax-depth");

const DEFAULT_BASELINE = "swift-ax-tool-depth";
/** 10 is the negative control: it stays inside any sane cap and must keep working. */
const DEFAULT_DEPTHS = [10, 20, 40, 60];
/** Deeper than `collectElements` and `collectFramedElements` cap at, so a cap makes it unfindable. */
const SHALLOW_ENOUGH_FOR_ANY_CAP = 15;
/** A recorded number needs samples; a smoke run does not. See scripts/benchmarks/README.md rule 6. */
const MIN_RUNS_FOR_A_BASELINE = 5;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const FIXTURE_SOURCE = join(REPO_ROOT, "native/ax-tool/Fixtures/ControlFixture.swift");
const READY_TIMEOUT_MS = 25_000;
const LOOKUP_TIMEOUT_MS = 20_000;

interface Sample {
    ms: number;
    exitCode: number;
    found: boolean;
}

interface Fixture {
    depth: number;
    pid: number;
    launcher: Bun.Subprocess;
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

function parseDepths(raw: string): number[] {
    const parsed = raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

    if (parsed.length === 0) {
        throw new Error(`--depths needs a comma-separated list of positive integers, received "${raw}"`);
    }

    return parsed;
}

/**
 * Is the Accessibility grant actually in place?
 *
 * Asked directly rather than inferred from a lookup. Without the grant `axWindows` returns nothing
 * and `--id` answers "element not found", which is the same answer a working depth cap gives — so
 * a missing grant would otherwise record as a measurement instead of an instrument failure.
 */
function accessibilityGranted(command: string[]): boolean {
    const result = Bun.spawnSync([...command, "permissions"], {
        cwd: REPO_ROOT,
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: LOOKUP_TIMEOUT_MS,
    });

    try {
        const parsed = SafeJSON.parse(result.stdout.toString().trim(), { strict: true }) as {
            accessibility?: boolean;
        };
        return parsed.accessibility === true;
    } catch (err) {
        log.warn({ err, stderr: result.stderr.toString().trim() }, "ax-tool permissions gave no parseable answer");
        return false;
    }
}

function shell(argv: string[]): string {
    const result = Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
        log.warn({ argv, exitCode: result.exitCode, stderr: result.stderr.toString().trim() }, "probe command failed");
        return "unknown";
    }

    return result.stdout.toString().trim();
}

function buildFixtureBundle(directory: string): string {
    const bundle = join(directory, "ControlFixture.app");
    const executableDir = join(bundle, "Contents", "MacOS");
    mkdirSync(executableDir, { recursive: true });
    const binary = join(executableDir, "control-fixture");
    writeFileSync(
        join(bundle, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>control-fixture</string>
<key>CFBundleIdentifier</key><string>com.genesiscz.control-fixture</string>
<key>CFBundleName</key><string>ControlFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
    );
    const build = Bun.spawnSync(["swiftc", FIXTURE_SOURCE, "-o", binary], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
    });

    if (build.exitCode !== 0) {
        throw new Error(`fixture build failed (${build.exitCode}):\n${build.stderr.toString().slice(-4000)}`);
    }

    log.info({ binary }, "control fixture built");
    return bundle;
}

async function launchFixture(bundle: string, directory: string, depth: number): Promise<Fixture> {
    const readyPath = join(directory, `ready-${depth}.log`);
    const errorPath = join(directory, `stderr-${depth}.log`);
    // -g keeps the fixture behind whatever the user is looking at; --background stops the fixture
    // itself from activating. A benchmark must not steal focus for the minute it runs.
    const launcher = Bun.spawn(
        [
            "open",
            "-n",
            "-W",
            "-g",
            "--stdout",
            readyPath,
            "--stderr",
            errorPath,
            bundle,
            "--args",
            "--background",
            "--deep-depth",
            String(depth),
        ],
        { env: env.getProcessEnv(), stdout: "ignore", stderr: "pipe" }
    );
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let pid = 0;

    while (Date.now() < deadline && pid === 0) {
        if (existsSync(readyPath)) {
            const match = readFileSync(readyPath, "utf8").match(/ready:(\d+) deep:(\d+)/);

            if (match) {
                pid = Number(match[1]);

                if (Number(match[2]) !== depth) {
                    throw new Error(`fixture reported depth ${match[2]}, asked for ${depth}`);
                }
            }
        }

        if (pid === 0) {
            await Bun.sleep(100);
        }
    }

    if (pid === 0) {
        const stderr = existsSync(errorPath) ? readFileSync(errorPath, "utf8") : "";
        throw new Error(`fixture at depth ${depth} never reported ready.\nstderr: ${stderr}`);
    }

    log.info({ depth, pid }, "control fixture ready");
    return { depth, pid, launcher };
}

function killFixture(fixture: Fixture, fixtureBinary: string): void {
    const identity = classifyPid(fixture.pid, (command) => {
        const trimmed = command.trim();
        return trimmed === fixtureBinary || trimmed.startsWith(`${fixtureBinary} `);
    });

    if (identity.status === "live") {
        try {
            // pid-verified: classifyPid matched the exact temporary fixture binary path first.
            process.kill(fixture.pid, "SIGTERM");
        } catch (err) {
            log.warn({ err, pid: fixture.pid }, "fixture cleanup signal failed");
        }
    } else {
        log.warn({ pid: fixture.pid, status: identity.status }, "skipping unverified fixture signal");
    }

    try {
        fixture.launcher.kill();
    } catch (err) {
        log.warn({ err, depth: fixture.depth }, "fixture launcher cleanup failed");
    }
}

function lookup(command: string[], pid: number): Sample {
    const argv = [...command, "get", "--app", String(pid), "--id", "deep-leaf"];
    const started = performance.now();
    const result = Bun.spawnSync(argv, {
        cwd: REPO_ROOT,
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: LOOKUP_TIMEOUT_MS,
    });
    const ms = performance.now() - started;
    const stdout = result.stdout.toString().trim();
    let found = false;

    try {
        const parsed = SafeJSON.parse(stdout, { strict: true }) as { ok?: boolean; axId?: string };
        found = parsed.ok === true && parsed.axId === "deep-leaf";
    } catch (err) {
        log.debug({ err, stdout: stdout.slice(0, 200) }, "lookup returned no parseable envelope");
    }

    return { ms, exitCode: result.exitCode ?? -1, found };
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * How much the machine's load changed between recording and comparing.
 *
 * These are wall-time numbers on a shared desktop. At a one-minute load average near 80 the same
 * command's median moved 24 % between two consecutive runs with no code change at all, which is
 * larger than the tolerance a comparison uses. Printing both loads is what stops that from being
 * read as a regression.
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

const DEPTHS = parseDepths(flagValue("--depths", DEFAULT_DEPTHS.join(",")));
const runs = Math.max(1, Number(flagValue("--runs", String(MIN_RUNS_FOR_A_BASELINE))) || MIN_RUNS_FOR_A_BASELINE);
const wantsJson = hasFlag("--json");
const baselineName = hasFlag("--baseline") ? flagValue("--baseline", DEFAULT_BASELINE) : null;
const compareName = hasFlag("--compare") ? flagValue("--compare", DEFAULT_BASELINE) : null;

// A smoke run may use one sample; a recorded number may not. One sample cannot support a
// confidence claim at all, and a baseline is read months later by someone who was not here.
if ((baselineName !== null || compareName !== null) && runs < MIN_RUNS_FOR_A_BASELINE) {
    out.log.error(
        `--runs ${runs} is a smoke run, not a measurement. Recording or comparing needs at least ` +
            `${MIN_RUNS_FOR_A_BASELINE} samples per arm, and both sides must use the same --runs.`
    );
    process.exit(1);
}

const axBinary = ensureBinary();
const appLauncher = installedGenesisAppLauncher();
// Accessibility is granted to GenesisTools.app, so every ax-tool call re-enters through the
// launcher exactly as src/control/lib/runner.ts does. Measuring the unwrapped binary would
// measure a permission-denied path.
const command = appLauncher === null ? [axBinary] : [appLauncher, axBinary];

if (appLauncher === null) {
    out.log.warn("GenesisTools.app launcher not found; ax-tool runs unwrapped and may lack the Accessibility grant.");
}

if (!accessibilityGranted(command)) {
    out.log.error(
        "ax-tool reports the Accessibility grant is missing, so every --id lookup would answer " +
            "not-found and record as a measurement. Grant it, then re-run: tools macos permissions"
    );
    process.exit(1);
}

const directory = realpathSync(mkdtempSync(join(tmpdir(), "bench-ax-depth-")));
const bundle = buildFixtureBundle(directory);
const fixtureBinary = join(bundle, "Contents", "MacOS", "control-fixture");
const fixtures: Fixture[] = [];
const samples = new Map<number, Sample[]>();

try {
    for (const depth of DEPTHS) {
        fixtures.push(await launchFixture(bundle, directory, depth));
        samples.set(depth, []);
    }

    // Warmup, untimed: the first accessibility call into an app pays for building its tree, and
    // that cost belongs to no arm in particular.
    for (const fixture of fixtures) {
        const warm = lookup(command, fixture.pid);

        // A shallow arm that cannot be found is broken plumbing, not a depth cap: nothing sane
        // caps below 15. The grant itself was already checked directly, so this catches the rest
        // (a fixture that drew no deep window, a leaf that lost its identifier).
        if (fixture.depth <= SHALLOW_ENOUGH_FOR_ANY_CAP && !warm.found) {
            throw new Error(
                `depth ${fixture.depth} could not find deep-leaf (exit ${warm.exitCode}), and no depth ` +
                    "cap reaches that shallow. That is an instrument failure, not a measurement."
            );
        }
    }

    // Interleaved: one round touches every depth, so a load change during the run cannot land on
    // one arm alone.
    for (let round = 0; round < runs; round++) {
        for (const fixture of fixtures) {
            samples.get(fixture.depth)?.push(lookup(command, fixture.pid));
        }
    }
} finally {
    for (const fixture of fixtures) {
        killFixture(fixture, fixtureBinary);
    }

    await Promise.all(fixtures.map((fixture) => fixture.launcher.exited));
}

const perDepth = DEPTHS.map((depth) => {
    const rows = samples.get(depth) ?? [];
    const times = rows.map((row) => row.ms);
    return {
        depth,
        medianMs: median(times),
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        found: rows.every((row) => row.found),
        exitCode: rows[rows.length - 1]?.exitCode ?? -1,
    };
});

/** Latency plus the exit code: the numbers a fix must not move. */
const metrics: Record<string, number> = {};
/** Behaviour facts: recorded and printed, never compared. A depth cap flips these on purpose. */
const facts: Record<string, number> = {};

for (const row of perDepth) {
    metrics[`findMsAtDepth${row.depth}`] = Number(row.medianMs.toFixed(2));
    // The minimum is the decidable row on a shared machine. Measured across consecutive runs at a
    // one-minute load average between 57 and 79, medians of the same command moved 26 % while
    // minimums moved 4 %. A preempted sample only ever adds time, so the minimum estimates the
    // uncontended cost and the median estimates the machine's mood.
    metrics[`findMinMsAtDepth${row.depth}`] = Number(row.minMs.toFixed(2));
    facts[`foundAtDepth${row.depth}`] = row.found ? 1 : 0;
}

// Named after the deepest arm actually measured, never a hardcoded 60: with `--depths 20` a
// metric called `findExitCodeAtDepth60` would be a lie, and a baseline outlives the person who
// knows which flags produced it.
//
// Left out of `lowerIsBetter` on purpose, so it compares higher-is-better and the 0 → 1 the depth
// cap produces reads as a pass. The exit code is recorded to show the not-found path is the
// documented one, not to gate on it.
const deepest = perDepth.reduce((worst, row) => (row.depth > worst.depth ? row : worst), perDepth[0]);
metrics[`findExitCodeAtDepth${deepest.depth}`] = deepest.exitCode;

renderCliHeader("ax-tool --id lookup by hierarchy depth", `median of ${runs} interleaved runs`);
const table = createBoxTable(["NSBOX DEPTH", "MEDIAN ms", "MIN ms", "MAX ms", "FOUND", "EXIT"]);

for (const row of perDepth) {
    table.push([
        pc.white(`${row.depth}${row.depth <= SHALLOW_ENOUGH_FOR_ANY_CAP ? " (control)" : ""}`),
        row.medianMs.toFixed(2),
        row.minMs.toFixed(2),
        row.maxMs.toFixed(2),
        formatDotStatus(row.found ? "ok" : "warn", row.found ? "found" : "not found"),
        String(row.exitCode),
    ]);
}

out.println(table.toString());
renderCliSection("Reading this");
out.println("  One nested NSBox is one accessibility level; the leaf sits one level below the chain.");
out.println("  FOUND is a behaviour fact, not a metric. A maxDepth of 15 turns every non-control arm");
out.println("  into a fast not-found, which is the fix working, not a regression.");
out.println("  Most of each millisecond figure is process startup, shared by every arm.");
out.println("  MIN is the row to judge by under load; MEDIAN tracks what else the machine is doing.");

const uptime = shell(["uptime"]);
const commit = shell(["git", "rev-parse", "--short", "HEAD"]);
const axMtime = existsSync(axBinary) ? statSync(axBinary).mtime.toISOString() : "unknown";
const notes = `commit ${commit}; uptime ${uptime}; ax-tool mtime ${axMtime}; runs ${runs}; depths ${DEPTHS.join(",")}`;
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
        lowerIsBetter: DEPTHS.flatMap((depth) => [`findMsAtDepth${depth}`, `findMinMsAtDepth${depth}`]),
    });
    out.println("");
    out.println(formatComparison(cmp));

    if (cmp.baseline !== null) {
        renderCliSection("Behaviour facts (not compared)");

        for (const [name, after] of Object.entries(facts)) {
            const before = cmp.baseline.metrics[name];
            const beforeText = before === undefined ? "not recorded" : before === 1 ? "found" : "not found";
            out.println(`  ${name}: ${beforeText} -> ${after === 1 ? "found" : "not found"}`);
        }

        renderCliSection("Is this comparison decidable?");

        for (const line of loadAdvice(cmp.baseline.loadAvg, loadavg())) {
            out.println(line);
        }
    }

    comparison = { ok: cmp.ok, deltas: cmp.deltas, missing: cmp.missing };
    process.exitCode = cmp.ok ? 0 : 1;
}

if (wantsJson) {
    out.result({
        ok: true,
        runs,
        depths: DEPTHS,
        metrics,
        facts,
        perDepth,
        notes,
        ...(comparison === undefined ? {} : { comparison }),
    });
}
