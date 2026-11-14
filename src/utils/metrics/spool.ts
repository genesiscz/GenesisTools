import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { assertDimName, assertMetricsName, checkCheckpoint, checkEvent } from "./dims";
import type { MetricsStore } from "./store";
import type { MetricCheckpointInput, MetricDefinition, MetricEvent, StoredEvent } from "./types";

const { log } = logger.scoped("metrics-spool");

/**
 * The spool: `<metrics>/spool/<writer>-<YYYY-MM-DD>.jsonl`, one `MetricEvent` per line with `"v":1`. Appending a line
 * needs no service and no SQLite, so a standalone plugin file can record (the mods plugin writes the same lines in
 * `plugins/genesis-tools-mods/hooks/metrics.ts`). The service drains it into the store.
 */
export const SPOOL_VERSION = 1;

const WRITER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const SPOOL_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,39})-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const NEWLINE = 0x0a;

/** The most one drain step reads of a file; a longer file takes several steps, each its own transaction. */
const DRAIN_CHUNK_BYTES = 4 * 1024 * 1024;

/** A partial last line of an earlier day's file older than this is a writer that died mid-line: counted as bad. */
const STALE_TAIL_MS = 10 * 60_000;

export function metricsDir(): string {
    return toolDataDir("metrics");
}

export function metricsDbPath(): string {
    return join(metricsDir(), "metrics.db");
}

/** `<genesis-tools>/metrics/service`: service.json, the socket and the pid claim. */
export function metricsServiceDir(): string {
    return toolDataDir("metrics", "service");
}

export function spoolDir(): string {
    return toolDataDir("metrics", "spool");
}

export function spoolFileName(writer: string, day: string): string {
    if (!WRITER.test(writer)) {
        throw new Error(`spool writer ${SafeJSON.stringify(writer)} is not letters, digits, "_" or "-" (40 at most)`);
    }

    return `${writer}-${day}.jsonl`;
}

/** One spool line, newline included. `at` should be set by the writer: an absent one reads as the drain's time. */
export function spoolLine(event: MetricEvent): string {
    return `${SafeJSON.stringify({ v: SPOOL_VERSION, ...event }, { strict: true })}\n`;
}

/**
 * One checkpoint line, newline included: `{"v":1,"checkpoint":{...}}`. A producer without the service marks a
 * checkpoint with it; set `at`, or the drain's time stands for a new name.
 */
export function checkpointSpoolLine(checkpoint: MetricCheckpointInput): string {
    return `${SafeJSON.stringify({ v: SPOOL_VERSION, checkpoint }, { strict: true })}\n`;
}

/** Appends whole lines to today's file of `writer`, making the folder when missing. */
export function appendSpoolLines(options: { dir?: string; writer: string; lines: readonly string[]; now?: number }) {
    if (options.lines.length === 0) {
        return;
    }

    const dir = options.dir ?? spoolDir();
    mkdirSync(dir, { recursive: true });
    const day = formatLocalDate(new Date(options.now ?? Date.now()));
    appendFileSync(join(dir, spoolFileName(options.writer, day)), options.lines.join(""));
}

export interface DrainResult {
    /** Files that had new lines. */
    files: number;
    lines: number;
    events: number;
    /** Checkpoint lines taken in (added or updated). */
    checkpoints: number;
    /** Lines that did not parse or did not pass the event check; each is logged with its file and line number. */
    bad: number;
    /** Finished files of an earlier day that were deleted. */
    removed: string[];
    /** The drain stopped at its byte budget with lines still unread; the caller drains again later. */
    more: boolean;
}

export interface DrainOptions {
    dir?: string;
    now?: number;
    chunkBytes?: number;
    staleTailMs?: number;
    /**
     * The most bytes one call reads, over all files; the next call goes on where it stopped (`more`). Without it a
     * call reads every file to its end, which a large backlog turns into one long block of synchronous work. It also
     * caps the chunk, so a line longer than it counts as a bad line, as one longer than a chunk does.
     */
    maxBytes?: number;
    /** Hears each batch once it is in the store (the service's `event` subscribers). */
    onEvents?: (events: readonly StoredEvent[]) => void;
}

function readChunk(path: string, offset: number, length: number): Buffer {
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, offset);
        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

/**
 * A `{"v":1,"define":{...}}` line: a producer that cannot call the service (a plugin) declares its metric there, so
 * its dims get their index. Answers undefined for a shape or a name the store would refuse.
 */
