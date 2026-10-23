import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { listDayLogs } from "@genesiscz/utils/logger/day-logs";

export interface ProfileEntry {
    day: string;
    scope: string;
    /** The label with its details, `hub widget watch exit=0 cpu=… caller=app`. */
    label: string;
    ms: number;
    traceId: string | null;
    pid: number;
}

const LINE = /^\[profile:([\w.-]+)\] (.*) (\d+(?:\.\d+)?)(ms|s)(?: trace=(\S+))? pid=(\d+)$/;

/** `[profile:<scope>] <label> <duration>(ms|s) [trace=<id>] pid=<n>`; a summary table or a wrapped label is null. */
export function parseProfileLine(line: string, day: string): ProfileEntry | null {
    const match = LINE.exec(line);
    if (!match) {
        return null;
    }

    const value = Number(match[3]);
    return {
        day,
        scope: match[1],
        label: match[2],
        ms: match[4] === "s" ? value * 1000 : value,
        traceId: match[5] ?? null,
        pid: Number(match[6]),
    };
}

export interface ProfileQuery {
    days: string[];
    minMs?: number;
    scopes?: string[];
    /** Case-insensitive substring of the label. */
    grep?: string;
    pid?: number;
    /** `@name` lines are marks (a point in time since the process started), not durations. */
    marks?: boolean;
    /** Keep only the slowest N while reading, slowest first; without it every match comes back in log order. */
    top?: number;
    dir?: string;
}

export function queryProfileLog(query: ProfileQuery): ProfileEntry[] {
    const wanted = new Set(query.days);
    const found: ProfileEntry[] = [];
    const needle = query.grep?.toLowerCase();
    const top = query.top !== undefined && Number.isFinite(query.top) && query.top > 0 ? query.top : null;

    for (const file of listDayLogs({ profiling: true, dir: query.dir })) {
        if (!wanted.has(file.day)) {
            continue;
        }

        for (const line of readLinesSync(file.path)) {
            const entry = parseProfileLine(line, file.day);
            if (
                !entry ||
                (query.minMs !== undefined && entry.ms < query.minMs) ||
                (query.scopes?.length && !query.scopes.includes(entry.scope)) ||
                (needle && !entry.label.toLowerCase().includes(needle)) ||
                (query.pid !== undefined && entry.pid !== query.pid) ||
                (!query.marks && entry.label.startsWith("@"))
            ) {
                continue;
            }

            if (top === null) {
                found.push(entry);
                continue;
            }

            // A bounded buffer, slowest first: an entry slots in after every one at least as slow, and the fastest
            // falls off past N, so the result equals a stable sort of everything cut to N.
            const at = found.findIndex((kept) => kept.ms < entry.ms);
            found.splice(at === -1 ? found.length : at, 0, entry);
            if (found.length > top) {
                found.pop();
            }
        }
    }

    return found;
}
