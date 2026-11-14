import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeSessionId } from "@genesiscz/utils/agents/session-id";
import { readLinesBackwardSync, readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import type { RmBashWrite } from "@genesiscz/utils/rm";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The read side of the per-session change log the agents hook writes (`tools agents` owns the writer and its Bash
 * analysis in `src/agents/lib/changes/log.ts`). Every reader (blame, the hub, the object-store pass, `tools rm`,
 * the session-changes computation) builds the path, parses a row and walks the folders here, so they cannot drift.
 */

const log = logger.child({ component: "agents/change-log" });

/** The one file name of a session's change log, inside its session folder. */
const CHANGE_LOG_FILE = "changes.jsonl";

type StoreSkip = "binary" | "large";

/** One row of a session's change log: one file one tool call changed. The writer and every reader share it. */
export interface ChangeLogRow {
    ts: string;
    provider: string;
    session: string;
    /** The turn id from the payload; without one, the tool call's id stands in for it. */
    turn: string;
    tool: string;
    /** The tool call that made the change (Claude `tool_use.id`, Codex and Grok call ids). Rows before 2026-09-24 carry none. */
    toolUseId?: string;
    cwd: string;
    path: string;
    beforeOid: string | null;
    afterOid: string | null;
    source: "edit" | "write" | "bash";
    /**
     * A Bash row: when its command began (ISO), so a reader can tell a file the command made (born after this) from
     * one it only changed. Rows before 2026-11-02 carry none.
     */
    began?: string;
    /** Set when either side was not stored (the after side's reason wins). Rows before 2026-09-25 carry only this. */
    skipped?: StoreSkip;
    /** Why the before-state has no `beforeOid`. */
    beforeSkipped?: StoreSkip;
    /** Why the after-state has no `afterOid`. */
    afterSkipped?: StoreSkip;
}

/** The folder that holds one folder per session, each with its change log (and the object store's `_objects`). */
export function changeLogsDir(): string {
    return genesisToolsDir("agents");
}

/**
 * One session's change log. The id comes from a hook payload or a CLI argument, so it must be one plain path
 * segment: `../../x` would otherwise write and read outside the agents directory. Throws on anything else.
 */
export function changeLogPath(sessionId: string): string {
    const safe = safeSessionId(sessionId);

    if (safe === null) {
        throw new Error(`not a session id: "${sessionId}"`);
    }

    return changeLogPathIn(changeLogsDir(), safe);
}

/** The change log of the session folder `folder` (a name `changeLogFolders` listed) under `dir`. */
export function changeLogPathIn(dir: string, folder: string): string {
    return join(dir, folder, CHANGE_LOG_FILE);
}

/**
 * Every folder name under `dir`, each a session that may have a change log. No name is filtered: a session id that
 * starts with "_" is a session too (#674 followup, commit a8f29a43ac), and a folder without a log (the store's
 * `_objects`) is simply one whose log is absent. A missing `dir` lists nothing; any other read error throws.
 */
export function changeLogFolders(dir = changeLogsDir()): string[] {
    try {
        return readdirSync(dir);
    } catch (error) {
        if (isAbsent(error)) {
            return [];
        }

        throw error;
    }
}

const SOURCES: readonly string[] = ["edit", "write", "bash"] satisfies ChangeLogRow["source"][];

function field(row: object, key: string): unknown {
    return Reflect.get(row, key);
}

function text(row: object, key: string): string | undefined {
    const value = field(row, key);
    return typeof value === "string" ? value : undefined;
}

function oid(row: object, key: string): string | null | undefined {
    const value = field(row, key);

    if (value === undefined || value === null) {
        return null;
    }

    return typeof value === "string" ? value : undefined;
}

function skip(row: object, key: string): StoreSkip | undefined {
    const value = field(row, key);
    return value === "binary" || value === "large" ? value : undefined;
}

/**
 * A parsed JSON value as a change-log row, or null when it is not one. `ts`, `session`, `path` and a known `source`
 * are required. The hook writes every other field; a row without the identity fields (provider, turn, tool, cwd)
 * reads them as "", and a side without an oid as null, as the hook writes a side it did not store.
 */
export function parseChangeLogRow(value: unknown): ChangeLogRow | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const ts = text(value, "ts");
    const session = text(value, "session");
    const path = text(value, "path");
    const source = text(value, "source");
    const beforeOid = oid(value, "beforeOid");
    const afterOid = oid(value, "afterOid");

    if (
        ts === undefined ||
        session === undefined ||
        path === undefined ||
        source === undefined ||
        !SOURCES.includes(source) ||
        beforeOid === undefined ||
        afterOid === undefined
    ) {
        return null;
    }

    const row: ChangeLogRow = {
        ts,
        provider: text(value, "provider") ?? "",
        session,
        turn: text(value, "turn") ?? "",
        tool: text(value, "tool") ?? "",
        cwd: text(value, "cwd") ?? "",
        path,
        beforeOid,
        afterOid,
        source: source === "edit" ? "edit" : source === "write" ? "write" : "bash",
    };
    const toolUseId = text(value, "toolUseId");
    const began = text(value, "began");

    if (toolUseId !== undefined) {
        row.toolUseId = toolUseId;
    }

    if (began !== undefined) {
        row.began = began;
    }

    for (const key of ["skipped", "beforeSkipped", "afterSkipped"] as const) {
        const reason = skip(value, key);

        if (reason !== undefined) {
            row[key] = reason;
        }
    }

    return row;
}