function definitionOf(raw: unknown): MetricDefinition | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return undefined;
    }

    const project = Reflect.get(raw, "project");
    const metric = Reflect.get(raw, "metric");
    const unit = Reflect.get(raw, "unit");
    const description = Reflect.get(raw, "description");
    const dims = Reflect.get(raw, "dims");

    if (typeof project !== "string" || typeof metric !== "string") {
        return undefined;
    }

    if (dims !== undefined && !(Array.isArray(dims) && dims.every((dim) => typeof dim === "string"))) {
        return undefined;
    }

    try {
        return {
            project: assertMetricsName("project", project),
            metric: assertMetricsName("metric", metric),
            ...(typeof unit === "string" ? { unit } : {}),
            ...(typeof description === "string" ? { description } : {}),
            ...(dims ? { dims: dims.map(assertDimName) } : {}),
        };
    } catch {
        return undefined;
    }
}

interface ParsedLines {
    events: StoredEvent[];
    definitions: MetricDefinition[];
    checkpoints: MetricCheckpointInput[];
    lines: number;
    bad: number;
}

/** The events and definitions of whole lines; a bad line is counted and logged with its line number. */
function parseSpoolLines(text: string, context: { path: string; firstLine: number; now: number }): ParsedLines {
    const lines = text.split("\n");
    const events: StoredEvent[] = [];
    const definitions: MetricDefinition[] = [];
    const checkpoints: MetricCheckpointInput[] = [];
    let bad = 0;

    for (const [index, line] of lines.entries()) {
        if (line.trim() === "") {
            continue;
        }

        let parsed: unknown;

        try {
            parsed = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            bad += 1;
            log.warn({ path: context.path, line: context.firstLine + index, error }, "a metrics spool line is no JSON");
            continue;
        }

        const version =
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Reflect.get(parsed, "v") : null;

        if (version !== SPOOL_VERSION) {
            bad += 1;
            log.warn(
                { path: context.path, line: context.firstLine + index, version },
                "a metrics spool line has no known version"
            );
            continue;
        }

        const define = Reflect.get(Object(parsed), "define");

        if (define !== undefined) {
            const definition = definitionOf(define);

            if (definition) {
                definitions.push(definition);
            } else {
                bad += 1;
                log.warn(
                    { path: context.path, line: context.firstLine + index },
                    "a metrics spool define line names no valid metric"
                );
            }

            continue;
        }

        const checkpoint = Reflect.get(Object(parsed), "checkpoint");

        if (checkpoint !== undefined) {
            const checked = checkCheckpoint(checkpoint, context.now);

            if (checked.ok) {
                checkpoints.push(checked.checkpoint);
            } else {
                bad += 1;
                log.warn(
                    { path: context.path, line: context.firstLine + index, reason: checked.reason },
                    "a metrics spool checkpoint line is not a checkpoint"
                );
            }

            continue;
        }

        const check = checkEvent(parsed, context.now);

        if (!check.ok) {
            bad += 1;
            log.warn(
                { path: context.path, line: context.firstLine + index, reason: check.reason },
                "a metrics spool line is not an event"
            );
            continue;
        }

        events.push(check.event);
    }

    return { events, definitions, checkpoints, lines: lines.length, bad };
}

/**
 * Reads one file from its stored offset up to `size` (the caller's stat of it); answers the counts of what it took
 * in, and whether it is read to the end.
 */
