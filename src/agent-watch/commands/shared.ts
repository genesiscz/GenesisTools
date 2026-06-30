import type { WatchSourceName } from "../types";

const VALID_SOURCES: ReadonlySet<WatchSourceName> = new Set<WatchSourceName>(["task", "claude", "workflows"]);

export function parseSources(raw: string): WatchSourceName[] {
    const sources: WatchSourceName[] = [];

    for (const part of raw.split(",")) {
        const s = part.trim();

        if (VALID_SOURCES.has(s as WatchSourceName)) {
            sources.push(s as WatchSourceName);
        }
    }

    return sources.length > 0 ? sources : ["task", "claude", "workflows"];
}

export function parseSharedOptions(opts: { stallTimeout: string; sources: string }): {
    stallTimeoutMs: number;
    sources: WatchSourceName[];
} {
    const seconds = Number.parseInt(opts.stallTimeout, 10);
    const stallTimeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
    return { stallTimeoutMs, sources: parseSources(opts.sources) };
}
