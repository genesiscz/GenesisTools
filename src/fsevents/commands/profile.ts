import { isVerbose } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import type { Command } from "commander";
import { formatChurnReport, formatWatchersReport } from "../lib/format";
import { resolveSampleRoot, sampleDirectoryChurn } from "../lib/sample";
import { sampleFseventsWatchers } from "../lib/watchers";

const DEFAULT_PATH = "/";
const DEFAULT_DURATION_SECONDS = 15;
const DEFAULT_WATCHERS_DURATION_SECONDS = 5;
const DEFAULT_TOP = 10;

interface ProfileOptions {
    duration?: string;
    top: string;
    watchers?: boolean;
    json?: boolean;
}

function positiveNumber(value: string, flag: string): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive number, got "${value}".`);
    }

    return parsed;
}

function positiveInteger(value: string, flag: string): number {
    const parsed = positiveNumber(value, flag);

    if (!Number.isInteger(parsed)) {
        throw new Error(`${flag} must be a whole number, got "${value}".`);
    }

    return parsed;
}

async function profileWatchers(options: ProfileOptions, seconds: number): Promise<void> {
    if (!env.device.isRoot()) {
        ui.err("Listing the processes that open /dev/fsevents needs fs_usage, which needs root.");
        ui.raw(`Run it again as root: sudo ${toolCommand("fsevents profile", "--watchers")}`);
        process.exitCode = 1;
        return;
    }

    ui.info(`Sampling fs_usage for ${seconds} s. Ctrl-C stops early and shows what was seen.`);
    const stopwatch = new Stopwatch();
    const watchers = await withInterrupt((signal) => sampleFseventsWatchers({ durationMs: seconds * 1000, signal }));

    if (options.json) {
        out.result({ elapsedMs: stopwatch.elapsedMs, watchers });
        return;
    }

    out.println(formatWatchersReport(watchers, { elapsedMs: stopwatch.elapsedMs }));
}

async function profileDirectories(path: string, options: ProfileOptions, seconds: number): Promise<void> {
    const top = positiveInteger(options.top, "--top");
    const root = resolveSampleRoot(path);
    ui.info(`Watching ${root} for ${seconds} s. Ctrl-C stops early and shows what was seen.`);

    const result = await withInterrupt((signal) =>
        sampleDirectoryChurn({
            root,
            durationMs: seconds * 1000,
            top,
            signal,
            onEvent: isVerbose() ? (event) => ui.dim(`${event.event} (${event.type}) ${event.path}`) : undefined,
        })
    );

    if (options.json) {
        out.result({
            root: result.root,
            elapsedMs: result.elapsedMs,
            interrupted: result.interrupted,
            total: result.total,
            distinctDirectories: result.distinctDirectories,
            directories: result.top,
        });
        return;
    }

    out.println(formatChurnReport(result, result));
}

export function registerProfileCommand(program: Command): void {
    program
        .command("profile")
        .description("Sample file system events for a few seconds and rank the directories with the most churn")
        .argument("[path]", "Directory to watch", DEFAULT_PATH)
        .option(
            "-d, --duration <seconds>",
            `How long to sample (default: ${DEFAULT_DURATION_SECONDS}, or ${DEFAULT_WATCHERS_DURATION_SECONDS} with --watchers)`
        )
        .option("-t, --top <number>", "How many directories to list", String(DEFAULT_TOP))
        .option("-w, --watchers", "List the processes that open the FSEvents device instead (needs root)")
        .option("--json", "Print the result as JSON")
        .action(async (path: string, options: ProfileOptions) => {
            if (process.platform !== "darwin") {
                ui.err("profile needs macOS: it reads FSEvents, which other systems do not have.");
                process.exitCode = 1;
                return;
            }

            const fallback = options.watchers ? DEFAULT_WATCHERS_DURATION_SECONDS : DEFAULT_DURATION_SECONDS;
            const seconds = options.duration === undefined ? fallback : positiveNumber(options.duration, "--duration");

            if (options.watchers) {
                await profileWatchers(options, seconds);
                return;
            }

            await profileDirectories(path, options, seconds);
        });
}
