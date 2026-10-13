import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The day logs: `<YYYY-MM-DD>.log` (pino JSON, one line per record) and `<YYYY-MM-DD>-profiling.log`, named by the
 * local date. Once a day is over the daily pass (`@genesiscz/utils/compress/daily`) stores it as `<name>.zst`
 * (seekable zstd). Every reader finds a day through {@link dayLogPath} or {@link listDayLogs} and reads it with
 * `readLinesSync` / `readTextChunks` from `@genesiscz/utils/fs/read-lines`, which read both forms.
 */
export const DAY_LOG_FILE = /^(\d{4}-\d{2}-\d{2})(-profiling)?\.log(\.zst)?$/;

export function dayLogsDir(): string {
    return genesisToolsDir("logs");
}

export interface DayLogFile {
    day: string;
    path: string;
    profiling: boolean;
    compressed: boolean;
}

/** The file holding a day's log: `<day>.log` while it is plain, else `<day>.log.zst`, else undefined. */
export function dayLogPath(
    day: string,
    { profiling = false, dir = dayLogsDir() }: { profiling?: boolean; dir?: string } = {}
): string | undefined {
    const plain = join(dir, `${day}${profiling ? "-profiling" : ""}.log`);

    if (existsSync(plain)) {
        return plain;
    }

    const compressed = `${plain}.zst`;
    return existsSync(compressed) ? compressed : undefined;
}

/** Every day log of one kind, newest day first, one file per day (the plain file wins while both exist). */
export function listDayLogs({
    profiling = false,
    dir = dayLogsDir(),
}: {
    profiling?: boolean;
    dir?: string;
} = {}): DayLogFile[] {
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (err) {
        logger.debug({ err, dir }, "[logs] the day-log folder could not be listed");
        return [];
    }

    const byDay = new Map<string, DayLogFile>();

    for (const name of names) {
        const match = DAY_LOG_FILE.exec(name);

        if (!match || Boolean(match[2]) !== profiling) {
            continue;
        }

        const day = match[1]!;
        const compressed = Boolean(match[3]);
        const known = byDay.get(day);

        if (!known || (known.compressed && !compressed)) {
            byDay.set(day, { day, path: join(dir, name), profiling, compressed });
        }
    }

    return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** The day of a plain day log or profiling log (`2026-10-12.log`, `2026-10-12-profiling.log`); undefined otherwise. */
export function dayOfPlainDayLog(name: string): string | undefined {
    const match = DAY_LOG_FILE.exec(name);
    return match && !match[3] ? match[1] : undefined;
}
