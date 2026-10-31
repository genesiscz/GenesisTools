import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isMissingFileError, preserveUnreadableFile } from "./atomic-file";
import { withFileLock } from "./file-lock";

/**
 * One file that several processes read and rewrite: a hub setting, a dialog record list, a hook's per-session state,
 * the decision log. Every such store needs the same four things, and each used to compose them itself or leave one
 * out: a lock around the read-change-write, an atomic write, a policy for a file whose content cannot be used, and
 * (for a log) a feed event after the change is durable. This module is the one place that composes them.
 *
 * - {@link jsonDocument}: a whole-file JSON document.
 * - {@link jsonlLog}: an append-mostly JSONL log of rows, rewritten whole for a transition.
 * - {@link appendFeedEvent}: a change feed line that never fails the change it reports.
 */

/** Why a file that exists could not be used. `io` is a read error that is not ENOENT (EACCES, EIO, EISDIR). */
export type DocumentProblemKind = "io" | "too-large" | "json" | "shape";

export class DocumentUnreadableError extends Error {
    constructor(
        readonly kind: DocumentProblemKind,
        readonly path: string,
        options?: { cause?: unknown; message?: string }
    ) {
        super(options?.message ?? defaultProblemMessage(kind, path), { cause: options?.cause });
        this.name = "DocumentUnreadableError";
    }
}

function defaultProblemMessage(kind: DocumentProblemKind, path: string): string {
    const what = {
        io: "cannot be read",
        "too-large": "is larger than this store reads",
        json: "does not parse",
        shape: "does not have the expected shape",
    } satisfies Record<DocumentProblemKind, string>;
    return `${path} ${what[kind]}; it was left untouched`;
}

/**
 * What `update` does with a file that exists but cannot be used:
 * - `refuse`: throw, and leave the file as it is. For data a person made (settings, records, proposals).
 * - `preserve`: copy it aside as `<path>.corrupt-<time>`, then start from `empty()`. For state a hook must not fail
 *   on, where losing the content is acceptable but losing it silently is not.
 * - `discard`: start from `empty()` with no copy. For a cache that the next read rebuilds anyway.
 *
 * An `io` problem always throws: the content is unknown, so nothing may replace it.
 */
export type UnreadablePolicy = "refuse" | "preserve" | "discard";

export interface JsonDocumentSpec<T> {
    path: string;
    /** Defaults to `<path>.lock`. A store that shares its lock with another program (the Swift app) names it. */
    lockPath?: string;
    /** How long `update` waits for another writer. Defaults to {@link withFileLock}'s 5 s. */
    lockTimeoutMs?: number;
    /** The document when the file does not exist. */
    empty: () => T;
    /** The document from the parsed JSON. Throw when the value does not have the document's shape. */
    decode: (raw: unknown) => T;
    /** The file's text. Defaults to compact `SafeJSON.stringify`. Throw to refuse a write (a size cap). */
    encode?: (doc: T) => string;
    /** Parse with `SafeJSON`'s strict mode (no comments, no trailing commas). */
    strictJson?: boolean;
    /** A larger file is a `too-large` problem, found before the text is parsed. */
    maxBytes?: number;
    onUnreadable: UnreadablePolicy;
    /**
     * `always`: every update writes. `when-changed` (the default): an update whose result encodes the same as the
     * document it read writes nothing, so a no-op never bumps a revision or wakes a watcher.
     */
    writes?: "always" | "when-changed";
    /** Runs on the changed document before it is encoded: bump a revision, validate the result. */
    beforeWrite?: (doc: T) => void;
    /** The mode of the written file (`0o600` for private data) and of a directory `update` creates. */
    fileMode?: number;
    dirMode?: number;
    /**
     * Runs after the write, still under the lock: keep a derived file in step with the document (an index, a marker).
     * A throw here fails the update, but the document is already written.
     */
    afterWrite?: (doc: T) => void;
    /** The error `read` and a refusing `update` throw. Defaults to the {@link DocumentUnreadableError} itself. */
    unreadableError?: (problem: DocumentUnreadableError) => Error;
}

/** The encoding most hand-editable stores use: two-space indented JSON with a final newline. */
export function prettyJson(doc: unknown): string {
    return `${SafeJSON.stringify(doc, null, 2)}\n`;
}

/** What an `update` callback asks for: write `write` and return `result`, or write nothing and return `keep`. */
export type DocumentUpdate<T, R> = { write: T; result: R } | { keep: R };

