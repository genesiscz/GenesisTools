/**
 * Byte-level scans over a whole transcript, for the few facts a list row needs that no head or
 * tail slice holds: how many tool calls an agent made, which Agent calls it started, and the
 * `<task-notification>` statuses a parent received.
 *
 * The file is read in fixed chunks and searched with `Buffer.indexOf`, never split into lines or
 * parsed as JSON. Measured 2026-10-01 on one session's 41 sub-agent files (162 MB): 25 ms warm,
 * 46 ms cold, which is why a list may afford it where a JSON parse of the same bytes would not.
 *
 * The needles match raw JSON bytes. A needle quoted inside a string value is escaped there
 * (`\"type\":\"tool_use\"`), so text that merely mentions a tool call is not counted as one.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const CHUNK_BYTES = 4 * 1024 * 1024;

/** Where a scan starts reading, and before which offset a match must start to be reported. */
export interface ScanRange {
    from?: number;
    until?: number;
    /** One append-only scan keeps its descriptor open across prefix verification and both scan ranges. */
    fd?: number;
    prefix?: PrefixMark;
}

/**
 * Calls `onMatch` once per occurrence of `needle`, with the bytes from the match to at most
 * `window` bytes after it (less at the end of the file). Returns false when the file is unreadable.
 * `range` scans a part: reading starts at `from`, and only matches that start before `until` count
 * (their window may still run past it).
 */
export function scanFileMatches(
    path: string,
    needle: string,
    window: number,
    onMatch: (slice: Buffer) => void,
    range: ScanRange = {}
): boolean {
    const pattern = Buffer.from(needle);
    const span = Math.max(window, pattern.length);
    const until = range.until ?? Number.POSITIVE_INFINITY;
    let fd: number | null = null;

    try {
        fd = range.fd ?? openSync(path, "r");
        // Sized to what is left to read, not a fixed 4 MB: a resumed scan reads a few hundred bytes, and a
        // zeroed 4 MB buffer per file per call was the largest cost of a hub agents refresh (2026-10-08).
        // Unzeroed: only bytes a read filled (plus carried ones) are ever looked at.
        const left = Math.max(0, fstatSync(fd).size - (range.from ?? 0));
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, left) + span);
        const chunk = buffer.length - span;
        let carried = 0;
        let position = range.from ?? 0;
        // The file offset of `buffer[0]`.
        let base = position;

        for (;;) {
            const read = readSync(fd, buffer, carried, Math.max(0, Math.min(chunk, buffer.length - carried)), position);
            if (range.prefix) {
                const committed = Math.max(0, Math.min(read, until - position));
                range.prefix.update(buffer.subarray(carried, carried + committed));
            }

            position += read;
            const end = carried + read;
            const done = read === 0;
            // A match that starts inside the last `span` bytes may run past this chunk: it is
            // carried into the next read instead, so it is reported exactly once and whole.
            const limit = done ? end : Math.max(0, end - span);
            const view = buffer.subarray(0, end);
            let index = view.indexOf(pattern);

            while (index !== -1 && index < limit) {
                if (base + index >= until) {
                    return true;
                }

                onMatch(view.subarray(index, Math.min(end, index + span)));
                index = view.indexOf(pattern, index + pattern.length);
            }

            if (done || base + limit >= until) {
                return true;
            }

            buffer.copy(buffer, 0, limit, end);
            base += limit;
            carried = end - limit;
        }
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] file scan failed");
        return false;
    } finally {
        if (fd !== null && range.fd === undefined) {
            closeSync(fd);
        }
    }
}

interface ScanEntry<S> {
    ino: number;
    /** Every match that starts before this offset is in `state`, whole. */
    committed: number;
    /**
     * Digest of every byte before `committed`, to detect rewrites anywhere in the already scanned region.
     */
    mark: string;
    state: S;
}

const MARK_CACHE_LIMIT = 4000;
const marks = new Map<string, { generation: string; hash: Bun.CryptoHasher }>();

function prefixIdentity(fd: number): { key: string; generation: string } {
    const status = fstatSync(fd, { bigint: true });
    return {
        key: `${status.dev}:${status.ino}`,
        generation: `${status.size}:${status.mtimeNs}:${status.ctimeNs}`,
    };
}

export interface PrefixMark {
    digest(): string;
    update(bytes: Uint8Array): void;
    finish(): { digest: string; stable: boolean };
}

/**
 * Verify one consumed prefix, then extend the SHA with the exact new bytes the caller commits. A changed
 * generation reads the old prefix once; an unchanged nanosecond stat generation reuses its verified SHA state.
 * Metadata-equal mutations are outside that fast-cache contract. Every retained state is checked after the read.
 */
