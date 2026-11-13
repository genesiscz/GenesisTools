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
    /** The entry could not be measured, or a module in it rejected or never settled. Its cold time is no startup cost. */
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
    /** Failed entries first, then timed-out ones, then the slowest cold import first. */
    entries: StartupEntry[];
    /** Modules or packages at or above `minMs` in two or more entries, heaviest summed cost first. */
    recurring: RecurringModule[];
}

/** `pkg:@scope/name/sub/path.js` and `pkg:name` both belong to their package. Undefined for a non-package. */
function packageOf(module: Pick<AnalyzedModule, "kind" | "label">): string | undefined {
    if (module.kind !== "package" || !module.label.startsWith("pkg:")) {
        return undefined;
    }

    const parts = module.label.slice("pkg:".length).split("/");
    const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    return `pkg:${name}`;
}

/**
 * Which module a sample belongs to across entries. A package is its name, so its entry files add up
 * in every project. A source file is its absolute path: each entry labels files relative to its own
 * project root, so two projects' `src/config.ts` are two files, and one shared file is one.
 */
export function moduleKey(module: Pick<AnalyzedModule, "id" | "kind" | "label">): string {
    return packageOf(module) ?? module.id;
}

function round(ms: number): number {
    return Math.round(ms * 10) / 10;
}

/** A module whose import never settled: its time is the per-module deadline, not a measurement. */
function hung(module: AnalyzedModule): boolean {
    return module.importError?.startsWith("hang:") === true;
}

export interface ModuleSelfTime {
    /** What the report shows: `pkg:<name>`, or the path relative to the entry's project root. */
    label: string;
    ms: number;
}

/**
 * Self time per module key in one measured entry. A package's entry files add up. A hung module is
 * left out: its deadline is a lower bound, and it must not rank as the heaviest or a recurring cost.
 */
export function selfTimesOf(result: AnalysisResult): Map<string, ModuleSelfTime> {
    const times = new Map<string, ModuleSelfTime>();

    for (const module of result.modules) {
        if (!module.measured || hung(module)) {
            continue;
        }

        const key = moduleKey(module);
        const cost = times.get(key) ?? { label: packageOf(module) ?? module.label, ms: 0 };
        cost.ms += module.selfMs;
        times.set(key, cost);
    }

    return times;
}

/**
 * Why an entry's numbers are no startup cost: a module whose import rejected (a throw, a missing file)
 * or never settled. A fast cold time is then the time to the failure. An `exit N` is no failure: the
 * measurement runs an entry with `--help`, and a CLI exits on it by design.
 */
export function importFailureOf(result: AnalysisResult): string | undefined {
    const failed = result.modules.filter((module) => module.importError && !module.importError.startsWith("exit "));

    if (failed.length === 0) {
        return undefined;
    }

    const first = failed.find((module) => module.label === result.entry) ?? failed[0];
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
    return `import failed: ${first.label}: ${first.importError}${more}`;
}

/** Failed entries first, then timed-out ones: a broken measurement must not read as the fastest entry. */
function healthOf(entry: StartupEntry): number {
    if (entry.error) {
        return 0;
    }

    return entry.timedOut ? 1 : 2;
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
        const ranked = [...times.entries()].sort((a, b) => b[1].ms - a[1].ms);

        entries.push({
            entry: outcome.entry,
            coldMs: round(outcome.result.coldMs),
            modules: outcome.result.modules.filter((module) => module.measured).length,
            top: ranked.slice(0, options.top).map(([, cost]) => ({ module: cost.label, selfMs: round(cost.ms) })),
            timedOut: outcome.result.timedOut,
            unmeasured: outcome.result.unmeasured,
            error: importFailureOf(outcome.result),
        });

        for (const [key, cost] of ranked) {
            if (cost.ms < options.minMs) {
                break;
            }

            const row = recurring.get(key) ?? { module: cost.label, entries: 0, totalMs: 0, maxMs: 0, paidBy: [] };
            row.entries++;
            row.totalMs += cost.ms;
            row.maxMs = Math.max(row.maxMs, cost.ms);
            row.paidBy.push(outcome.entry);
            recurring.set(key, row);
        }
    }

    entries.sort((a, b) => healthOf(a) - healthOf(b) || b.coldMs - a.coldMs || a.entry.localeCompare(b.entry));

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