/** One line of a change log as a row; null for a blank, torn or foreign line. */
function parseLine(line: string): ChangeLogRow | null {
    if (line.trim().length === 0) {
        return null;
    }

    try {
        return parseChangeLogRow(SafeJSON.parse(line, { strict: true }));
    } catch {
        return null;
    }
}

/**
 * Every row of the change log at `path`, with the count of lines that are not rows (torn, corrupt, foreign) so a
 * caller can say so. A missing log has no rows and carries `missing: true`; any other read error throws.
 */
export function readChangeLogFile(path: string): { rows: ChangeLogRow[]; skipped: number; missing?: true } {
    const read = readJsonlRows<unknown>(path);
    const rows: ChangeLogRow[] = [];
    let skipped = read.skipped;

    for (const value of read.rows) {
        const row = parseChangeLogRow(value);

        if (row) {
            rows.push(row);
        } else {
            skipped++;
        }
    }

    return { rows, skipped, ...(read.missing ? { missing: true as const } : {}) };
}

/** Every row of one session's change log; none when it has no log. Throws on an id that is not one path segment. */
export function readChangeLog(sessionId: string): ChangeLogRow[] {
    const path = changeLogPath(sessionId);
    const read = readChangeLogFile(path);

    if (read.skipped > 0) {
        log.debug({ path, skipped: read.skipped }, "change log: skipped lines that are not rows");
    }

    return read.rows;
}

export interface WalkChangeLogsOptions {
    /** Only logs written at or after this time (epoch ms, the log's mtime). Rows are not filtered by their `ts`. */
    since?: number;
    /** At most this many logs, the most recently written first. */
    maxSessions?: number;
    /** Stop after this many rows in total. A log is read in chunks, and no chunk past the last row it needs. */
    maxRows?: number;
    /**
     * A cheap gate on the raw line before it is parsed; a line it refuses is not a row. Most lines of most logs are
     * about other files, and parsing every row of 400 logs is what a reader that wants a few paths cannot afford.
     */
    keepLine?: (line: string) => boolean;
    /**
     * Only rows written at or after this time (epoch ms, the row's `ts`). A log is appended in time order, so it is read
     * from its end and the read stops at the first row well before it: an old log's history is never read or parsed.
     * The rows of each log still come oldest first.
     */
    rowsSince?: number;
    /** The folder of session folders; `changeLogsDir()` by default. */
    dir?: string;
}

/**
 * How far before `rowsSince` the backward read still goes. A log is appended in time order only roughly: a row stamped
 * with its own event time can land after a newer one, so the read stops at the first row older than the window by
 * more than this, and skips the ones in between.
 */
const ROW_ORDER_SLACK_MS = 10 * 60_000;

/**
 * The rows of one log written at or after `since`, oldest first, read from the end and stopped at the first row older
 * than the window by more than `ROW_ORDER_SLACK_MS`. At most `max`, the newest kept.
 */