export function readPrefixMark(fd: number, offset: number): PrefixMark {
    const identity = prefixIdentity(fd);
    const oldKey = `${identity.key}:${offset}`;
    const cached = marks.get(oldKey);
    const hash = cached?.generation === identity.generation ? cached.hash.copy() : new Bun.CryptoHasher("sha256");
    if (cached?.generation !== identity.generation) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, offset));
        let position = 0;
        while (position < offset) {
            const read = readSync(fd, buffer, 0, Math.min(buffer.length, offset - position), position);
            if (read === 0) {
                throw new Error("Transcript shortened while checking its consumed prefix");
            }

            hash.update(buffer.subarray(0, read));
            position += read;
        }
    }

    let consumed = offset;
    const retain = (key: string): void => {
        marks.delete(key);
        marks.set(key, { generation: identity.generation, hash: hash.copy() });
        if (marks.size > MARK_CACHE_LIMIT) {
            const oldest = marks.keys().next().value;
            if (oldest !== undefined) {
                marks.delete(oldest);
            }
        }
    };
    if (prefixIdentity(fd).generation === identity.generation) {
        retain(oldKey);
    }

    return {
        digest: () => hash.copy().digest("hex"),
        update(bytes) {
            hash.update(bytes);
            consumed += bytes.byteLength;
        },
        finish() {
            const final = prefixIdentity(fd);
            const stable = final.key === identity.key && final.generation === identity.generation;
            const key = `${identity.key}:${consumed}`;
            if (stable) {
                retain(key);
            } else {
                marks.delete(oldKey);
                marks.delete(key);
            }

            return { digest: hash.copy().digest("hex"), stable };
        },
    };
}

/** A compatibility read for callers that only need the current prefix digest. */
export function markBefore(fd: number, offset: number): string {
    return readPrefixMark(fd, offset).finish().digest;
}

/** Most entries kept: one per sub-agent file and parent transcript a hub list reads. */
const SCAN_CACHE_LIMIT = 4000;
const scanCache = new Map<string, ScanEntry<unknown>>();

/**
 * `scanFileMatches` over an append-only file, resumed where the last scan of the same file and needle
 * stopped. A transcript only grows, so the matches before the old end stay what they were: only the new
 * bytes are read. Matches whose window may still grow (the last `span` bytes) are scanned each time into
 * a copy and never kept. A file that was replaced (another inode) or shrank starts over. Measured
 * 2026-10-08: the hub's agents list read every sub-agent transcript of every parent on every refresh
 * (158 refreshes, 1.29 s each); a resident process now reads only what was appended since.
 */
export function scanAppendOnly<S>(options: {
    path: string;
    needle: string;
    window: number;
    initial: () => S;
    copy: (state: S) => S;
    apply: (state: S, slice: Buffer) => void;
}): S | null {
    const { path, needle, window } = options;
    const key = `${needle}\u0000${path}`;
    const cached = scanCache.get(key) as ScanEntry<S> | undefined;
    let fd: number | null = null;
    try {
        fd = openSync(path, "r");
        const { size, ino } = fstatSync(fd);
        let prefix = readPrefixMark(fd, cached?.ino === ino && cached.committed <= size ? cached.committed : 0);
        const usable =
            cached !== undefined && cached.ino === ino && cached.committed <= size && prefix.digest() === cached.mark;
        const entry: ScanEntry<S> =
            usable && cached ? cached : { ino, committed: 0, mark: "", state: options.initial() };
        if (!usable) {
            prefix = readPrefixMark(fd, 0);
        }

        const span = Math.max(window, needle.length);
        const safeEnd = Math.max(entry.committed, size - span);
        if (safeEnd > entry.committed) {
            const next = options.copy(entry.state);
            const ok = scanFileMatches(path, needle, window, (slice) => options.apply(next, slice), {
                from: entry.committed,
                until: safeEnd,
                fd,
                prefix,
            });
            if (!ok) {
                scanCache.delete(key);
                return null;
            }

            entry.state = next;
            entry.committed = safeEnd;
        }

        const result = options.copy(entry.state);
        const ok = scanFileMatches(path, needle, window, (slice) => options.apply(result, slice), {
            from: safeEnd,
            fd,
        });
        if (!ok) {
            scanCache.delete(key);
            return null;
        }

        const checkpoint = prefix.finish();
        entry.mark = checkpoint.digest;
        scanCache.delete(key);
        if (checkpoint.stable) {
            scanCache.set(key, entry as ScanEntry<unknown>);
            if (scanCache.size > SCAN_CACHE_LIMIT) {
                const oldest = scanCache.keys().next().value;
                if (oldest !== undefined) {
                    scanCache.delete(oldest);
                }
            }
        }

        return result;
    } catch (error) {
        scanCache.delete(key);
        logger.debug({ error, path }, "[transcripts] file scan failed");
        return null;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

export interface ToolCallScan {
    toolCalls: number;
    /** The `tool_use` ids of the Agent (or legacy Task) calls, in file order: the agents it started. */
    agentCalls: string[];
}

const CLAUDE_TOOL_USE = '"type":"tool_use","id":"';
const CLAUDE_AGENT_CALL = /^"type":"tool_use","id":"([^"]+)","name":"(?:Agent|Task)"/;

