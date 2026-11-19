#!/usr/bin/env bun
/** Observe the current watch for 30 minutes. Timers overlap: CPU is process-wide during each named span. */
import { createReadStream, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { parseProfileLine } from "@app/genesis-tools/lib/profile-log";
import { widgetRoot } from "@app/hub/lib/widget/storage";
import { runTool } from "@genesiscz/utils/cli";
import { formatLocalDate } from "@genesiscz/utils/date";
import { splitLines } from "@genesiscz/utils/fs/read-lines";
import { out } from "@genesiscz/utils/logger";
import { parsePidRecord } from "@genesiscz/utils/process/pidfile";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { Command, Option } from "commander";

const steps = [
    ["claude-history", "listing.catalog"],
    ["widget", "roster session rows"],
    ["hub-agents", "parents"],
    ["hub-agents", "tree"],
    ["widget", "background index"],
] as const;

const program = new Command()
    .name("roster-watch")
    .addOption(
        new Option("--load <class>", "one-minute system load during sampling")
            .choices(["normal", "high"])
            .makeOptionMandatory()
    )
    .option("--state-root <path>", "state directory of the watch to observe")
    .option("--profile-log <path>", "watch profiling log, defaults to today's daily file")
    .addOption(new Option("--baseline", "save these metrics").conflicts("compare"))
    .option("--compare", "compare this load class with its saved baseline")
    .action(
        async (options: {
            load: "normal" | "high";
            stateRoot?: string;
            profileLog?: string;
            baseline?: boolean;
            compare?: boolean;
        }) => {
            const name = `widget-roster-watch-${options.load}`;
            const lock = join(widgetRoot(options.stateRoot), "worker.lock");
            const owner = readFileSync(lock, "utf8");
            const pid = parsePidRecord(owner)?.pid;
            if (!pid) {
                throw new Error("The widget lock must name the live watch to measure.");
            }
            const day = formatLocalDate(new Date());
            const logPath = options.profileLog ?? genesisToolsDir("logs", `${day}-profiling.log`);
            const file = Bun.file(logPath);
            if (!(await file.exists())) {
                throw new Error("Enable file profiling on the watch before measuring.");
            }
            const offset = file.size;
            const values = new Map<string, number[]>();
            function sample(key: string, value: number) {
                const samples = values.get(key) ?? [];
                samples.push(value);
                values.set(key, samples);
            }
            const started = performance.now();
            for (;;) {
                if (readFileSync(lock, "utf8") !== owner) {
                    throw new Error("The watch restarted during the sample.");
                }
                const load = loadavg()[0];
                if (load < 10 !== (options.load === "normal")) {
                    throw new Error(`The one-minute load crossed 10 during the sample: ${load}`);
                }
                sample("load", load);
                const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { timeout: 5000 });
                const rss = Number(ps.stdout.toString().trim());
                if (ps.exitCode !== 0 || !(rss > 0)) {
                    throw new Error("Cannot read the watch's RSS.");
                }
                sample("rssMiB", rss / 1024);
                const remaining = 30 * 60_000 - (performance.now() - started);
                if (remaining <= 0) {
                    break;
                }
                await Bun.sleep(Math.min(30_000, remaining));
            }
            if (!options.profileLog && formatLocalDate(new Date()) !== day) {
                throw new Error("Daily log rotated during sampling. Use a fixed --profile-log across midnight.");
            }
            const end = Bun.file(logPath).size;
            const log =
                end > offset ? createReadStream(logPath, { start: offset, end: end - 1 }) : new Blob([]).stream();
            for await (const line of splitLines(log)) {
                const entry = parseProfileLine(line, day);
                if (!entry || entry.pid !== pid) {
                    continue;
                }
                const step = steps.find(
                    ([scope, label]) => entry.scope === scope && entry.label.startsWith(`${label} `)
                );
                const cpu = /\bcpu=(\d+)ms\b/.exec(entry.label);
                if (step && cpu) {
                    sample(`${step[1]}WallMs`, entry.ms);
                    sample(`${step[1]}CpuMs`, Number(cpu[1]));
                }
            }
            for (const [, label] of steps) {
                if ((values.get(`${label}WallMs`)?.length ?? 0) < 5) {
                    throw new Error(
                        "Need at least five uncensored spans for " +
                            label +
                            ". Enable all required watch profiling scopes and zero minimum duration."
                    );
                }
            }
            const metrics: Record<string, number> = {};
            for (const [key, samples] of values) {
                samples.sort((a, b) => a - b);
                metrics[`${key}.min`] = samples[0];
                metrics[`${key}.median`] = samples[Math.floor(samples.length / 2)];
                metrics[`${key}.max`] = samples[samples.length - 1];
                out.println(`${key} n=${samples.length} median=${metrics[`${key}.median`].toFixed(2)}`);
            }
            out.result(metrics);
            if (options.baseline) {
                await recordBaseline({
                    name,
                    metrics,
                    notes: `30 min, watch pid ${pid}, inclusive process CPU, load ${options.load}`,
                });
            }
            if (options.compare) {
                const comparison = await compareToBaseline({
                    name,
                    metrics,
                    tolerancePct: 50,
                    lowerIsBetter: Object.keys(metrics).filter((key) => !key.startsWith("load.")),
                });
                out.println(formatComparison(comparison));
                if (!comparison.ok) {
                    process.exitCode = 1;
                }
            }
        }
    );
await runTool(program, { tool: "benchmark" });
