import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { type AnalysisSession, analyzeEntry, DEFAULT_RUNS, DEFAULT_SLOW_MS, DEFAULT_TIMEOUT_MS } from "../lib/analyze";
import { findBarrelWaste } from "../lib/barrels";
import { findCycles } from "../lib/cycles";
import { findLazyCandidates } from "../lib/lazy";
import { fmtMs, renderAnalysis, renderBarrels, renderCycles, renderLazy } from "../lib/render";

interface SharedOptions {
    json?: boolean;
    runs?: string;
    timeout?: string;
    minMs?: string;
    walkPackages?: boolean;
    includeDynamic?: boolean;
}

interface AnalyzeCommandOptions extends SharedOptions {
    depth?: string;
    top?: string;
}

const ENTRY_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

function number(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * A file is one entry. A directory is its `index.ts`, or every top-level source file when there
 * is none. A `tsconfig*.json` stands for its directory. Test and declaration files never count.
 */
export function resolveEntries(input: string): string[] {
    const target = resolve(input);

    if (!existsSync(target)) {
        return [];
    }

    if (statSync(target).isFile()) {
        if (/^tsconfig.*\.json$/.test(basename(target))) {
            return resolveEntries(dirname(target));
        }

        return [target];
    }

    for (const index of ["index.ts", "index.tsx", "index.js", "index.mjs"]) {
        const candidate = join(target, index);

        if (existsSync(candidate)) {
            return [candidate];
        }
    }

    return readdirSync(target)
        .filter((name) => ENTRY_EXTENSIONS.has(extname(name)) && !TEST_FILE.test(name))
        .sort()
        .map((name) => join(target, name));
}

function rootFor(entry: string): string {
    return findProjectRoot(dirname(entry)) ?? dirname(entry);
}

async function sessionsFor(input: string, options: SharedOptions, toolName: string): Promise<AnalysisSession[]> {
    const entries = resolveEntries(input);

    if (entries.length === 0) {
        out.error(`No entry found at ${input}. Pass a .ts file, a directory with an index.ts, or a tsconfig.json.`);
        out.error(
            suggestCommand(toolName, { replaceCommand: [...toolName.split(" ").slice(2), "src/notify/index.ts"] })
        );
        process.exitCode = 1;
        return [];
    }

    const sessions: AnalysisSession[] = [];

    for (const entry of entries) {
        logger.info({ entry, runs: number(options.runs, DEFAULT_RUNS) }, "ts: analyzing entry");
        sessions.push(
            await analyzeEntry({
                entry,
                root: rootFor(entry),
                runs: Math.max(1, Math.floor(number(options.runs, DEFAULT_RUNS))),
                timeoutMs: number(options.timeout, DEFAULT_TIMEOUT_MS / 1000) * 1000,
                walkPackages: options.walkPackages === true,
                includeDynamic: options.includeDynamic === true,
                slowMs: DEFAULT_SLOW_MS,
            })
        );
    }

    return sessions;
}

function warnWorker(session: AnalysisSession): void {
    // First, and loudly: a killed worker leaves a partial results file, and a ranking built from
    // it looks exactly like a complete one. Silence here is how `tools ts imports` spent months
    // printing a confident table for two workers that had both been killed at 60 s.
    if (session.result.timedOut) {
        out.log.warn(
            `A measure worker was killed at --timeout. ${session.result.unmeasured} of ${session.result.planned} planned module(s) have no sample, and every number below is from a PARTIAL run. Raise --timeout, or look for a "hang" row: a module that never settles is usually an entrypoint whose import awaits something (a prompt, a server, a lock).`
        );
    } else if (session.result.unmeasured > 0) {
        out.log.warn(
            `${session.result.unmeasured} of ${session.result.planned} planned module(s) have no sample; their subtree totals are lower bounds.`
        );
    }

    const hung = session.result.modules.filter((module) => module.importError?.startsWith("hang:"));

    if (hung.length > 0) {
        out.log.warn(
            `${hung.length} module(s) never settled during import and were given up on. First: ${hung[0].label}. Their self time is the deadline, not a measurement.`
        );
    }

    const errors = session.result.modules.filter(
        (module) => module.importError && !module.importError.startsWith("exit ")
    );

    if (errors.length > 0) {
        out.log.warn(
            `${errors.length} module(s) rejected during import; their time is what a caller pays before the throw. First: ${errors[0].label}: ${errors[0].importError}`
        );
    }

    if (session.result.workerStderr.trim().length > 0) {
        logger.debug({ stderr: session.result.workerStderr.slice(0, 4000) }, "ts: worker stderr");
    }
}

function renderMultiEntrySummary(sessions: AnalysisSession[]): void {
    out.println(pc.bold(`\n${sessions.length} entries`));

    for (const session of sessions) {
        const heaviest = session.result.modules.find(
            (module) => module.measured && module.label !== session.result.entry
        );
        out.println(
            `  ${session.result.entry.padEnd(48)} ${pc.dim("cold")} ${fmtMs(session.result.coldMs).padStart(9)}  ${pc.dim("modules")} ${String(session.result.modules.filter((m) => m.measured).length).padStart(4)}  ${pc.dim("heaviest")} ${heaviest ? `${heaviest.label} (${fmtMs(heaviest.selfMs)})` : "—"}`
        );
    }
}

function addSharedOptions(command: Command): Command {
    return command
        .option("--json", "Machine-readable result on stdout")
        .option("--runs <n>", `Fresh processes per measurement, minimum kept (default ${DEFAULT_RUNS})`)
        .option(
            "--timeout <seconds>",
            `Kill a worker after this long; partial results survive (default ${DEFAULT_TIMEOUT_MS / 1000})`
        )
        .option("--min-ms <ms>", "Hide rows below this many milliseconds")
        .option("--walk-packages", "Parse and walk into node_modules too, instead of one leaf per package")
        .option("--include-dynamic", "Walk and measure dynamic import() targets too (marked lazy)");
}

export function registerImportsCommands(parent: Command): void {
    const imports = parent
        .command("imports")
        .description("Import graph, per-module import cost, and why a slow one is slow");

    addSharedOptions(
        imports
            .command("analyze")
            .description(
                "Import tree with measured self and total time per module, plus an explanation of each slow one"
            )
            .argument("<entry>", "A .ts file, a directory (its index.ts), or a tsconfig.json")
            .option("--depth <n>", "Tree depth (default 4)")
            .option("--top <n>", "Rows in the heaviest-modules table (default 15)")
    ).action(async (input: string, options: AnalyzeCommandOptions) => {
        const sessions = await sessionsFor(input, options, "tools ts imports analyze");

        if (sessions.length === 0) {
            return;
        }

        if (options.json) {
            out.result(sessions.length === 1 ? sessions[0].result : sessions.map((session) => session.result));
            return;
        }

        for (const session of sessions) {
            warnWorker(session);
            renderAnalysis(session.result, {
                graph: session.graph,
                minMs: number(options.minMs, 0.5),
                depth: Math.max(1, Math.floor(number(options.depth, 4))),
                top: Math.max(1, Math.floor(number(options.top, 15))),
                slowMs: DEFAULT_SLOW_MS,
            });
        }

        if (sessions.length > 1) {
            renderMultiEntrySummary(sessions);
        }

        out.println("");
        out.println(
            pc.dim(
                `  Next: ${suggestCommand("tools ts imports lazy", { subcommand: ["imports", "analyze"], remove: ["--depth", "--top"] })}`
            )
        );
    });

    addSharedOptions(
        imports
            .command("lazy")
            .description(
                "Static imports that are safe to turn into `await import()`, ranked by the startup time they would save"
            )
            .argument("<entry>", "A .ts file, a directory (its index.ts), or a tsconfig.json")
    ).action(async (input: string, options: SharedOptions) => {
        const sessions = await sessionsFor(input, options, "tools ts imports lazy");
        const minMs = number(options.minMs, 0.5);

        if (options.json) {
            out.result(
                sessions.map((session) => ({
                    entry: session.result.entry,
                    candidates: findLazyCandidates(session.graph, session.self),
                }))
            );
            return;
        }

        for (const session of sessions) {
            warnWorker(session);
            renderLazy(findLazyCandidates(session.graph, session.self), session.result.entry, minMs);
        }
    });

    addSharedOptions(
        imports
            .command("barrels")
            .description("Barrel files whose re-exports cost the caller more than the names it uses")
            .argument("<entry>", "A .ts file, a directory (its index.ts), or a tsconfig.json")
    ).action(async (input: string, options: SharedOptions) => {
        const sessions = await sessionsFor(input, options, "tools ts imports barrels");
        const minMs = number(options.minMs, 0.5);

        if (options.json) {
            out.result(
                sessions.map((session) => ({
                    entry: session.result.entry,
                    waste: findBarrelWaste(session.graph, session.self),
                }))
            );
            return;
        }

        for (const session of sessions) {
            warnWorker(session);
            renderBarrels(findBarrelWaste(session.graph, session.self), session.result.entry, minMs);
        }
    });

    addSharedOptions(
        imports
            .command("cycles")
            .description("Import cycles on the startup path (the source of `undefined` exports at load time)")
            .argument("<entry>", "A .ts file, a directory (its index.ts), or a tsconfig.json")
    ).action(async (input: string, options: SharedOptions) => {
        const sessions = await sessionsFor(input, options, "tools ts imports cycles");

        if (options.json) {
            out.result(
                sessions.map((session) => ({
                    entry: session.result.entry,
                    cycles: findCycles(session.graph, session.self),
                }))
            );
            return;
        }

        for (const session of sessions) {
            renderCycles(findCycles(session.graph, session.self), session.result.entry);
        }
    });
}
