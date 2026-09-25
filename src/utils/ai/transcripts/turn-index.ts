/**
 * A byte-offset index of the turns in a large Claude session file, so a tail or a page reads only
 * the lines it returns instead of the whole transcript.
 *
 * Measured 2026-09-24 (plan: .claude/plans/2026-09-24-TranscriptTurnIndex.md): a full parse costs
 * about 2.3 ms per MB, 401 ms and 1.5 GB of memory for a 172 MB session. Below INDEX_MIN_BYTES a
 * full parse stays under about 35 ms, so small files never get an index.
 *
 * Why it is exact: in `claudeMessagesToTurns` a turn exists because of its own line alone; later
 * lines only fill in tool results. So the turns parsed from the line of turn N to the end of the
 * file are turns N.. of the full parse. A count mismatch still falls back to the full parse.
 */
import { createHash } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentProgressToSubagent } from "@genesiscz/utils/claude/session.utils";
import type { ConversationMessage, ProgressMessage } from "@genesiscz/utils/claude/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { claudeMessagesToTurns } from "./claude";
import type { ResolvedTranscript } from "./resolve";
import {
    DEFAULT_TURN_LIMIT,
    pickTurnIndices,
    type SliceOptions,
    sparseSliceOf,
    type TranscriptEnvelope,
    type TranscriptTotals,
    type TranscriptTurn,
    terminatedOf,
    totalsOf,
} from "./types";

export const INDEX_MIN_BYTES = 16 * 1024 * 1024;
const INDEX_VERSION = 3;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 4096;
const MAX_INDEX_FILES = 256;
const NEWLINE = 0x0a;

/** The session file as it was when the index last read it. */
interface FileStamp {
    size: number;
    mtimeMs: number;
    ino: number;
}

export interface TurnIndex {
    version: number;
    path: string;
    /** Size, mtime and inode at the last read: equal means unchanged, the same size with a new mtime is a rewrite. */
    stamp: FileStamp;
    headHash: string;
    /** Hash of the TAIL_BYTES before `indexedBytes`: an append keeps it, a rewrite in place changes it. */
    tailHash: string;
    /** Bytes covered: always the end of a complete line. */
    indexedBytes: number;
    /** Byte offset of the line that produced each turn, in turn order. */
    turnOffsets: number[];
    totals: TranscriptTotals;
    terminated: "end" | "error" | null;
}

export interface TurnIndexOptions {
    /** Files smaller than this keep the full parse. */
    minBytes?: number;
    /** Where index files live. */
    dir?: string;
}

export function turnIndexDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "cache", "transcript-index");
}

function indexFileFor(dir: string, path: string): string {
    return join(dir, `${createHash("sha1").update(path).digest("hex")}.json`);
}

export function readRange(path: string, start: number, end: number): Buffer {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
        let read = 0;
        while (read < length) {
            const n = readSync(fd, buffer, read, length - read, start + read);
            if (n === 0) {
                break;
            }
            read += n;
        }
        return read === length ? buffer : buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

function headHashOf(path: string, size: number): string {
    return createHash("sha1")
        .update(readRange(path, 0, Math.min(HEAD_BYTES, size)))
        .digest("hex");
}

function tailHashOf(path: string, indexedBytes: number): string {
    return createHash("sha1")
        .update(readRange(path, Math.max(0, indexedBytes - TAIL_BYTES), indexedBytes))
        .digest("hex");
}

/** The message on one JSONL line, exactly as `ClaudeSession.fromFile` reads it, or null. */
function messageOfLine(line: string): ConversationMessage | null {
    if (!line.trim()) {
        return null;
    }
    try {
        const parsed = SafeJSON.parse(line, { jsonl: true }) as ConversationMessage;
        if (parsed.type === "progress") {
            return agentProgressToSubagent(parsed as ProgressMessage) ?? parsed;
        }
        return parsed;
    } catch {
        return null;
    }
}

/** Every complete line of `buffer` with its absolute byte offset; a final unterminated line only if it parses. */
function* linesOf(buffer: Buffer, base: number): Generator<{ offset: number; line: string; end: number }> {
    let start = 0;
    while (start < buffer.length) {
        const newline = buffer.indexOf(NEWLINE, start);
        if (newline === -1) {
            const line = buffer.toString("utf8", start);
            // A writer mid-line leaves half a JSON object: index it only once it parses.
            if (messageOfLine(line)) {
                yield { offset: base + start, line, end: base + buffer.length };
            }
            return;
        }
        yield { offset: base + start, line: buffer.toString("utf8", start, newline), end: base + newline + 1 };
        start = newline + 1;
    }
}

/** Adds the turns of the bytes from `index.indexedBytes` to `size`. */
function extend(index: TurnIndex, path: string, size: number): void {
    if (size <= index.indexedBytes) {
        return;
    }
    const buffer = readRange(path, index.indexedBytes, size);
    const added: TranscriptTurn[] = [];
    for (const { offset, line, end } of linesOf(buffer, index.indexedBytes)) {
        const message = messageOfLine(line);
        if (message) {
            // One message alone decides whether it is a turn (see the file header).
            const turns = claudeMessagesToTurns([message]);
            for (const turn of turns) {
                index.turnOffsets.push(offset);
                added.push(turn);
            }
        }
        index.indexedBytes = end;
    }
    if (added.length > 0) {
        const more = totalsOf(added);
        const totals = index.totals;
        totals.modelCalls += more.modelCalls;
        for (const key of ["inputTokens", "cacheReadTokens", "outputTokens", "reasoningTokens", "costUsd"] as const) {
            if (more[key] !== undefined) {
                totals[key] = (totals[key] ?? 0) + more[key];
            }
        }
        index.terminated = terminatedOf(added);
    }
}

function readIndex(file: string): TurnIndex | null {
    try {
        const parsed = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true }) as TurnIndex;
        return parsed.version === INDEX_VERSION && Array.isArray(parsed.turnOffsets) ? parsed : null;
    } catch {
        return null;
    }
}

