#!/usr/bin/env bun
/**
 * The 30% read budget: every place the compress work stores data as `.zst` is read by its REAL command, once from
 * plain files and once from the compressed form, in fresh processes, arms interleaved (plain, zst, plain, …). Wall and
 * CPU (the child's rusage, which counts its waited-for children such as rg) and peak RSS per sample; the median per
 * arm and the overhead `zst / plain - 1`. A normalized output hash (`check`) must agree between the arms.
 *
 * Arms are GENESIS_TOOLS_HOME roots built by `arms.ts` from the real data (read-only); the daily pass is switched off
 * in them. Scenarios:
 *   daemon-7d      tools daemon stats --since 7d --json (7 day logs, 5 of them .zst in the zst arm)
 *   daemon-24h     tools daemon stats --json (today and yesterday, plain in both arms: the control)
 *   jev-day        tools jev sessions --day <the largest compressed day>
 *   proxy-large    tools ai-proxy calls --show on the 144 MB transcript
 *   proxy-medium   tools ai-proxy calls --show on a 23 MB transcript
 *   tail-1000      tools markdown resolve of {{tail n=1000}} on a 292 MB day log
 *   rg-day         rg -c of one pattern on that day: plain rg against `rg -z` (the agent path)
 *   cat-rg-day     tools compress cat <day>.zst | rg -c (no zstd CLI needed) against plain rg
 *
 * Usage:
 *   bun scripts/benchmarks/compress/read-paths.ts [--runs 7] [--only daemon-7d,jev-day] [--rebuild] [--baseline] [--json]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { finishBench, median, parseBenchArgs } from "../fs/shared";
import { ARMS, type Arm, armHome, benchDays, buildArm, TRANSCRIPTS } from "./arms";

const BASELINE_NAME = "compress-read-paths";
const REPO = join(import.meta.dir, "..", "..", "..");
const TOOLS = join(REPO, "tools");
const PATTERN = '"msg":"[daemon] task completed"';

interface Scenario {
    name: string;
    /** argv for one sample, or a shell line for a pipe. */
    command: (arm: Arm) => { argv: string[]; before?: () => void; readBack?: () => string };
    /** The part of the output both arms must agree on; default: all of it, normalized. */
    extract?: (output: string) => string;
}

/** daemon stats: the day-log health counts are what the logs feed; the rest moves with the clock and live run logs. */
function daemonHealth(output: string): string {
    const health = (
        SafeJSON.parse(output, { strict: true }) as {
            health: { wedged: number; sampledLate: number; taskTimedOut: number; error: string | null };
        }
    ).health;
    return `${health.wedged}/${health.sampledLate}/${health.taskTimedOut}/${health.error}`;
}

function day(offset: number): string {
    return benchDays()[offset]!;
}

function logFile(arm: Arm, name: string): string {
    const plain = join(armHome(arm), ".genesis-tools", "logs", name);
    return arm === "zst" ? `${plain}.zst` : plain;
}

const SCENARIOS: Scenario[] = [
    {
        name: "daemon-7d",
        command: () => ({ argv: [TOOLS, "daemon", "stats", "--since", "7d", "--json"] }),
        extract: daemonHealth,
    },
    { name: "daemon-24h", command: () => ({ argv: [TOOLS, "daemon", "stats", "--json"] }), extract: daemonHealth },
    { name: "jev-day", command: () => ({ argv: [TOOLS, "jev", "sessions", "--day", day(5)] }) },
    {
        name: "proxy-large",
        command: () => ({
            argv: [TOOLS, "ai-proxy", "calls", "--model", "work/xai/grok-4.3", "--limit", "1", "--show"],
        }),
    },
    {
        name: "proxy-medium",
        command: () => ({
            argv: [
                TOOLS,
                "ai-proxy",
                "calls",
                "--session",
                TRANSCRIPTS.medium.split("/")[1]!.replace(".jsonl", ""),
                "--limit",
                "1",
                "--show",
            ],
        }),
    },
    {
        name: "tail-1000",
        command: (arm) => {
            const md = join(armHome(arm), "tail.md");
            const path = join(armHome(arm), ".genesis-tools", "logs", `${day(2)}.log`);
            return {
                argv: [TOOLS, "markdown", "resolve", md],
                before: () => writeFileSync(md, `# tail\n\n{{tail path="${path}" n=1000}}\n`),
                readBack: () => readFileSync(md, "utf8"),
            };
        },
    },
    {
        name: "rg-day",
        command: (arm) => ({
            argv: [
                "rg",
                "--no-config",
                ...(arm === "zst" ? ["-z"] : []),
                "-F",
                "-c",
                PATTERN,
                logFile(arm, `${day(2)}.log`),
            ],
        }),
    },
    {
        name: "cat-rg-day",
        command: (arm) => ({
            argv:
                arm === "zst"
                    ? [
                          "sh",
                          "-c",
                          `'${TOOLS}' compress cat '${logFile(arm, `${day(2)}.log`)}' | rg --no-config -F -c '${PATTERN}'`,
                      ]
                    : ["rg", "--no-config", "-F", "-c", PATTERN, logFile(arm, `${day(2)}.log`)],
        }),
    },
];

