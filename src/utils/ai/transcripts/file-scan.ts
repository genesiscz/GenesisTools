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
/** Per file and offset: the verified prefix hash, for a file whose generation did not move. */
const marks = new Map<string, { generation: string } & SavedPrefix>();

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
 * The bytes of one block of the prefix hash. Small, because a cached hash keeps the bytes after its last whole
 * block (at most 16 MB at the 4,000-entry cap), and as cheap as large: 19 ms for 208 MB against 17 ms with 64 KB.
 */
const BLOCK_BYTES = 4 * 1024;

/** What a cache keeps of a prefix hash: the hash of its whole blocks and a copy of the bytes after them. */
interface SavedPrefix {
    chain: bigint;
    aligned: number;
    tail: Uint8Array;
}

/**
 * A streaming 64-bit xxHash3 of a file prefix, over 4 KB blocks at fixed file offsets: each whole block is hashed
 * with the hash of the blocks before it as its seed, and the digest hashes the partial last block the same way,
 * with the length. Any split of the same bytes into updates gives the same digest, which the prefix check needs: a
 * scan extends the hash with the slices it reads, a later check hashes the same bytes in 4 MB reads.
 *
 * It is a change check, not a cryptographic one: a transcript writer does not try to forge a collision. SHA-256 did
 * the same job at 85 ms for a 207 MB transcript against 18 ms for xxHash3 (11 ms of it the read), measured
 * 2026-11-05 on Bun 1.4.2; xxHash3 with a bigint seed gives the same values on Bun 1.3.13.
 */
class PrefixHash {
    private readonly tail = Buffer.allocUnsafe(BLOCK_BYTES);
    private tailLength = 0;
    private chain = 0n;
    private aligned = 0;

    constructor(saved?: SavedPrefix) {
        if (saved) {
            this.chain = saved.chain;
            this.aligned = saved.aligned;
            this.tail.set(saved.tail);
            this.tailLength = saved.tail.byteLength;
        }
    }

    saved(): SavedPrefix {
        return {
            chain: this.chain,
            aligned: this.aligned,
            tail: new Uint8Array(this.tail.subarray(0, this.tailLength)),
        };
    }

    update(bytes: Uint8Array): void {
        let offset = 0;
        if (this.tailLength > 0) {
            const take = Math.min(BLOCK_BYTES - this.tailLength, bytes.byteLength);
            this.tail.set(bytes.subarray(0, take), this.tailLength);
            this.tailLength += take;
            offset = take;
            if (this.tailLength < BLOCK_BYTES) {
                return;
            }

            this.chain = Bun.hash.xxHash3(this.tail, this.chain);
            this.aligned += BLOCK_BYTES;
            this.tailLength = 0;
        }

        while (bytes.byteLength - offset >= BLOCK_BYTES) {
            this.chain = Bun.hash.xxHash3(bytes.subarray(offset, offset + BLOCK_BYTES), this.chain);
            this.aligned += BLOCK_BYTES;
            offset += BLOCK_BYTES;
        }

        if (offset < bytes.byteLength) {
            this.tail.set(bytes.subarray(offset), 0);
            this.tailLength = bytes.byteLength - offset;
        }
    }

    digest(): string {
        const last = Bun.hash.xxHash3(this.tail.subarray(0, this.tailLength), this.chain);
        return `${this.aligned + this.tailLength}:${last.toString(16)}`;
    }
}

/** Feeds the bytes `[from, until)` of the file to the hash, in reads of at most 4 MB. */
function hashRange(fd: number, hash: PrefixHash, from: number, until: number): void {
    if (until <= from) {
        return;
    }

    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, until - from));
    let position = from;
    while (position < until) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, until - position), position);
        if (read === 0) {
            throw new Error("Transcript shortened while checking its consumed prefix");
        }

        hash.update(buffer.subarray(0, read));
        position += read;
    }
}

/**
 * Verify one consumed prefix, then extend the hash with the exact new bytes the caller commits. A changed
 * generation reads the old prefix once; an unchanged nanosecond stat generation reuses its verified hash and reads
 * nothing. Metadata-equal mutations are outside that fast-cache contract. Every retained state is checked after the
 * read.
 *
 * Cost on the live path: every append changes the generation, so each resumed read hashes the whole consumed
 * prefix again, O(file size). That is the price of detecting a rewrite anywhere before the kept end; a shorter
 * marker missed edits in the middle. Measured 2026-11-05 on a page-cached 207 MB Claude transcript: 18 ms per
 * verification with the xxHash3 blocks, 85 ms with the SHA-256 it replaced (152 ms for a 412 MB rollout on
 * 2026-10-09). What a resumed read saves is the JSON parse of that prefix, which costs several times more.
 */
export function readPrefixMark(fd: number, offset: number): PrefixMark {
    const identity = prefixIdentity(fd);
    const oldKey = `${identity.key}:${offset}`;
    const cached = marks.get(oldKey);
    const reused = cached?.generation === identity.generation ? cached : undefined;
    const hash = new PrefixHash(reused);
    hashRange(fd, hash, reused ? offset : 0, offset);

    let consumed = offset;
    const retain = (key: string): void => {
        marks.delete(key);
        marks.set(key, { generation: identity.generation, ...hash.saved() });
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
        digest: () => hash.digest(),
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

            return { digest: hash.digest(), stable };
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
