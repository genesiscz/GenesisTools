import { readdirSync } from "node:fs";
import { join } from "node:path";
import { storedFilePath } from "@genesiscz/utils/fs/read-lines";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The day files in `~/.genesis-tools/logs`, one per kind and local date (`YYYY-MM-DD`):
 * - `log`: `<day>.log`, the pino JSON records of every tool (`logger.ts`);
 * - `profiling`: `<day>-profiling.log`, the profiler's lines (`profile/profile.ts`);
 * - `failures`: `<day>-failures.jsonl`, the failed tool runs (`cli/failures/record.ts`, and the app launcher's
 *   `LauncherFailures.swift`).
 *
 * Once a day is old enough the daily pass (`@genesiscz/utils/compress/daily`) stores the file as `<name>.zst` (seekable
 * zstd). Every reader finds a day through {@link dayLogPath} or {@link listDayLogs} and reads it with `readLinesSync` /
 * `readTextChunks` from `@genesiscz/utils/fs/read-lines` or `ripgrepFiles` from `@genesiscz/utils/compress/search`,
 * which read both forms. A new kind of day file is one more row here.
 */
export const DAY_LOG_KINDS = {
    log: { suffix: ".log" },
    profiling: { suffix: "-profiling.log" },
    failures: { suffix: "-failures.jsonl" },
} as const satisfies Record<string, { suffix: string }>;

export type DayLogKind = keyof typeof DAY_LOG_KINDS;

function isDayLogKind(value: string): value is DayLogKind {
    return Object.hasOwn(DAY_LOG_KINDS, value);
}

const KIND_OF_SUFFIX: ReadonlyMap<string, DayLogKind> = new Map(
    Object.entries(DAY_LOG_KINDS).flatMap(([kind, { suffix }]) => (isDayLogKind(kind) ? [[suffix, kind] as const] : []))
);

/** Any day file: the day, the kind's suffix, and `.zst` once it was compressed. */
export const DAY_LOG_FILE = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2})(${[...KIND_OF_SUFFIX.keys()].map((suffix) => suffix.replaceAll(".", "\\.")).join("|")})(\\.zst)?$`
);

export function dayLogsDir(): string {
    return genesisToolsDir("logs");
}

/**
 * Which kind a reader asks for. `profiling: true` is the older way to ask for `kind: "profiling"` and stays accepted;
 * `kind` wins when both are given.
 */
export interface DayLogKindOption {
    kind?: DayLogKind;
    /** @deprecated use `kind: "profiling"` */
    profiling?: boolean;
}

function kindOf({ kind, profiling }: DayLogKindOption): DayLogKind {
    return kind ?? (profiling ? "profiling" : "log");
}

export interface DayLogFile {
    day: string;
    path: string;
    kind: DayLogKind;
    /** `kind === "profiling"`, kept for older readers. */
    profiling: boolean;
    compressed: boolean;
}

/** The plain name of a day's file of one kind: `2026-10-12.log`, `2026-10-12-failures.jsonl`. For writers. */
export function dayLogName(day: string, kind: DayLogKind = "log"): string {
    return `${day}${DAY_LOG_KINDS[kind].suffix}`;
}

/** The file holding a day's file of one kind: the plain file while it exists, else its `.zst`, else undefined. */
export function dayLogPath(day: string, options: DayLogKindOption & { dir?: string } = {}): string | undefined {
    return storedFilePath(join(options.dir ?? dayLogsDir(), dayLogName(day, kindOf(options))));
}

/** The day, the kind and the form of a day file's name; undefined for any other name. */
export function parseDayLogName(name: string): { day: string; kind: DayLogKind; compressed: boolean } | undefined {
    const match = DAY_LOG_FILE.exec(name);
    const kind = match ? KIND_OF_SUFFIX.get(match[2]!) : undefined;

    if (!match || !kind) {
        return undefined;
    }

    return { day: match[1]!, kind, compressed: Boolean(match[3]) };
}

/** Every day file of one kind, newest day first, one file per day (the plain file wins while both exist). */
export function listDayLogs(options: DayLogKindOption & { dir?: string } = {}): DayLogFile[] {
    const kind = kindOf(options);
    const dir = options.dir ?? dayLogsDir();
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (err) {
        logger.debug({ err, dir }, "[logs] the day-log folder could not be listed");
        return [];
    }

    const byDay = new Map<string, DayLogFile>();

    for (const name of names) {
        const parsed = parseDayLogName(name);

        if (!parsed || parsed.kind !== kind) {
            continue;
        }

        const known = byDay.get(parsed.day);

        if (!known || (known.compressed && !parsed.compressed)) {
            byDay.set(parsed.day, {
                day: parsed.day,
                path: join(dir, name),
                kind,
                profiling: kind === "profiling",
                compressed: parsed.compressed,
            });
        }
    }

    return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** The day of a plain day file of any kind (`2026-10-12.log`, `2026-10-12-failures.jsonl`); undefined otherwise. */
export function dayOfPlainDayLog(name: string): string | undefined {
    const parsed = parseDayLogName(name);
    return parsed && !parsed.compressed ? parsed.day : undefined;
}
