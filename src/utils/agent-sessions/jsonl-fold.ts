import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { markBefore } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { asRecord, type JsonRecord, type JsonValue } from "./source-scan";

/** One file's fold, kept between processes: what was read up to `consumed`, and the issues found there. */
interface StoredFold<S> {
    ino: number;
    /** Bytes up to and including the last newline already folded into `state`. */
    consumed: number;
    /** Physical lines up to `consumed` (for "… at line N" issues after it). */
    line: number;
    mark: string;
    /** Issue messages found before `consumed`, in order: reported again on every read, as a full scan would. */
    issues: string[];
    state: S;
}

interface FoldStore {
    version: 1;
    files: Record<string, StoredFold<unknown>>;
}

/** Files kept per store: the live and recently changed sessions are what get re-read. */
const STORE_FILES = 20;
/** Smaller files are folded from the start without the store: re-reading them is cheap, the store is not free. */
const RESUME_MIN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
/**
 * Every fold of this process, any size, by path: the store above skips files under 8 MB, so a resident process (the
 * hub server) parsed each live 5-6 MB Codex sub-agent rollout from its start on every change, 35-40 ms each and
 * about 130 reads in 12 minutes (2026-10-08). A kept fold is checked like a stored one before it is used.
 */
const memoryFolds = new Map<string, StoredFold<unknown>>();
const MEMORY_FILES = 64;

function readStore(path: string): FoldStore {
    if (!existsSync(path)) {
        return { version: 1, files: {} };
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as FoldStore;
        return parsed?.version === 1 && parsed.files ? parsed : { version: 1, files: {} };
    } catch (error) {
        logger.debug({ error, path }, "[agent-sessions] fold store unreadable; starting over");
        return { version: 1, files: {} };
    }
}

function writeStore(path: string, store: FoldStore): void {
    const keys = Object.keys(store.files);
    for (const key of keys.slice(0, Math.max(0, keys.length - STORE_FILES))) {
        delete store.files[key];
    }

    try {
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, SafeJSON.stringify(store, { strict: true }) ?? "");
    } catch (error) {
        logger.debug({ error, path }, "[agent-sessions] fold store not written; the next read starts over");
    }
}

export interface FoldJsonlOptions<S> {
    path: string;
    /** The JSON file that keeps every file's fold for this kind of read (one per reader). */
    storePath: string;
    initial: () => S;
    /** A deep enough copy that `apply` on it leaves the stored state alone. */
    copy: (state: S) => S;
    /** One record, in file order. */
    apply: (state: S, row: JsonRecord) => void;
    onIssue: (message: string) => void;
    signal?: AbortSignal;
    /** Files smaller than this are folded whole and not kept (default 8 MB; tests pass 0). */
    resumeMinBytes?: number;
}

/**
 * Folds every JSON record of an append-only JSONL file, like a full `scanJsonlRecords` pass, but kept
 * between processes: the next read of a file that only grew starts at the last complete line. The issues
 * are the scan's own, with the same line numbers ("Malformed record at line N"; "Partial final record at
 * line N" for an unfinished last line, which is folded into a copy and never kept). A file replaced (another
 * inode), shorter, or with other bytes at its start or before the kept end is folded from the start again.
 *
 * Measured 2026-10-08: the `ai usage` poll daemon, a new process every minute, read the whole live Codex
 * rollout (163 MB) for its metadata on each tick (`metadata.codex` ~1 s of CPU).
 *
 * Returns null when the file cannot be read (the issue is reported: "Source missing" / "Source read failed").
 */
export function foldJsonlResumable<S>(options: FoldJsonlOptions<S>): S | null {
    let fd: number | null = null;
    try {
        fd = openSync(options.path, "r");
    } catch (error) {
        const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
        options.onIssue(missing ? "Source missing" : "Source read failed");
        return null;
    }

    try {
        const { size, ino } = fstatSync(fd);
        const resumable = size >= (options.resumeMinBytes ?? RESUME_MIN_BYTES);
        const store: FoldStore = resumable ? readStore(options.storePath) : { version: 1, files: {} };
        const openFd = fd;
        const usable = (candidate: StoredFold<S> | undefined): candidate is StoredFold<S> =>
            candidate !== undefined &&
            candidate.ino === ino &&
            candidate.consumed <= size &&
            markBefore(openFd, candidate.consumed) === candidate.mark;
        const inMemory = memoryFolds.get(options.path) as StoredFold<S> | undefined;
        const stored = store.files[options.path] as StoredFold<S> | undefined;
        const kept = usable(inMemory) ? inMemory : usable(stored) ? stored : undefined;
        const fold: StoredFold<S> = kept
            ? { ...kept, issues: [...kept.issues], state: options.copy(kept.state) }
            : { ino, consumed: 0, line: 0, mark: "", issues: [], state: options.initial() };

        for (const message of fold.issues) {
            options.onIssue(message);
        }

        const fold1 = (text: string, line: number, partial: boolean, into: S, issues: string[] | null): void => {
            const original = text.replace(/\r$/, "");
            if (!original.trim()) {
                return;
            }

            let value: JsonValue;
            try {
                value = SafeJSON.parse(original, { strict: true }) as JsonValue;
            } catch {
                const message = `${partial ? "Partial final record" : "Malformed record"} at line ${line}`;
                issues?.push(message);
                options.onIssue(message);
                return;
            }

            options.apply(into, asRecord(value));
        };

        // Complete lines, in chunks, cut at newline bytes.
        let position = fold.consumed;
        let carried = Buffer.alloc(0);
        const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size - fold.consumed)));
        for (;;) {
            options.signal?.throwIfAborted();
            const read = readSync(fd, chunk, 0, chunk.length, position);
            if (read === 0) {
                break;
            }

            position += read;
            const bytes =
                carried.length > 0 ? Buffer.concat([carried, chunk.subarray(0, read)]) : chunk.subarray(0, read);
            let start = 0;
            let newline = bytes.indexOf(10, start);
            while (newline !== -1) {
                fold.line++;
                fold1(bytes.toString("utf8", start, newline), fold.line, false, fold.state, fold.issues);
                fold.consumed += newline + 1 - start;
                start = newline + 1;
                newline = bytes.indexOf(10, start);
            }

            carried = Buffer.from(bytes.subarray(start));
        }

        fold.mark = markBefore(fd, fold.consumed);
        memoryFolds.delete(options.path);
        memoryFolds.set(options.path, { ...fold, issues: [...fold.issues], state: options.copy(fold.state) });
        if (memoryFolds.size > MEMORY_FILES) {
            const oldest = memoryFolds.keys().next().value;
            if (oldest !== undefined) {
                memoryFolds.delete(oldest);
            }
        }

        if (resumable) {
            delete store.files[options.path];
            store.files[options.path] = { ...fold, state: options.copy(fold.state) } as StoredFold<unknown>;
            writeStore(options.storePath, store);
        }

        // The unfinished last line counts as a full scan counts it, in a copy that is never kept.
        const result = options.copy(fold.state);
        if (carried.length > 0) {
            fold1(carried.toString("utf8"), fold.line + 1, true, result, null);
        }

        return result;
    } catch (error) {
        options.signal?.throwIfAborted();
        logger.debug({ error, path: options.path }, "[agent-sessions] resumable fold failed");
        options.onIssue("Source read failed");
        return null;
    } finally {
        closeSync(fd);
    }
}
