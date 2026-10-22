import { ripgrepFiles } from "@genesiscz/utils/compress/search";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { listDayLogs } from "@genesiscz/utils/logger/day-logs";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { daysIn, inWindow, type TimeWindow } from "./window";

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

export function levelName(level: number): string {
    const found = Object.entries(LEVELS).find(([, value]) => value === level);
    return found ? found[0] : String(level);
}

export interface DayLogQuery {
    window: TimeWindow;
    minLevel?: number;
    tool?: string;
    pid?: number;
    /** Case-insensitive substring of the whole record. */
    grep?: string;
    /** The newest N matching records. */
    limit?: number;
}

export interface DayLogEntry {
    time: string;
    level: number;
    pid: number | null;
    tool: string | null;
    msg: string;
    record: Record<string, unknown>;
}

export function parseDayLogLine(line: string): DayLogEntry | null {
    if (!line.startsWith("{")) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        logger.debug({ error }, "day log: a line did not parse");
        return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.time !== "string" || typeof record.level !== "number") {
        return null;
    }

    return {
        time: record.time,
        level: record.level,
        pid: typeof record.pid === "number" ? record.pid : null,
        tool: typeof record.tool === "string" ? record.tool : null,
        msg: typeof record.msg === "string" ? record.msg : "",
        record,
    };
}

export function matchesDayLog(entry: DayLogEntry, query: DayLogQuery, line: string): boolean {
    if (!inWindow(entry.time, query.window)) {
        return false;
    }

    if (query.minLevel !== undefined && entry.level < query.minLevel) {
        return false;
    }

    if (query.tool && entry.tool !== query.tool) {
        return false;
    }

    if (query.pid !== undefined && entry.pid !== query.pid) {
        return false;
    }

    return !query.grep || line.toLowerCase().includes(query.grep.toLowerCase());
}

/**
 * The cheapest fixed string every wanted line must hold, so rg reads the day log (often 200 MB or more) instead
 * of a JSON parse per line. Null when no filter narrows it.
 */
export function prefilterFor(query: DayLogQuery): { pattern: string; fixed: boolean } | null {
    if (query.pid !== undefined) {
        return { pattern: `"pid":${query.pid},`, fixed: true };
    }

    if (query.tool) {
        return { pattern: `"tool":${SafeJSON.stringify(query.tool)}`, fixed: true };
    }

    if (query.minLevel !== undefined && query.minLevel >= LEVELS.warn) {
        const levels = Object.values(LEVELS).filter((level) => level >= (query.minLevel ?? 0));
        return { pattern: `"level":(${levels.join("|")})[,}]`, fixed: false };
    }

    if (query.grep) {
        return { pattern: query.grep, fixed: true };
    }

    return null;
}

/**
 * Keeps the newest `limit` entries (all of them without a limit) while lines stream past, holding at most twice
 * `limit`: a week of day logs can be gigabytes, and `logs day --limit 100` needs 100 records of it.
 */
export function newestEntries(limit: number | undefined): {
    add(entry: DayLogEntry): void;
    held(): number;
    result(): DayLogEntry[];
} {
    let entries: DayLogEntry[] = [];
    const trim = () => {
        entries.sort((a, b) => a.time.localeCompare(b.time));
        if (limit) {
            entries = entries.slice(-limit);
        }
    };

    return {
        add(entry) {
            entries.push(entry);
            if (limit && entries.length >= limit * 2) {
                trim();
            }
        },
        held: () => entries.length,
        result() {
            trim();
            return entries;
        },
    };
}

/** Hands every line that may match to `onLine` as it is read: rg's prefiltered output, else every line. */
async function eachCandidateLine(files: string[], query: DayLogQuery, onLine: (line: string) => void): Promise<void> {
    const prefilter = prefilterFor(query);
    const rg = ripgrepBinary();

    if (!prefilter || !rg) {
        if (prefilter) {
            logger.debug("day log: rg is not on PATH, reading every line");
        }

        for (const file of files) {
            for (const line of readLinesSync(file)) {
                onLine(line);
            }
        }

        return;
    }

    const args = ["--no-config", "--no-filename", "--no-line-number", ...(prefilter.fixed ? ["-F", "-i"] : [])];
    const run = await ripgrepFiles({
        rg,
        args: [...args, "-e", prefilter.pattern],
        files,
        timeoutMs: 120_000,
        onLine,
    });
    if (run.signal || run.code > 1) {
        throw new Error(`rg over the day logs failed (${run.signal ?? `exit ${run.code}`}): ${run.stderr.trim()}`);
    }
}

/** The newest `limit` matching records, oldest first. */
export async function queryDayLog(query: DayLogQuery): Promise<DayLogEntry[]> {
    const days = new Set(daysIn(query.window));
    const files = listDayLogs()
        .filter((file) => days.has(file.day))
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((file) => file.path);
    logger.debug({ files, prefilter: prefilterFor(query) }, "day log: query");

    const found = newestEntries(query.limit);
    await eachCandidateLine(files, query, (line) => {
        const entry = parseDayLogLine(line);
        if (entry && matchesDayLog(entry, query, line)) {
            found.add(entry);
        }
    });

    return found.result();
}
