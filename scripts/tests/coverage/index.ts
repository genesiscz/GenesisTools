#!/usr/bin/env bun
/**
 * Test coverage of the whole suite, per area, with the skipped tests and the slowest files.
 *
 *   bun scripts/tests/coverage/index.ts                  # the default run, gates as on CI
 *   bun scripts/tests/coverage/index.ts --gates safe     # plus every gate audited safe on a Mac
 *   bun scripts/tests/coverage/index.ts --gates darwinkit,integration src/utils
 *   bun scripts/tests/coverage/index.ts --from <dir>     # re-render an earlier run, run nothing
 *
 * It runs the suite through the repo's wrapper (`scripts/test.ts`, never bare `bun test`) with
 * bun's lcov and junit reporters. The wrapper runs a full suite as several `bun test` processes,
 * and each phase writes its own lcov and junit file (`withPhaseOutputs` in scripts/test-args.ts);
 * this script merges them. bun records only files a test loaded, so tracked source files no test
 * imports are listed as "unloaded" and are not inside the percentages.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatTable } from "@genesiscz/utils/table";
import { GATE_ENV_VARS } from "@genesiscz/utils/test/skip";
import { DEFAULT_EXCLUDES } from "../../test-args";
import {
    type AreaRow,
    type CoverageSummary,
    estimateTracked,
    type FileCoverage,
    type GateUse,
    isSourceFile,
    type JunitCase,
    leastCovered,
    mergeCoverage,
    parseJunit,
    parseLcov,
    percent,
    scanGates,
    summarize,
    type TrackedEstimate,
} from "./lib";

const ROOT = dirname(dirname(dirname(import.meta.dir)));

/**
 * The opt-in gates whose tests are safe to run on a developer Mac: they write only inside the test
 * sandbox, spend nothing, touch no keychain, window, terminal or notification, and their resource
 * exists on a Mac with the repo installed. Audited file by file on 2026-10-18; the audit is in the PR
 * that added this list. A gate missing here stays off, whatever `--gates safe` says.
 */
const SAFE_LOCAL_GATES: (keyof typeof GATE_ENV_VARS)[] = [
    "darwinkit",
    "mailInfra",
    "claudeData",
    "localModels",
    "audioDevice",
    "integration",
];

/**
 * Files a safe gate turns on that still stay out of a `--gates safe` run, because one variable covers
 * them together with safe files.
 */
const SAFE_GATE_EXCLUDES: Record<string, string> = {
    // Runs `swift -e` and writes a fixed /tmp path; Swift work on this Mac goes one build at a time.
    "src/darwinkit/__tests__/vision.test.ts": "darwinkit",
    // Installs @lancedb/lancedb over the network and loads a native module that is deleted after the run.
    "src/utils/search/stores/lancedb-vector-store.test.ts": "integration",
    // Its `installed` mode starts the real codex app-server, which now answers account/read with an error
    // (seen 2026-10-18): drift against the installed Codex, not a safety problem.
    "src/codex/lib/terminal-server.test.ts": "integration",
};

const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
        gates: { type: "string" },
        out: { type: "string" },
        from: { type: "string" },
        top: { type: "string", default: "25" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});

if (values.help) {
    process.stdout.write(
        [
            "Usage: bun scripts/tests/coverage/index.ts [paths...] [options]",
            "",
            "  --gates <list>   opt-in gates to turn on: 'safe', or names from src/utils/test/skip.ts",
            "  --out <dir>      where the run writes lcov, junit and the report (default .claude/work/coverage/<time>)",
            "  --from <dir>     render the report of an earlier run without running tests",
            "  --top <n>        rows in the least-covered and slowest lists (default 25)",
            "  --json           print the summary as JSON instead of tables",
            "",
        ].join("\n")
    );
    process.exit(0);
}

function resolveGates(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    const names = raw
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .flatMap((name) => (name === "safe" ? SAFE_LOCAL_GATES : [name]));
    const unknown = names.filter((name) => !(name in GATE_ENV_VARS));

    if (unknown.length > 0) {
        process.stderr.write(
            `unknown gate(s): ${unknown.join(", ")}. Known: ${Object.keys(GATE_ENV_VARS).join(", ")}\n`
        );
        process.exit(2);
    }

    return [...new Set(names)];
}

function filesUnder(dir: string, name: RegExp): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((entry) => name.test(entry))
        .map((entry) => join(dir, entry));
}

function trackedFiles(): string[] {
    const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });

    if (proc.exitCode !== 0) {
        throw new Error(`git ls-files failed (exit ${proc.exitCode})`);
    }

    return proc.stdout.toString().split("\0").filter(Boolean);
}