function recentRows({
    path,
    since,
    keepLine,
    max,
}: {
    path: string;
    since: number;
    keepLine?: (line: string) => boolean;
    max: number;
}): ChangeLogRow[] {
    const newestFirst: ChangeLogRow[] = [];

    for (const line of readLinesBackwardSync(path, { chunkBytes: WALK_CHUNK_BYTES })) {
        const row = parseLine(line);

        if (!row) {
            if (line.trim().length > 0) {
                log.debug({ path }, "change log: a line that is not a row");
            }

            continue;
        }

        const at = Date.parse(row.ts);

        if (at < since - ROW_ORDER_SLACK_MS) {
            break;
        }

        if (at < since) {
            continue;
        }

        if (keepLine && !keepLine(line)) {
            continue;
        }

        newestFirst.push(row);

        if (newestFirst.length >= max) {
            break;
        }
    }

    return newestFirst.reverse();
}

/** How much of a change log `walkChangeLogs` reads at a time; the next chunk is read only while rows are still due. */
export const WALK_CHUNK_BYTES = 64 * 1024;

/**
 * Capped walk over every session folder. A folder with no change log is skipped; a "_" prefix is not a filter.
 * Logs come most recently written first; an unreadable folder or log is logged and walks nothing. A log is read in
 * chunks of `WALK_CHUNK_BYTES` and never held whole, so `maxRows` bounds the bytes read as well as the rows.
 */
export function* walkChangeLogs(
    options: WalkChangeLogsOptions = {}
): Iterable<{ sessionId: string; rows: ChangeLogRow[] }> {
    const dir = options.dir ?? changeLogsDir();
    let folders: string[];

    try {
        folders = changeLogFolders(dir);
    } catch (error) {
        log.debug({ error, dir }, "change log: cannot list the session folders");
        return;
    }

    const logs: { sessionId: string; path: string; mtime: number }[] = [];

    for (const folder of folders) {
        const path = changeLogPathIn(dir, folder);

        try {
            const mtime = statSync(path).mtimeMs;

            if (options.since === undefined || mtime >= options.since) {
                logs.push({ sessionId: folder, path, mtime });
            }
        } catch (error) {
            // A session folder without a change log (decisions only, the object store) is the common case.
            log.trace({ error, path }, "change log: none in this folder");
        }
    }

    logs.sort((a, b) => b.mtime - a.mtime);
    const chosen = options.maxSessions === undefined ? logs : logs.slice(0, options.maxSessions);
    let left = options.maxRows ?? Number.POSITIVE_INFINITY;

    for (const { sessionId, path } of chosen) {
        if (left <= 0) {
            return;
        }

        const rows: ChangeLogRow[] = [];

        try {
            if (options.rowsSince !== undefined) {
                rows.push(...recentRows({ path, since: options.rowsSince, keepLine: options.keepLine, max: left }));
                left -= rows.length;
                yield { sessionId, rows };
                continue;
            }

            // Leaving the loop early closes the file: no chunk after the one that held the last row due is read.
            for (const line of readLinesSync(path, { chunkBytes: WALK_CHUNK_BYTES })) {
                if (options.keepLine && !options.keepLine(line)) {
                    continue;
                }

                const row = parseLine(line);

                if (row) {
                    rows.push(row);

                    if (rows.length >= left) {
                        break;
                    }
                } else if (line.trim().length > 0) {
                    log.debug({ path }, "change log: a line that is not a row");
                }
            }
        } catch (error) {
            log.debug({ error, path }, "change log: unreadable");
            continue;
        }

        left -= rows.length;
        yield { sessionId, rows };
    }
}

/** The tail of a change log the Bash-write lookup reads; older rows are not read, and the cap is logged. */
export const BASH_LOOKUP_MAX_BYTES = 8 * 1024 * 1024;

/** The Bash-write indexes loaded in this process, kept for this many sessions (least recently used goes first). */
const BASH_INDEX_SESSIONS = 8;

interface BashWriteIndex {
    size: number;
    mtimeMs: number;
    maxBytes: number;
    byPath: Map<string, ChangeLogRow[]>;
}

/** One index per session, reused while its log keeps the same size and mtime: a sweep of many requests reads once. */
const bashWriteIndexes = new Map<string, BashWriteIndex>();

