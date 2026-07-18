import type { WatchSourceName } from "../types";

const VALID_SOURCES: ReadonlySet<WatchSourceName> = new Set<WatchSourceName>(["task", "claude", "workflows"]);

export function parseSources(raw: string): WatchSourceName[] {
    const sources: WatchSourceName[] = [];
    const unknown: string[] = [];

    for (const part of raw.split(",")) {
        const s = part.trim();

        if (!s) {
            continue;
        }

        if (VALID_SOURCES.has(s as WatchSourceName)) {
            sources.push(s as WatchSourceName);
        } else {
            unknown.push(s);
        }
    }

    if (unknown.length > 0) {
        throw new Error(`Unknown source(s): ${unknown.join(", ")}. Valid: ${[...VALID_SOURCES].join(", ")}`);
    }

    return sources.length > 0 ? sources : ["task", "claude", "workflows"];
}

/** Strict non-negative integer parse — rejects "120abc" instead of truncating it. */
export function parseNonNegativeInt(raw: string, flag: string): number {
    const trimmed = raw.trim();

    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid ${flag} value "${raw}" — expected a non-negative integer`);
    }

    return Number.parseInt(trimmed, 10);
}

export function parseSharedOptions(opts: { stallTimeout: string; sources: string; active?: string }): {
    stallTimeoutMs: number;
    sources: WatchSourceName[];
    activeWindowMs: number;
} {
    const seconds = parseNonNegativeInt(opts.stallTimeout, "--stall-timeout");
    const stallTimeoutMs = (seconds > 0 ? seconds : 120) * 1000;
    const activeMinutes = parseNonNegativeInt(opts.active ?? "0", "--active");
    const activeWindowMs = activeMinutes * 60_000;
    return { stallTimeoutMs, sources: parseSources(opts.sources), activeWindowMs };
}