function excluded(file: string): boolean {
    return DEFAULT_EXCLUDES.some((glob) => new Bun.Glob(glob).match(file));
}

/** The tracked source a run is accountable for: the whole tree, or what lies under the given paths. */
function sourceUniverse(tracked: string[], paths: string[]): string[] {
    const roots = paths.map((path) => relative(ROOT, join(ROOT, path)).replace(/\.test\.tsx?$/, ""));

    return tracked.filter(
        (file) =>
            isSourceFile(file) &&
            !excluded(file) &&
            (roots.length === 0 || roots.some((root) => file === `${root}.ts` || file.startsWith(`${root}/`)))
    );
}

async function runSuite(outDir: string, gates: string[], paths: string[]): Promise<number> {
    const ignores = Object.entries(SAFE_GATE_EXCLUDES)
        .filter(([, gate]) => gates.includes(gate))
        .map(([file]) => `--path-ignore-patterns=${file}`);
    mkdirSync(outDir, { recursive: true });
    const logPath = join(outDir, "test.log");
    const fd = openSync(logPath, "w");
    const env: Record<string, string | undefined> = { ...process.env };

    for (const gate of gates) {
        env[GATE_ENV_VARS[gate as keyof typeof GATE_ENV_VARS]] = "1";
    }

    const argv = [
        "bun",
        "scripts/test.ts",
        "--parallel",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${join(outDir, "lcov")}`,
        "--reporter=junit",
        `--reporter-outfile=${join(outDir, "junit.xml")}`,
        ...ignores,
        ...paths,
    ];
    process.stderr.write(`[coverage] ${argv.join(" ")}\n`);
    process.stderr.write(`[coverage] gates on: ${gates.length > 0 ? gates.join(", ") : "none (as on CI)"}\n`);
    process.stderr.write(`[coverage] test output: ${logPath}\n`);

    const started = performance.now();
    const proc = Bun.spawn(argv, { cwd: ROOT, env, stdin: "ignore", stdout: fd, stderr: fd });
    const code = await proc.exited;
    closeSync(fd);

    const log = readFileSync(logPath, "utf8");
    const markers = log.split("\n").filter((line) => /^\[test\] (phase exits|suite )/.test(line));
    const failures = [...new Set(log.split("\n").filter((line) => line.startsWith("(fail)")))];
    process.stderr.write(`[coverage] suite took ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
    process.stderr.write(`${markers.join("\n")}\n`);

    if (failures.length > 0) {
        process.stderr.write(`[coverage] ${failures.length} failing test(s):\n${failures.slice(0, 30).join("\n")}\n`);
    }

    return code;
}

interface SkipRow {
    file: string;
    skipped: number;
    gates: GateUse[];
}

function skippedByFile(cases: JunitCase[]): SkipRow[] {
    const counts = new Map<string, number>();

    for (const testCase of cases) {
        if (testCase.status === "skip") {
            counts.set(testCase.file, (counts.get(testCase.file) ?? 0) + 1);
        }
    }

    return [...counts.entries()]
        .map(([file, skipped]) => {
            const path = join(ROOT, file);
            const gates = existsSync(path) ? scanGates(readFileSync(path, "utf8"), GATE_ENV_VARS) : [];

            return { file, skipped, gates };
        })
        .sort((a, b) => b.skipped - a.skipped || a.file.localeCompare(b.file));
}

function pct(hit: number, found: number): string {
    return `${percent(hit, found).toFixed(1)}%`;
}

function areaTable(areas: AreaRow[], tracked: TrackedEstimate): string {
    const all = (row: AreaRow) => tracked.areas.get(row.area) ?? row;
    const rows = [...areas]
        .sort((a, b) => all(b).linesFound - all(b).linesHit - (all(a).linesFound - all(a).linesHit))
        .map((row) => [
            row.area,
            pct(all(row).linesHit, all(row).linesFound),
            pct(row.linesHit, row.linesFound),
            pct(row.functionsHit, row.functionsFound),
            String(all(row).linesFound - all(row).linesHit),
            String(row.files),
            String(row.unloadedFiles),
        ]);

    return formatTable(rows, ["AREA", "ALL LINES", "LOADED LINES", "LOADED FUNCS", "UNCOVERED", "FILES", "UNLOADED"], {
        alignRight: [1, 2, 3, 4, 5, 6],
        maxColWidth: 60,
    });
}

function render(options: {
    summary: CoverageSummary;
    tracked: TrackedEstimate;
    skips: SkipRow[];
    cases: JunitCase[];
    fileSeconds: Map<string, number>;
    top: number;
}): string {
    const { summary, tracked, skips, cases, fileSeconds, top } = options;
    const { total } = summary;
    const counts = { pass: 0, fail: 0, skip: 0 };

    for (const testCase of cases) {
        counts[testCase.status]++;
    }

    const least = leastCovered(summary.files, top).map((row) => [
        row.file,
        pct(row.linesHit, row.linesFound),
        String(row.linesFound - row.linesHit),
    ]);
    const slowest = [...fileSeconds.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([file, seconds]) => [file, `${seconds.toFixed(2)} s`]);
    const skipRows = skips.map((row) => [
        row.file,
        String(row.skipped),
        row.gates.length === 0
            ? "(no skip call in the file: a skip inside a shared helper)"
            : [
                  ...new Set(
                      row.gates.map((gate) => (gate.envVar ? `${gate.envVar}` : `${gate.call}(${gate.condition})`))
                  ),
              ]
                  .join("; ")
                  .slice(0, 120),
    ]);

    return [
        `All tracked source: lines ${pct(tracked.linesHit, tracked.linesFound)} (${tracked.linesHit}/${tracked.linesFound}), the ${summary.unloaded.length} file(s) no test imports counted as 0% with an estimated ${tracked.unloadedLines} lines (static count x ${tracked.ratio.toFixed(3)}, measured on the loaded files)`,
        `Loaded files only: lines ${pct(total.linesHit, total.linesFound)} (${total.linesHit}/${total.linesFound}), functions ${pct(total.functionsHit, total.functionsFound)} (${total.functionsHit}/${total.functionsFound}), ${total.files} files`,
        `Tests: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skipped or todo`,
        "",
        "Per area (most uncovered lines first; ALL and UNCOVERED count unloaded files as 0%)",
        areaTable(summary.areas, tracked),
        "",
        `Least covered files (most uncovered lines first, top ${top})`,
        formatTable(least, ["FILE", "LINES", "UNCOVERED"], { alignRight: [1, 2], maxColWidth: 100 }),
        "",
        `Skipped tests by file, and the gate that skips them (${skips.length} file(s))`,
        formatTable(skipRows, ["FILE", "SKIPPED", "WHY"], { alignRight: [1], maxColWidth: 120 }),
        "",
        `Slowest test files by test time (imports not included, top ${top})`,
        formatTable(slowest, ["FILE", "TIME"], { alignRight: [1], maxColWidth: 100 }),
        "",
    ].join("\n");
}

const outDir =
    values.from ??
    values.out ??
    join(ROOT, ".claude", "work", "coverage", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
let exitCode = 0;

if (!values.from) {
    exitCode = await runSuite(outDir, resolveGates(values.gates), positionals);
}

const lcovFiles = filesUnder(outDir, /(^|\/)lcov\.info$/);
const junitFiles = filesUnder(outDir, /^junit[^/]*\.xml$/);

if (lcovFiles.length === 0) {
    process.stderr.write(`[coverage] no lcov.info under ${outDir}: the run wrote no coverage\n`);
    process.exit(exitCode || 1);
}

const merged: Map<string, FileCoverage> = mergeCoverage(lcovFiles.map((file) => parseLcov(readFileSync(file, "utf8"))));
const junit = junitFiles.map((file) => parseJunit(readFileSync(file, "utf8")));
const cases = junit.flatMap((report) => report.cases);
const fileSeconds = new Map<string, number>();

for (const report of junit) {
    for (const [file, seconds] of report.fileSeconds) {
        fileSeconds.set(file, (fileSeconds.get(file) ?? 0) + seconds);
    }
}

const summary = summarize(merged, sourceUniverse(trackedFiles(), positionals));
const tracked = estimateTracked(summary, (file) => readFileSync(join(ROOT, file), "utf8"));
const skips = skippedByFile(cases);
const top = Math.max(1, Number(values.top) || 25);
const text = render({ summary, tracked, skips, cases, fileSeconds, top });
const json = {
    allTracked: {
        linesFound: tracked.linesFound,
        linesHit: tracked.linesHit,
        unloadedLines: tracked.unloadedLines,
        ratio: tracked.ratio,
    },
    total: summary.total,
    areas: summary.areas,
    files: summary.files,
    unloaded: summary.unloaded,
    skipped: skips,
    slowest: [...fileSeconds.entries()].sort((a, b) => b[1] - a[1]).map(([file, seconds]) => ({ file, seconds })),
};

await Bun.write(join(outDir, "report.txt"), text);
await Bun.write(join(outDir, "summary.json"), SafeJSON.stringify(json, null, 2));
process.stdout.write(values.json ? `${SafeJSON.stringify(json, null, 2)}\n` : text);
process.stderr.write(`[coverage] report: ${join(outDir, "report.txt")}, data: ${join(outDir, "summary.json")}\n`);
process.exit(exitCode);