export interface JsonDocument<T> {
    readonly path: string;
    /**
     * The document without the lock: `empty()` when the file does not exist. A file that cannot be used throws
     * (`unreadableError`). `decode` overrides the spec's decoder for this read, for a listing that skips a bad
     * entry where an update refuses it.
     */
    read(options?: { decode?: (raw: unknown) => T }): T;
    /** Lock, read (applying `onUnreadable`), change, write atomically, unlock. The change runs synchronously. */
    update<R>(change: (current: T) => DocumentUpdate<T, R>, options?: { signal?: AbortSignal }): Promise<R>;
    /** {@link update} for a change made in place: the document is written when its JSON changed. */
    mutate<R>(change: (doc: T) => R, options?: { signal?: AbortSignal }): Promise<R>;
}

type Loaded<T> =
    | { state: "missing" }
    | { state: "ok"; value: T }
    | { state: "unusable"; problem: DocumentUnreadableError };

function load<T>(spec: JsonDocumentSpec<T>, decode: (raw: unknown) => T): Loaded<T> {
    let text: string;

    try {
        if (spec.maxBytes !== undefined && statSync(spec.path).size > spec.maxBytes) {
            return { state: "unusable", problem: new DocumentUnreadableError("too-large", spec.path) };
        }

        text = readFileSync(spec.path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return { state: "missing" };
        }

        throw mapped(spec, new DocumentUnreadableError("io", spec.path, { cause: error }));
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(text, spec.strictJson ? { strict: true } : undefined);
    } catch (error) {
        return { state: "unusable", problem: new DocumentUnreadableError("json", spec.path, { cause: error }) };
    }

    try {
        return { state: "ok", value: decode(raw) };
    } catch (error) {
        return { state: "unusable", problem: new DocumentUnreadableError("shape", spec.path, { cause: error }) };
    }
}

function mapped<T>(spec: JsonDocumentSpec<T>, problem: DocumentUnreadableError): Error {
    return spec.unreadableError ? spec.unreadableError(problem) : problem;
}

/** The document an update starts from, after `onUnreadable` decided what an unusable file means. */
function loadForUpdate<T>(spec: JsonDocumentSpec<T>): T {
    const loaded = load(spec, spec.decode);

    if (loaded.state === "ok") {
        return loaded.value;
    }

    if (loaded.state === "missing") {
        return spec.empty();
    }

    if (spec.onUnreadable === "refuse") {
        throw mapped(spec, loaded.problem);
    }

    if (spec.onUnreadable === "preserve") {
        // Throws when the copy cannot be made: the original would then be the only copy, so nothing replaces it.
        preserveUnreadableFile(spec.path, loaded.problem.cause ?? loaded.problem);
    } else {
        logger.debug({ path: spec.path, kind: loaded.problem.kind }, "[storage] an unusable cache file is replaced");
    }

    return spec.empty();
}

export function jsonDocument<T>(spec: JsonDocumentSpec<T>): JsonDocument<T> {
    const encode = spec.encode ?? ((doc: T) => SafeJSON.stringify(doc));
    const lockPath = spec.lockPath ?? `${spec.path}.lock`;

    const update = async <R>(
        change: (current: T) => DocumentUpdate<T, R>,
        options?: { signal?: AbortSignal }
    ): Promise<R> => {
        options?.signal?.throwIfAborted();
        mkdirSync(dirname(spec.path), {
            recursive: true,
            ...(spec.dirMode !== undefined ? { mode: spec.dirMode } : {}),
        });

        const run = async (): Promise<R> => {
            // Waiting for another writer can take seconds; a change withdrawn meanwhile must not commit.
            options?.signal?.throwIfAborted();
            const current = loadForUpdate(spec);
            const before = spec.writes === "always" ? undefined : SafeJSON.stringify(current);
            const outcome = change(current);

            if ("keep" in outcome) {
                return outcome.keep;
            }

            if (before !== undefined && SafeJSON.stringify(outcome.write) === before) {
                return outcome.result;
            }

            spec.beforeWrite?.(outcome.write);
            const text = encode(outcome.write);
            // The encode and the rename run with no await between them, so a cancel seen here is the last one
            // that can still stop the save.
            options?.signal?.throwIfAborted();
            atomicWriteFileSync(spec.path, text, spec.fileMode !== undefined ? { mode: spec.fileMode } : undefined);
            spec.afterWrite?.(outcome.write);
            return outcome.result;
        };

        return spec.lockTimeoutMs === undefined
            ? withFileLock(lockPath, run)
            : withFileLock(lockPath, run, spec.lockTimeoutMs);
    };

    return {
        path: spec.path,
        read(options) {
            const loaded = load(spec, options?.decode ?? spec.decode);

            if (loaded.state === "ok") {
                return loaded.value;
            }

            if (loaded.state === "missing") {
                return spec.empty();
            }

            throw mapped(spec, loaded.problem);
        },
        update,
        mutate(change, options) {
            return update((doc) => ({ write: doc, result: change(doc) }), options);
        },
    };
}

