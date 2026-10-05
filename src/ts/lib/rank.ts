import { realpathSync } from "node:fs";
import { resolveSpecifier } from "./graph";
import type { ParsedModule } from "./types";

const DAY_MS = 86_400_000;

export interface RankInputFile {
    size: number;
    /** How many other scanned files import this one. */
    fanIn: number;
    mtimeMs: number;
}

/** Normalize an array of raw values to 0..1 by max (0 when all zero). */
function normalizeByMax(values: number[]): number[] {
    const max = Math.max(0, ...values);

    if (max === 0) {
        return values.map(() => 0);
    }

    return values.map((value) => value / max);
}

/**
 * Rank files by importance, most important first. Pure: `now` is injected, the clock is never read.
 * Score = 0.5 fan-in + 0.2 size + 0.3 recency, each normalized to 0..1 (recency halves every 14
 * days). Ties are broken by key so the order is stable. Ported from the retired `tools repo-map`.
 */
export function rankFiles<T extends RankInputFile>({
    files,
    now,
    keyOf,
}: {
    files: T[];
    now: number;
    keyOf: (file: T) => string;
}): (T & { rank: number })[] {
    const sizes = normalizeByMax(files.map((file) => file.size));
    const fanIns = normalizeByMax(files.map((file) => file.fanIn));
    const recency = files.map((file) => 0.5 ** (Math.max(0, now - file.mtimeMs) / DAY_MS / 14));
    const ranked = files.map((file, index) => ({
        ...file,
        rank: 0.2 * sizes[index] + 0.5 * fanIns[index] + 0.3 * recency[index],
    }));

    return ranked.sort((a, b) => {
        if (b.rank !== a.rank) {
            return b.rank - a.rank;
        }

        return keyOf(a).localeCompare(keyOf(b));
    });
}

/**
 * Greedily keep files, in descending rank, while they fit the token budget. A high-rank file that
 * does not fit is skipped so smaller lower-rank files can still use the room. Pure: the token
 * counts are inputs.
 */
export function packByBudget<T extends { rank: number; tokens: number }>({
    files,
    budget,
}: {
    files: T[];
    budget: number;
}): { included: T[]; elided: T[]; usedTokens: number } {
    const included: T[] = [];
    const elided: T[] = [];
    let used = 0;

    for (const file of [...files].sort((a, b) => b.rank - a.rank)) {
        if (used + file.tokens <= budget) {
            included.push(file);
            used += file.tokens;
        } else {
            elided.push(file);
        }
    }

    return { included, elided, usedTokens: used };
}

function realOr(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * How many scanned files import each scanned file. Specifiers resolve the way Bun resolves them,
 * so tsconfig path aliases (`@app/...`) count, which a relative-path regex missed. An importer
 * counts once per file however many times it imports, and a file importing itself does not count.
 */
export function fanInOf({
    files,
    modules,
    resolve = resolveSpecifier,
}: {
    files: { file: string; absolute: string }[];
    modules: Map<string, ParsedModule>;
    resolve?: (specifier: string, fromFile: string) => string | undefined;
}): Map<string, number> {
    // Bun resolves to the real path, so a scan through a symlink (macOS tmp, a linked checkout)
    // would otherwise match nothing.
    const byReal = new Map(files.map((entry) => [realOr(entry.absolute), entry.absolute]));
    const fanIn = new Map<string, number>();

    for (const entry of files) {
        const targets = new Set<string>();

        for (const site of modules.get(entry.file)?.imports ?? []) {
            const resolved = resolve(site.specifier, entry.absolute);
            const target = resolved === undefined ? undefined : byReal.get(realOr(resolved));

            if (target && target !== entry.absolute) {
                targets.add(target);
            }
        }

        for (const target of targets) {
            fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
        }
    }

    return fanIn;
}
