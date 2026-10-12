import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { Command } from "commander";
import { UsageError } from "../lib/format";
import { focusTree, summarizeProfiles } from "../lib/profile/cpuprofile";
import { type ProfileReport, renderProfileReport } from "../lib/profile/render";
import { runProfiled } from "../lib/profile/run";
import { parseThreadSample } from "../lib/profile/threads";
import { numberArg, runUsage } from "./options";

interface ProfileCommandOptions {
    runs: number;
    interval: number;
    top: number;
    depth: number;
    minPct: number;
    focus?: string;
    threads?: boolean;
    bun?: string;
    json?: boolean;
}

const TOOLS_ROOT = join(import.meta.dir, "..", "..", "..");

/** A `.ts` file as given, or a tool name: `ai` is `src/ai/index.ts` of this checkout. */
function resolveEntry(entry: string): string {
    const asFile = resolve(entry);

    if (existsSync(asFile)) {
        return asFile;
    }

    const asTool = join(TOOLS_ROOT, "src", entry, "index.ts");

    if (existsSync(asTool)) {
        return asTool;
    }

    throw new UsageError(`"${entry}" is neither a file nor a tool under ${join(TOOLS_ROOT, "src")}`);
}

/** The checkout that holds the entry: frames under it count as repository code. */
function repoRootOf(path: string): string {
    for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
    }

    return dirname(path);
}

export function registerProfileCommands(parent: Command): void {
    parent
        .command("profile")
        .description(
            "CPU-profile an entry point with no timers added: pprof-style hot functions, the repository's own functions and their call tree, and optionally every thread"
        )
        .argument(
            "<entry>",
            "Any .ts/.js file of any project (run in the current folder), or a GenesisTools tool name (`ai` is src/ai/index.ts)"
        )
        .argument("[args...]", "Arguments for the entry; put them after `--` so their flags reach it")
        .option("--runs <n>", "Runs to add together (default 1)", numberArg({ min: 1, integer: true }), 1)
        .option(
            "--interval <us>",
            "Sampling interval in microseconds (default 250)",
            numberArg({ min: 50, integer: true }),
            250
        )
        .option("--top <n>", "Rows per table (default 20)", numberArg({ min: 1, integer: true }), 20)
        .option("--depth <n>", "Call tree depth (default 8)", numberArg({ min: 1, integer: true }), 8)
        .option("--min-pct <n>", "Hide call tree nodes under this share (default 1)", numberArg({ min: 0 }), 1)
        .option("--focus <name>", "Show the call tree below functions whose name contains this")
        .option("--threads", "Also sample every thread of the first run with /usr/bin/sample (macOS)")
        .option("--bun <path>", "Bun binary to profile with (default: the one running this tool)")
        .option("--json", "The report as JSON")
        .addHelpText(
            "after",
            `\nExamples:\n  ${suggestCommand("tools ts profile", { add: ["ai", "--runs", "3", "--threads", "--", "usage", "sessions", "--json", "--fresh"] })}\n  ${suggestCommand("tools ts profile", { add: ["src/ts/index.ts", "--focus", "collect", "--", "skeleton", "src/utils"] })}`
        )
        .action(async (entry: string, args: string[], options: ProfileCommandOptions, command: Command) => {
            await runUsage(command, async () => {
                const entryPath = resolveEntry(entry);
                const bun = options.bun ?? process.execPath;
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const outDir = toolDataDir("ts", "profiles", stamp);
                const runs = await runProfiled({
                    bun,
                    entry: entryPath,
                    args,
                    cwd: process.cwd(),
                    runs: options.runs,
                    intervalUs: options.interval,
                    outDir,
                    threads: Boolean(options.threads),
                });
                const profiles = runs.flatMap((run) => (run.profile ? [run.profile] : []));

                if (profiles.length === 0) {
                    const tail = runs.at(-1)?.stderrTail.trim();
                    throw new UsageError(
                        `no run wrote a profile (exit ${runs.map((run) => run.exitCode).join(", ")})${tail ? `: ${tail}` : ""}`
                    );
                }

                const summary = summarizeProfiles(profiles, repoRootOf(entryPath));
                const threadPath = runs[0]?.threadSamplePath;
                const report: ProfileReport = {
                    command: [bun, "run", entryPath, ...args],
                    outDir,
                    runs: runs.map(({ exitCode, cpuMs, wallMs, profilePath }) => ({
                        exitCode,
                        cpuMs,
                        wallMs,
                        profilePath,
                    })),
                    summary,
                    ...(threadPath && existsSync(threadPath)
                        ? { threads: { ...parseThreadSample(await Bun.file(threadPath).text()), path: threadPath } }
                        : {}),
                };
                const tree = options.focus ? focusTree(summary.repoTree, options.focus) : summary.repoTree;

                if (options.json) {
                    out.result({
                        ...report,
                        summary: {
                            ...summary,
                            functions: summary.functions.slice(0, options.top),
                            repoFunctions: summary.repoFunctions.slice(0, options.top),
                            repoTree: tree,
                        },
                    });
                    return;
                }

                renderProfileReport(report, { top: options.top, depth: options.depth, minPct: options.minPct, tree });
            });
        });
}