export interface JsonlLogSpec<Row> {
    path: string;
    /** Defaults to `<path>.lock`. */
    lockPath?: string;
    lockTimeoutMs?: number;
    /** A parsed line that is a row. Any other line is skipped by `read` and carried over verbatim by `rewrite`. */
    isRow: (value: unknown) => value is Row;
}

export interface JsonlRead<Row> {
    rows: Row[];
    /** Lines that do not parse (a writer killed mid-append, a hand edit). */
    torn: number;
    /** Lines that parse but are not rows (an older shape, a hand edit). */
    malformed: number;
    missing: boolean;
}

export interface JsonlLog<Row> {
    readonly path: string;
    /** Every readable row, in file order. One bad line is counted and skipped and never hides the others. */
    read(): JsonlRead<Row>;
    /** Run `fn` holding the log's lock, so a read, the change and the write are one critical section. Not reentrant. */
    locked<T>(fn: () => T): Promise<T>;
    /** Append one row. It starts on a fresh line when the last write was torn, so one bad row cannot swallow it. */
    append(row: Row): void;
    /**
     * Replace every readable row, atomically. The lines `read` skipped are carried over verbatim at the top, or the
     * rewrite would delete them for good. Call it holding the lock, with rows from a `read` under the same lock.
     */
    rewrite(rows: readonly Row[]): void;
}

export function jsonlLog<Row>(spec: JsonlLogSpec<Row>): JsonlLog<Row> {
    const lockPath = spec.lockPath ?? `${spec.path}.lock`;

    const isReadableLine = (line: string): boolean => {
        try {
            return spec.isRow(SafeJSON.parse(line, { strict: true }));
        } catch {
            // Not an error here: the line is one `read` skips and counts, and `rewrite` keeps.
            return false;
        }
    };

    const unreadableLines = (): string[] => {
        let text: string;

        try {
            text = readFileSync(spec.path, "utf8");
        } catch (error) {
            if (isMissingFileError(error)) {
                return [];
            }

            throw error;
        }

        return text.split("\n").filter((line) => line.trim().length > 0 && !isReadableLine(line));
    };

    return {
        path: spec.path,
        read() {
            const { rows, skipped, missing } = readJsonlRows<unknown>(spec.path);
            const valid = rows.filter(spec.isRow);
            return { rows: valid, torn: skipped, malformed: rows.length - valid.length, missing: missing === true };
        },
        locked(fn) {
            const run = async () => fn();
            return spec.lockTimeoutMs === undefined
                ? withFileLock(lockPath, run)
                : withFileLock(lockPath, run, spec.lockTimeoutMs);
        },
        append(row) {
            appendJsonlLine(spec.path, row);
        },
        rewrite(rows) {
            const lines = [...unreadableLines(), ...rows.map((row) => SafeJSON.stringify(row))];
            atomicWriteFileSync(spec.path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
        },
    };
}

/** Append one JSON line, starting on a fresh line when the file's last write was torn. */
function appendJsonlLine(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${endsTorn(path) ? "\n" : ""}${SafeJSON.stringify(value)}\n`);
}

function endsTorn(path: string): boolean {
    let size: number;

    try {
        size = statSync(path).size;
    } catch (error) {
        if (isMissingFileError(error)) {
            return false;
        }

        throw error;
    }

    if (size === 0) {
        return false;
    }

    const last = Buffer.alloc(1);
    const fd = openSync(path, "r");

    try {
        readSync(fd, last, 0, 1, size - 1);
    } finally {
        closeSync(fd);
    }

    return last[0] !== 0x0a;
}

/**
 * A change feed is a hint that lets a watcher notice a change sooner; the record it describes is the truth. So the
 * event is appended AFTER the change is durable and never fails it: a caller told "failed" about a change that
 * committed would retry it. A lost event goes to `onLost`; a reader that missed it still sees the record.
 */
export function appendFeedEvent(path: string, event: Record<string, unknown>, onLost: (error: unknown) => void): void {
    try {
        appendJsonlLine(path, event);
    } catch (error) {
        onLost(error);
    }
}
