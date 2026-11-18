#!/usr/bin/env bun
/**
 * Profile the pre-push hook stage by stage: wall time, CPU time (user and system, child processes included), CPU use
 * as a share of one core, the peak memory of the stage's whole process tree and its largest process, the load
 * average when the stage started, and the wait between stages. The hook calls it three ways:
 *
 *   bun scripts/ci/pre-push-profile.ts start                       prints a run folder (the hook keeps it)
 *   bun scripts/ci/pre-push-profile.ts run <dir> <stage> -- <cmd>  runs one stage, exits with its code
 *   bun scripts/ci/pre-push-profile.ts report <dir> [exit code]    prints the table, appends the run to the history
 *
 * History: ~/.genesis-tools/logs/pre-push/<YYYY-MM-DD>.jsonl, one JSON line per push. GT_PRE_PUSH_PROFILE=0 in the
 * hook turns the wrapper off.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { dayLogsDir } from "@genesiscz/utils/logger/day-logs";
import { descendantPids, readProcessesWithUsage } from "@genesiscz/utils/process/processes";

/** How often the memory of a stage's process tree is sampled. */
const SAMPLE_MS = 500;

interface StageRecord {
    stage: string;
    startMs: number;
    endMs: number;
    exitCode: number;
    userMs: number;
    systemMs: number;
    /** The largest sum of RSS over the stage's process tree at one sample; null when no sample found the stage alive. */
    peakTreeMB: number | null;
    /** The largest single process of any sample, and its command; null as above. */
    peakProcessMB: number | null;
    peakProcess: string;
    load1AtStart: number;
    freeMBAtStart: number;
}

/** The RSS sum of `root` and every descendant, and the largest one, from the shared process reader. */
function treeMemory(root: number): { found: boolean; totalBytes: number; topBytes: number; topName: string } {
    let totalBytes = 0;
    let topBytes = 0;
    let topName = "";
    for (const row of readProcessesWithUsage([root, ...descendantPids(root)])) {
        const bytes = row.usage?.rssBytes ?? 0;
        totalBytes += bytes;
        if (bytes > topBytes) {
            topBytes = bytes;
            topName = row.name;
        }
    }

    // A row with no resident memory is a process that already ended (or was not read): it measures nothing.
    return { found: totalBytes > 0, totalBytes, topBytes, topName };
}

async function runStage(dir: string, stage: string, argv: string[]): Promise<number> {
    const startMs = Date.now();
    const load1AtStart = loadavg()[0];
    const freeMBAtStart = Math.round(freemem() / 1_048_576);
    const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
    // The hook's watchdog kills this wrapper; pass the signal on so the stage really stops.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(signal, () => child.kill(signal));
    }
    let peakTreeBytes = 0;
    let peakProcessBytes = 0;
    let peakProcess = "";
    let sampled = false;
    const sample = () => {
        const tree = treeMemory(child.pid);
        if (!tree.found) {
            return;
        }
        sampled = true;
        peakTreeBytes = Math.max(peakTreeBytes, tree.totalBytes);
        if (tree.topBytes > peakProcessBytes) {
            peakProcessBytes = tree.topBytes;
            peakProcess = tree.topName;
        }
    };
    // One sample at once, so a stage shorter than the interval still gets a measured peak while its tree exists.
    sample();
    const timer = setInterval(sample, SAMPLE_MS);
    const exitCode = await child.exited;
    clearInterval(timer);
    const usage = child.resourceUsage();
    const record: StageRecord = {
        stage,
        startMs,
        endMs: Date.now(),
        exitCode,
        userMs: usage ? Number(usage.cpuTime.user) / 1000 : 0,
        systemMs: usage ? Number(usage.cpuTime.system) / 1000 : 0,
        peakTreeMB: sampled ? Math.round(peakTreeBytes / 1_048_576) : null,
        peakProcessMB: sampled ? Math.round(peakProcessBytes / 1_048_576) : null,
        peakProcess,
        load1AtStart: Math.round(load1AtStart * 100) / 100,
        freeMBAtStart,
    };
    // The profile is optional: a record that cannot be written never changes the stage's own result.
    try {
        appendFileSync(join(dir, "stages.jsonl"), `${SafeJSON.stringify(record)}\n`);
    } catch (error) {
        console.error(
            `pre-push-profile: could not record stage ${stage}: ${error instanceof Error ? error.message : error}`
        );
    }
    return exitCode;
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function git(args: string[]): string {
    return Bun.spawnSync(["git", ...args], { stderr: "ignore" })
        .stdout.toString()
        .trim();
}