/** The output with everything that names the arm removed: home paths, `.zst` suffixes, timings. */
function normalize(text: string, arm: Arm): string {
    return text
        .replaceAll(armHome(arm), "<home>")
        .replaceAll(".zst", "")
        .replace(/sig=\w+/g, "sig=")
        .replace(/captured [^·]+·/g, "captured ·")
        .replace(/"(durationMs|elapsedMs|generatedAt|now|until|since)":\s*("[^"]*"|\d+)/g, '"$1":0');
}

interface Sample {
    wallMs: number;
    cpuMs: number;
    rssMb: number;
    check: string;
}

async function sample(scenario: Scenario, arm: Arm): Promise<Sample> {
    const { argv, before, readBack } = scenario.command(arm);
    before?.();
    const started = performance.now();
    const proc = Bun.spawn(argv, {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...env.getProcessEnv(),
            GENESIS_TOOLS_HOME: armHome(arm),
            // The arm links the real daemon logs, configs and caches; the commands are read-only diagnostics.
            GENESIS_TOOLS_ALLOW_REAL_HOME_IN_TESTS: "1",
            GENESIS_TOOLS_NO_DAILY_COMPRESS: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
        },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const wallMs = performance.now() - started;

    if (code !== 0) {
        throw new Error(`${scenario.name} ${arm} exited ${code}: ${stderr.slice(0, 600)}`);
    }

    const usage = proc.resourceUsage()!;
    const output = normalize(readBack ? readBack() : stdout, arm);
    return {
        wallMs,
        cpuMs: (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000,
        rssMb: usage.maxRSS / 1e6,
        check: createHash("sha256")
            .update(scenario.extract ? scenario.extract(output) : output)
            .digest("hex")
            .slice(0, 12),
    };
}

const argv = process.argv.slice(2);
const args = parseBenchArgs(
    argv.filter((value, index) => !["--only", "--rebuild"].includes(value) && argv[index - 1] !== "--only")
);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? new Set((argv[onlyIndex + 1] ?? "").split(",")) : null;
const scenarios = SCENARIOS.filter((scenario) => !only || only.has(scenario.name));
const arms = await Promise.all(ARMS.map((arm) => buildArm(arm, { rebuild: argv.includes("--rebuild") })));
const load = async () => (await new Response(Bun.spawn(["uptime"], { stdout: "pipe" }).stdout).text()).trim();
const loadBefore = await load();
const runs: BaselineMetrics[] = [];
/** Per scenario, per run: the plain and the zst check, which must be equal within the run. */
const checks: Record<string, Array<Partial<Record<Arm, string>>>> = {};

for (let index = 0; index < args.warmup + args.runs; index++) {
    const metrics: BaselineMetrics = {};

    for (const scenario of scenarios) {
        // Alternate which arm goes first, so a drift in load hits both.
        const order: Arm[] = index % 2 === 0 ? ["plain", "zst"] : ["zst", "plain"];

        for (const arm of order) {
            const result = await sample(scenario, arm);
            metrics[`${scenario.name}.${arm}.wallMs`] = result.wallMs;
            metrics[`${scenario.name}.${arm}.cpuMs`] = result.cpuMs;
            metrics[`${scenario.name}.${arm}.rssMb`] = result.rssMb;
            const perRun = checks[scenario.name] ?? [];
            perRun[index] = { ...perRun[index], [arm]: result.check };
            checks[scenario.name] = perRun;
        }
    }

    if (index >= args.warmup) {
        runs.push(metrics);
    }
}

const loadAfter = await load();
const mismatched = scenarios.filter((scenario) =>
    (checks[scenario.name] ?? []).some((pair) => !pair.plain || pair.plain !== pair.zst)
);

if (mismatched.length > 0) {
    process.exitCode = 1;
}

/** The budget table: medians per arm and the overhead of reading the compressed form. */
function printBudget(): void {
    const value = (key: string) => median(runs.map((run) => run[key] ?? Number.NaN));
    const delta = (plain: number, zst: number) => `${zst >= plain ? "+" : ""}${((zst / plain - 1) * 100).toFixed(0)}%`;
    renderCliHeader(
        "Read budget (+30% max)",
        `${runs.length} sample(s) per arm · load ${loadBefore.split("averages:")[1]?.trim()}`
    );
    const table = createBoxTable([
        "SCENARIO",
        "WALL PLAIN",
        "WALL ZST",
        "Δ WALL",
        "CPU PLAIN",
        "CPU ZST",
        "Δ CPU",
        "RSS MB",
        "CHECK",
    ]);

    for (const scenario of scenarios) {
        const [wp, wz, cp, cz] = ["plain.wallMs", "zst.wallMs", "plain.cpuMs", "zst.cpuMs"].map((key) =>
            value(`${scenario.name}.${key}`)
        );
        const rss = `${value(`${scenario.name}.plain.rssMb`).toFixed(0)} / ${value(`${scenario.name}.zst.rssMb`).toFixed(0)}`;
        table.push([
            scenario.name,
            wp!.toFixed(0),
            wz!.toFixed(0),
            delta(wp!, wz!),
            cp!.toFixed(0),
            cz!.toFixed(0),
            delta(cp!, cz!),
            rss,
            mismatched.includes(scenario) ? "DIFFERS" : "same",
        ]);
    }

    out.println(table.toString());
}

printBudget();

await finishBench({
    name: BASELINE_NAME,
    title: "Real commands on plain vs .zst data (median wall and CPU ms, peak RSS MB)",
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter((key) => key.endsWith("Ms")),
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, 50])),
    notes: `fresh processes, arms interleaved and alternating; load before: ${loadBefore}; after: ${loadAfter}; check mismatches: ${mismatched.map((s) => s.name).join(", ") || "none"}`,
    context: {
        arms: arms.map((arm) => ({ home: arm.home, logFiles: arm.logFiles.length, logBytes: arm.bytes })),
        checks,
        loadBefore,
        loadAfter,
    },
});
