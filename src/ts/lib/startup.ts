import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { logger } from "@genesiscz/utils/logger";
import { analyzeEntry } from "./analyze";
import type { AnalysisResult, AnalyzedModule } from "./types";

const INDEX_FILES = ["index.ts", "index.tsx"];

/** The folder a measurement runs in: the entry's project root, where its tsconfig and node_modules live. */
export function projectRootFor(entry: string): string {
    return findProjectRoot(dirname(entry)) ?? dirname(entry);
}

/** A file is itself; a folder is its `index.ts` or `index.tsx`. Undefined when neither exists. */
export function startupEntryFor(input: string): string | undefined {
    const target = resolve(input);

    if (!existsSync(target)) {
        return undefined;
    }

    if (statSync(target).isFile()) {
        return target;
    }

    return INDEX_FILES.map((name) => join(target, name)).find((candidate) => existsSync(candidate));
}

/** `--tools <dir>`: the `index.ts` or `index.tsx` of every folder directly inside `dir`, sorted by folder name. */
export function toolEntriesIn(dir: string): string[] {
    const root = resolve(dir);
    const entries: string[] = [];

    for (const child of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory() || child.name.startsWith(".") || child.name === "node_modules") {
            continue;
        }

        const entry = startupEntryFor(join(root, child.name));

        if (entry) {
            entries.push(entry);
        }
    }

    return entries;
}

export interface StartupMeasureOptions {
    runs: number;
    timeoutMs: number;
    walkPackages?: boolean;
    includeDynamic?: boolean;
    /** Entries measured at once. 1 (the default) is the accurate choice: parallel runs slow each other down. */
    concurrency?: number;
    /** Called after each entry, for progress. */
    onEntry?: (entry: string, outcome: { result?: AnalysisResult; error?: string }) => void;
}

export interface StartupOutcome {
    /** Absolute entry path. */
    entry: string;
    result?: AnalysisResult;
    error?: string;
}

/** The `imports analyze` measurement, once per entry, in input order. */
export async function measureStartup(entries: string[], options: StartupMeasureOptions): Promise<StartupOutcome[]> {
    const errors = new Map<string, string>();
    const results = await concurrentMap({
        items: entries,
        concurrency: Math.max(1, Math.floor(options.concurrency ?? 1)),
        fn: async (entry) => {
            logger.debug({ entry, runs: options.runs }, "ts: measuring startup entry");
            const session = await analyzeEntry({
                entry,
                root: projectRootFor(entry),
                runs: options.runs,
                timeoutMs: options.timeoutMs,
                walkPackages: options.walkPackages,
                includeDynamic: options.includeDynamic,
            });
            options.onEntry?.(entry, { result: session.result });
            return session.result;
        },
        onError: (entry, error) => {
            const message = error instanceof Error ? error.message : String(error);
            errors.set(entry, message);
            logger.warn({ entry, error }, "ts: startup entry could not be measured");
            options.onEntry?.(entry, { error: message });
        },
    });

    return entries.map((entry) => ({ entry, result: results.get(entry), error: errors.get(entry) }));
}

export interface StartupModuleCost {
    /** `pkg:<name>` for a package (all its entry files together), the root-relative path for a file. */
    module: string;
    selfMs: number;
}

export interface StartupEntry {
    /** Relative to the cwd. */
    entry: string;
    coldMs: number;
    /** Modules the measurement imported. */
    modules: number;
    /** The heaviest modules by self time, `--top` of them. */
    top: StartupModuleCost[];
    timedOut: boolean;
    unmeasured: number;
    error?: string;
}

export interface RecurringModule {
    module: string;
    /** Entries in which this module's self time is at least `--min-ms`. */
    entries: number;
    /** Self time summed over those entries. */
    totalMs: number;
    maxMs: number;
    paidBy: string[];
}

export interface StartupReport {
    runs: number;
    minMs: number;
    entries: StartupEntry[];
    /** Modules or packages at or above `minMs` in two or more entries, heaviest summed cost first. */
    recurring: RecurringModule[];
}

/** `pkg:@scope/name/sub/path.js` and `pkg:name` both belong to their package. */
export function moduleKey(module: Pick<AnalyzedModule, "kind" | "label">): string {
    if (module.kind !== "package" || !module.label.startsWith("pkg:")) {
        return module.label;
    }

    const parts = module.label.slice("pkg:".length).split("/");
    const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    return `pkg:${name}`;
}

function round(ms: number): number {
    return Math.round(ms * 10) / 10;
}

/** Self time per module key in one measured entry. A package's entry files add up. */
export function selfTimesOf(result: AnalysisResult): Map<string, number> {
    const times = new Map<string, number>();

    for (const module of result.modules) {
        if (!module.measured) {
            continue;
        }

        const key = moduleKey(module);
        times.set(key, (times.get(key) ?? 0) + module.selfMs);
    }

    return times;
}

export function summarizeStartup(
    outcomes: Array<{ entry: string; result?: AnalysisResult; error?: string }>,
    options: { minMs: number; top: number; runs: number }
): StartupReport {
    const entries: StartupEntry[] = [];
    const recurring = new Map<string, RecurringModule>();

    for (const outcome of outcomes) {
        if (!outcome.result) {
            entries.push({
                entry: outcome.entry,
                coldMs: 0,
                modules: 0,
                top: [],
                timedOut: false,
                unmeasured: 0,
                error: outcome.error ?? "no result",
            });
            continue;
        }

        const times = selfTimesOf(outcome.result);
        const ranked = [...times.entries()].sort((a, b) => b[1] - a[1]);

        entries.push({
            entry: outcome.entry,
            coldMs: round(outcome.result.coldMs),
            modules: outcome.result.modules.filter((module) => module.measured).length,
            top: ranked.slice(0, options.top).map(([module, selfMs]) => ({ module, selfMs: round(selfMs) })),
            timedOut: outcome.result.timedOut,
            unmeasured: outcome.result.unmeasured,
        });

        for (const [module, selfMs] of ranked) {
            if (selfMs < options.minMs) {
                break;
            }

            const row = recurring.get(module) ?? { module, entries: 0, totalMs: 0, maxMs: 0, paidBy: [] };
            row.entries++;
            row.totalMs += selfMs;
            row.maxMs = Math.max(row.maxMs, selfMs);
            row.paidBy.push(outcome.entry);
            recurring.set(module, row);
        }
    }

    entries.sort((a, b) => b.coldMs - a.coldMs || a.entry.localeCompare(b.entry));

    return {
        runs: options.runs,
        minMs: options.minMs,
        entries,
        recurring: [...recurring.values()]
            .filter((row) => row.entries >= 2)
            .map((row) => ({ ...row, totalMs: round(row.totalMs), maxMs: round(row.maxMs) }))
            .sort((a, b) => b.totalMs - a.totalMs || a.module.localeCompare(b.module)),
    };
}