function report(dir: string, hookExit: number): void {
    const startedMs = Number(readFileSync(join(dir, "started"), "utf8"));
    const path = join(dir, "stages.jsonl");
    const stages: StageRecord[] = existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => SafeJSON.parse(line) as StageRecord)
        : [];
    stages.sort((a, b) => a.startMs - b.startMs);
    const endMs = Date.now();
    const cores = cpus().length;

    const header = ["stage", "wall", "cpu", "cpu%", "tree MB", "top process", "wait", "load", "exit"];
    const rows: string[][] = [];
    let lastEnd = startedMs;
    for (const s of stages) {
        const wall = s.endMs - s.startMs;
        const cpu = s.userMs + s.systemMs;
        // A stage that started before the previous one ended runs in parallel with it: no wait.
        const wait = s.startMs >= lastEnd ? seconds(s.startMs - lastEnd) : "parallel";
        lastEnd = Math.max(lastEnd, s.endMs);
        rows.push([
            s.stage,
            seconds(wall),
            seconds(cpu),
            `${wall > 0 ? Math.round((cpu / wall) * 100) : 0}%`,
            s.peakTreeMB === null ? "not sampled" : `${s.peakTreeMB}`,
            s.peakProcess && s.peakProcessMB !== null ? `${s.peakProcess.split("/").pop()} ${s.peakProcessMB} MB` : "",
            wait,
            `${s.load1AtStart}`,
            `${s.exitCode}`,
        ]);
    }
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    const totalCpu = stages.reduce((sum, s) => sum + s.userMs + s.systemMs, 0);
    const lines = [
        `── pre-push profile (${cores} cores; cpu% is the share of one core) ──`,
        line(header),
        ...rows.map(line),
        `total ${seconds(endMs - startedMs)} wall, ${seconds(totalCpu)} cpu, ${seconds(endMs - lastEnd)} after the last stage`,
    ];
    console.log(lines.join("\n"));

    const historyDir = join(dayLogsDir(), "pre-push");
    mkdirSync(historyDir, { recursive: true });
    const day = new Date().toLocaleDateString("sv-SE");
    const entry = {
        at: new Date(startedMs).toISOString(),
        wallMs: endMs - startedMs,
        exitCode: hookExit,
        cwd: process.cwd(),
        branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
        head: git(["rev-parse", "--short=10", "HEAD"]),
        cores,
        stages,
    };
    appendFileSync(join(historyDir, `${day}.jsonl`), `${SafeJSON.stringify(entry)}\n`);
    console.log(`  (history: ${join(historyDir, `${day}.jsonl`)})`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "start") {
    const dir = mkdtempSync(join(tmpdir(), "gt-pre-push-profile."));
    writeFileSync(join(dir, "started"), `${Date.now()}`);
    console.log(dir);
} else if (command === "run") {
    const [dir, stage, separator, ...argv] = rest;
    if (!dir || !stage || separator !== "--" || argv.length === 0) {
        console.error("usage: pre-push-profile.ts run <dir> <stage> -- <command...>");
        process.exit(2);
    }
    process.exit(await runStage(dir, stage, argv));
} else if (command === "report") {
    const [dir, exit] = rest;
    if (!dir) {
        console.error("usage: pre-push-profile.ts report <dir> [exit code]");
        process.exit(2);
    }
    report(dir, Number(exit ?? 0));
} else {
    console.error("usage: pre-push-profile.ts start | run <dir> <stage> -- <command...> | report <dir> [exit code]");
    process.exit(2);
}