function writeIndex(dir: string, file: string, index: TurnIndex): void {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, SafeJSON.stringify(index, { strict: true }));
    renameSync(temp, file);
    prune(dir);
}

/** Keeps the newest MAX_INDEX_FILES index files. */
function prune(dir: string): void {
    let entries: { file: string; mtime: number }[];
    try {
        entries = readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => ({ file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }));
    } catch {
        return;
    }
    if (entries.length <= MAX_INDEX_FILES) {
        return;
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const { file } of entries.slice(MAX_INDEX_FILES)) {
        rmSync(file, { force: true });
    }
}

/** The current index of a session file, built or extended as needed; null below the size floor. */
export function turnIndexFor(path: string, options: TurnIndexOptions = {}): TurnIndex | null {
    const stat = statSync(path);
    const size = stat.size;
    if (size < (options.minBytes ?? INDEX_MIN_BYTES)) {
        return null;
    }
    const dir = options.dir ?? turnIndexDir();
    const file = indexFileFor(dir, path);
    const stamp: FileStamp = { size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    let index = readIndex(file);
    const was = index?.stamp;
    // The two 4 KiB hashes are checked on every call. The stamp only adds to them: a rewrite inside
    // the clock's resolution, or one that restores the mtime, keeps size, mtime and inode.
    const headHash = headHashOf(path, size);
    const sameBytes =
        index !== null &&
        index.path === path &&
        index.headHash === headHash &&
        index.tailHash === tailHashOf(path, index.indexedBytes);
    if (index && sameBytes && was?.size === size && was.mtimeMs === stamp.mtimeMs && was.ino === stamp.ino) {
        return index;
    }

    // A session file only grows. Another inode, a shorter file, the same size written again, a new
    // head, or new bytes where the indexed ones ended is a rewrite, not an append: start over. An
    // append is the one change that keeps the inode and both hashes while the size grows.
    const stale = !index || !was || !sameBytes || was.ino !== stamp.ino || size <= was.size;
    if (!index || stale) {
        index = {
            version: INDEX_VERSION,
            path,
            stamp,
            headHash,
            tailHash: "",
            indexedBytes: 0,
            turnOffsets: [],
            totals: { modelCalls: 0 },
            terminated: null,
        };
    }
    extend(index, path, size);
    index.stamp = stamp;
    index.tailHash = tailHashOf(path, index.indexedBytes);
    writeIndex(dir, file, index);
    return index;
}

/** The turns parsed from the complete lines in the byte range [start, end). */
function turnsInRange(path: string, start: number, end: number): TranscriptTurn[] {
    const messages: ConversationMessage[] = [];
    for (const { line } of linesOf(readRange(path, start, end), start)) {
        const message = messageOfLine(line);
        if (message) {
            messages.push(message);
        }
    }
    return claudeMessagesToTurns(messages);
}

/** How many following turns a turn with an unanswered tool may read ahead for its results. */
export const MAX_RESULT_REACH = 16;

/**
 * Turn `position` exactly as the full parse builds it, reading only its own lines. Its tool results
 * normally sit before the next turn's line; when one is still missing, the range grows turn by turn
 * until the results land or an assistant turn starts (which ends the wait in `claudeMessagesToTurns`).
 * Null when the lines disagree with the index.
 */
export function indexedTurnAt(path: string, index: TurnIndex, position: number): TranscriptTurn | null {
    const offsets = index.turnOffsets;
    const total = offsets.length;
    if (position < 0 || position >= total) {
        return null;
    }

    let end = position + 1;
    for (;;) {
        const turns = turnsInRange(path, offsets[position], end < total ? offsets[end] : index.indexedBytes);
        if (turns.length !== end - position) {
            logger.debug({ path, position, expected: end - position, got: turns.length }, "turn index mismatch");
            return null;
        }

        const first = turns[0];
        const waiting = first.tools.some((tool) => tool.result === null);
        const waitEnded = turns.length > 1 && turns[turns.length - 1].role === "assistant";
        if (!waiting || waitEnded || end >= total || end - position > MAX_RESULT_REACH) {
            return first;
        }

        end += 1;
    }
}

/** The current index when `resolved` is a plain Claude session file large enough to have one. */
export function turnIndexOfTranscript(resolved: ResolvedTranscript, options: TurnIndexOptions = {}): TurnIndex | null {
    if (resolved.provider !== "claude" || resolved.source !== "native" || (resolved.extraFiles?.length ?? 0) > 0) {
        return null;
    }

    try {
        return turnIndexFor(resolved.filePath, options);
    } catch (error) {
        logger.debug({ error, path: resolved.filePath }, "transcript turn index unavailable");
        return null;
    }
}

function sparseIndexedTurns(path: string, index: TurnIndex, requested: number[]): TranscriptTurn[] | null {
    const turns: TranscriptTurn[] = [];
    for (const position of pickTurnIndices(requested, index.turnOffsets.length)) {
        const turn = indexedTurnAt(path, index, position);
        if (!turn) {
            return null;
        }

        turns.push({ ...turn, index: position });
    }
    return turns;
}

/**
 * The envelope `transcriptEnvelope` would return, read through the turn index. Null when the file is
 * small, not a plain Claude session file, or the index disagrees with the lines it points at.
 */
export function indexedClaudeEnvelope(
    resolved: ResolvedTranscript,
    opts: SliceOptions = {},
    options: TurnIndexOptions = {}
): TranscriptEnvelope | null {
    const index = turnIndexOfTranscript(resolved, options);
    if (!index) {
        return null;
    }

    const total = index.turnOffsets.length;
    if (opts.turns) {
        const turns = sparseIndexedTurns(resolved.filePath, index, opts.turns);
        if (!turns) {
            return null;
        }

        return {
            provider: resolved.provider,
            sessionId: resolved.sessionId,
            filePath: resolved.filePath,
            byteSize: statSync(resolved.filePath).size,
            ...sparseSliceOf(
                turns.map((turn) => turn.index ?? 0),
                total
            ),
            turns,
            totals: { ...index.totals },
            terminated: index.terminated,
        };
    }

    const limit = opts.limit ?? DEFAULT_TURN_LIMIT;
    const offset = opts.offset ?? Math.max(0, total - limit);
    let turns: TranscriptTurn[] = [];
    if (offset < total) {
        const start = index.turnOffsets[offset];
        // The page plus the reach its tool results get (as in `indexedTurnAt`), not the rest of the
        // file: `--offset 0` on a large session would otherwise parse every line after the page.
        const stopAt = Math.min(total, offset + limit + MAX_RESULT_REACH);
        const stop = stopAt < total ? index.turnOffsets[stopAt] : index.indexedBytes;
        const messages: ConversationMessage[] = [];
        for (const { line } of linesOf(readRange(resolved.filePath, start, stop), start)) {
            const message = messageOfLine(line);
            if (message) {
                messages.push(message);
            }
        }
        const tail = claudeMessagesToTurns(messages);
        if (tail.length !== stopAt - offset) {
            logger.debug(
                { path: resolved.filePath, expected: stopAt - offset, got: tail.length },
                "turn index mismatch"
            );
            return null;
        }
        turns = tail.slice(0, limit);
    }
    // Same arithmetic as `sliceTurns`, so both paths agree even past the end.
    const nextOffset = offset + turns.length;
    return {
        provider: resolved.provider,
        sessionId: resolved.sessionId,
        filePath: resolved.filePath,
        byteSize: statSync(resolved.filePath).size,
        truncated: nextOffset < total || offset > 0,
        nextOffset,
        turns,
        totals: { ...index.totals },
        terminated: index.terminated,
    };
}