function drainFile(
    store: MetricsStore,
    path: string,
    options: {
        size: number;
        now: number;
        chunkBytes: number;
        staleTail: boolean;
        /** The bytes this drain may still read; each chunk read counts against it. */
        budget: { left: number };
        onEvents?: (events: readonly StoredEvent[]) => void;
    }
): { lines: number; events: number; checkpoints: number; bad: number; atEnd: boolean } {
    const { size } = options;
    const stored = store.spoolFile(path);
    let offset = stored?.offset ?? 0;
    let lineNo = stored?.lines ?? 0;
    const counts = { lines: 0, events: 0, checkpoints: 0, bad: 0 };

    if (offset > size) {
        log.warn({ path, offset, size }, "a metrics spool file is shorter than its read offset; reading it again");
        offset = 0;
        lineNo = 0;
    }

    while (offset < size && options.budget.left > 0) {
        const chunk = readChunk(path, offset, Math.min(options.chunkBytes, size - offset, options.budget.left));
        // Every byte read counts, also a line end the next chunk reads again.
        options.budget.left -= chunk.length;
        const last = chunk.lastIndexOf(NEWLINE);
        let take: number;

        if (last >= 0) {
            take = last + 1;
        } else if (chunk.length >= options.chunkBytes || (options.staleTail && offset + chunk.length >= size)) {
            // A line longer than a chunk, or an earlier day's tail its writer never finished: one bad line.
            take = chunk.length;
        } else {
            break;
        }

        const text = chunk.subarray(0, last >= 0 ? last : take).toString("utf8");
        const parsed =
            last >= 0
                ? parseSpoolLines(text, { path, firstLine: lineNo + 1, now: options.now })
                : { events: [], definitions: [], checkpoints: [], lines: 1, bad: 1 };

        if (last < 0) {
            log.warn({ path, line: lineNo + 1, bytes: take }, "a metrics spool line has no end; skipped");
        }

        offset += take;
        lineNo += parsed.lines;
        // The chunk's definitions, checkpoints, events and new offset commit together: a crash before the offset
        // leaves none of them, so the chunk read again is applied once, in its own order.
        store.ingest({
            definitions: parsed.definitions,
            checkpoints: parsed.checkpoints,
            events: parsed.events,
            cursor: { path, offset, lines: lineNo },
            now: options.now,
        });

        if (parsed.events.length > 0) {
            options.onEvents?.(parsed.events);
        }

        counts.lines += parsed.lines;
        counts.events += parsed.events.length;
        counts.checkpoints += parsed.checkpoints.length;
        counts.bad += parsed.bad;
    }

    return { ...counts, atEnd: offset >= size };
}

/**
 * Reads every spool file from its stored offset into the store. Whole lines only: the events and the new offset are
 * written in one transaction, so a crash or a second drain never doubles an event. A finished file of an earlier day
 * is deleted (its events are in the store), then its offset is forgotten, but only once it is quiet: its last write
 * is older than the stale-tail wait (a writer queues a line for seconds, never minutes), and it did not change while
 * it was read. A file a writer still appends to stays for a later drain.
 */
export function drainSpool(store: MetricsStore, options: DrainOptions = {}): DrainResult {
    const dir = options.dir ?? spoolDir();
    const now = options.now ?? Date.now();
    const today = formatLocalDate(new Date(now));
    const result: DrainResult = { files: 0, lines: 0, events: 0, checkpoints: 0, bad: 0, removed: [], more: false };
    const budget = { left: options.maxBytes ?? Number.POSITIVE_INFINITY };
    // A chunk never outgrows the budget, so a fresh call can always take a whole chunk and the drain cannot stall.
    const chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? DRAIN_CHUNK_BYTES, budget.left));
    let names: string[];

    try {
        names = readdirSync(dir).sort();
    } catch (error) {
        log.debug({ error, dir }, "no metrics spool folder yet");
        return result;
    }

    for (const name of names) {
        const match = SPOOL_FILE.exec(name);

        if (!match) {
            continue;
        }

        if (budget.left <= 0) {
            result.more = true;
            break;
        }

        const path = join(dir, name);
        const earlier = (match[2] ?? today) < today;

        try {
            const before = statSync(path);
            const stale = earlier && now - before.mtimeMs > (options.staleTailMs ?? STALE_TAIL_MS);
            const read = drainFile(store, path, {
                size: before.size,
                now,
                chunkBytes,
                staleTail: stale,
                budget,
                ...(options.onEvents ? { onEvents: options.onEvents } : {}),
            });

            if (!read.atEnd && budget.left <= 0) {
                result.more = true;
            }

            if (read.lines > 0) {
                result.files += 1;
            }

            result.lines += read.lines;
            result.events += read.events;
            result.checkpoints += read.checkpoints;
            result.bad += read.bad;

            if (earlier && read.atEnd && stale && unchangedSince(path, before)) {
                unlinkSync(path);
                store.forgetSpoolFile(path);
                result.removed.push(path);
                log.debug({ path }, "a finished metrics spool file of an earlier day was removed");
            }
        } catch (error) {
            log.warn({ error, path }, "a metrics spool file could not be drained");
        }
    }

    if (result.lines > 0) {
        log.debug({ ...result, removed: result.removed.length }, "metrics spool drained");
    }

    return result;
}

/** The file still has the size the drain read to and the time of its last write before the drain. */
function unchangedSince(path: string, before: { size: number; mtimeMs: number }): boolean {
    const after = statSync(path);
    return after.size === before.size && after.mtimeMs === before.mtimeMs;
}