/** Tool calls in a Claude transcript, and which of them started an agent. Null when unreadable. */
export function scanClaudeToolCalls(path: string): ToolCallScan | null {
    return scanAppendOnly<ToolCallScan>({
        path,
        needle: CLAUDE_TOOL_USE,
        window: 160,
        initial: () => ({ toolCalls: 0, agentCalls: [] }),
        copy: (scan) => ({ toolCalls: scan.toolCalls, agentCalls: [...scan.agentCalls] }),
        apply: (scan, slice) => {
            scan.toolCalls++;
            const agent = CLAUDE_AGENT_CALL.exec(slice.toString("latin1"));
            if (agent) {
                scan.agentCalls.push(agent[1]);
            }
        },
    });
}

const CODEX_ITEM_STARTED = '"method":"item/started","params":{"item":{"type":"';
/** Items a codex turn produces that are not tool calls. */
const CODEX_NON_TOOL_ITEMS = new Set(["userMessage", "agentMessage", "reasoning"]);

/** Tool calls in a `tools codex` worker's event log (`<name>.jsonl`). Null when unreadable. */
export function scanCodexWorkerToolCalls(path: string): number | null {
    return (
        scanAppendOnly<{ count: number }>({
            path,
            needle: CODEX_ITEM_STARTED,
            window: CODEX_ITEM_STARTED.length + 40,
            initial: () => ({ count: 0 }),
            copy: (state) => ({ count: state.count }),
            apply: (state, slice) => {
                const type = /^[A-Za-z]+/.exec(slice.subarray(CODEX_ITEM_STARTED.length).toString("latin1"))?.[0];
                if (type && !CODEX_NON_TOOL_ITEMS.has(type)) {
                    state.count++;
                }
            },
        })?.count ?? null
    );
}

/** Tool calls in a grok turn file (`<name>.turn<N>.jsonl`, ACP updates). Null when unreadable. */
export function scanGrokToolCalls(path: string): number | null {
    return (
        scanAppendOnly<{ count: number }>({
            path,
            needle: '"type":"tool_call","',
            window: 32,
            initial: () => ({ count: 0 }),
            copy: (state) => ({ count: state.count }),
            apply: (state) => {
                state.count++;
            },
        })?.count ?? null
    );
}

export interface TaskNotification {
    /** For an agent, its id (`a0564…`); for a background shell, the task id. */
    taskId: string;
    toolUseId: string | null;
    /** `completed`, `failed`, `killed`, … as Claude Code wrote it. */
    status: string;
}

// The JSON-escaped newline between the tags is a literal backslash and `n` in the file.
const NOTIFICATION = "<task-notification>\\n<task-id>";
const NOTIFICATION_WINDOW = 1500;

/**
 * The last `<task-notification>` status per task id in a parent transcript, in file order, so a
 * later notification for the same task wins. A notification with no `<status>` (a Monitor event)
 * is skipped.
 */
export function readTaskNotifications(path: string): Map<string, TaskNotification> {
    return (
        scanAppendOnly<Map<string, TaskNotification>>({
            path,
            needle: NOTIFICATION,
            window: NOTIFICATION_WINDOW,
            initial: () => new Map(),
            copy: (notifications) => new Map(notifications),
            apply: (notifications, slice) => {
                const text = slice.toString("utf8");
                const close = text.indexOf("</task-notification>");
                const body = close === -1 ? text : text.slice(0, close);
                const taskId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1];
                const status = /<status>([^<]+)<\/status>/.exec(body)?.[1];
                if (!taskId || !status) {
                    return;
                }

                const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1] ?? null;
                notifications.set(taskId, { taskId, toolUseId, status });
            },
        }) ?? new Map()
    );
}