/**
 * Every Bash row of `sessionId`'s change log that wrote `path`, in log order (`tools rm`'s own-files rule asks). The
 * log's last `maxBytes` are read once into an index by path, which later calls for the same session share while the
 * log keeps its size and mtime. A missing log, a torn line or an unsafe id give no row.
 */
export function bashWritesOf(sessionId: string, path: string, options: { maxBytes?: number } = {}): ChangeLogRow[] {
    return bashWritesByPath(sessionId, options).get(path) ?? [];
}

/**
 * The index `bashWritesOf` reads, whole: every Bash row of the session's log tail, by path. A caller that asks for
 * many paths and wants one snapshot of the log (a `tools rm` sweep) holds this map; it is not updated afterwards.
 */
export function bashWritesByPath(
    sessionId: string,
    { maxBytes = BASH_LOOKUP_MAX_BYTES }: { maxBytes?: number } = {}
): ReadonlyMap<string, ChangeLogRow[]> {
    return bashWriteIndex(sessionId, maxBytes) ?? new Map();
}

/**
 * Every Bash command of `sessionId` that recorded writing each path (`tools rm`'s own-files rule asks), in log order:
 * when it began (rows before 2026-11-02 carry no start) and when its row was written. The rows come from
 * `bashWritesByPath`, read once on the first lookup and kept by this lookup while later ones see a grown log.
 */
export function bashWriteLookup(
    sessionId: string,
    options: { maxBytes?: number } = {}
): (path: string) => RmBashWrite[] {
    let index: ReadonlyMap<string, ChangeLogRow[]> | undefined;

    return (path) => {
        if (index === undefined) {
            index = bashWritesByPath(sessionId, options);
        }

        return (index.get(path) ?? []).map((row) => ({ ...(row.began ? { began: row.began } : {}), ended: row.ts }));
    };
}

function bashWriteIndex(sessionId: string, maxBytes: number): Map<string, ChangeLogRow[]> | null {
    let file: string;
    let size: number;
    let mtimeMs: number;

    try {
        file = changeLogPath(sessionId);
        ({ size, mtimeMs } = statSync(file));
    } catch (error) {
        log.debug({ session: sessionId, error }, "change log: none to read Bash writes from");
        return null;
    }

    const cached = bashWriteIndexes.get(sessionId);
    bashWriteIndexes.delete(sessionId);

    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.maxBytes === maxBytes) {
        bashWriteIndexes.set(sessionId, cached);
        return cached.byPath;
    }

    let body: string;

    try {
        body = readTail(file, size, maxBytes);
    } catch (error) {
        log.debug({ session: sessionId, error }, "change log: cannot read it for Bash writes");
        return null;
    }

    if (size > maxBytes) {
        log.debug(
            { session: sessionId, size, maxBytes },
            "change log over the cap: Bash writes before its last bytes are not read"
        );
    }

    const byPath = new Map<string, ChangeLogRow[]>();

    for (const line of body.split("\n")) {
        if (!line.includes('"source":"bash"')) {
            continue;
        }

        const row = parseLine(line);

        if (row?.source !== "bash") {
            continue;
        }

        // One array per path, appended in log order: a copy per row made N writes of one path cost O(N²).
        const rows = byPath.get(row.path);

        if (rows) {
            rows.push(row);
        } else {
            byPath.set(row.path, [row]);
        }
    }

    bashWriteIndexes.set(sessionId, { size, mtimeMs, maxBytes, byPath });

    while (bashWriteIndexes.size > BASH_INDEX_SESSIONS) {
        const oldest = bashWriteIndexes.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        bashWriteIndexes.delete(oldest);
    }

    return byPath;
}

/** The last `maxBytes` of a file of `size` bytes, from the first whole line on. */
function readTail(file: string, size: number, maxBytes: number): string {
    if (size <= maxBytes) {
        return readFileSync(file, "utf8");
    }

    const fd = openSync(file, "r");

    try {
        const buffer = Buffer.alloc(maxBytes);
        const read = readSync(fd, buffer, 0, maxBytes, size - maxBytes);
        const body = buffer.subarray(0, read).toString("utf8");
        return body.slice(body.indexOf("\n") + 1);
    } finally {
        closeSync(fd);
    }
}

function isAbsent(error: unknown): boolean {
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
