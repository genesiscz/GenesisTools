import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { RmBashWrite } from "@genesiscz/utils/rm";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { namedArguments } from "../hooks/diff/command-paths";
import { safeSegment } from "../hooks/paths";

const MAX_BYTES = 2_000_000;
const SAMPLE_BYTES = 8_192;

export interface ChangeEvent {
    ts: string;
    provider: string;
    session: string;
    /** The turn id from the payload; without one, the tool call's id stands in for it. */
    turn: string;
    tool: string;
    /** The tool call that made the change (Claude `tool_use.id`, Codex and Grok call ids). */
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
    skipped?: "binary" | "large";
    /** Why the before-state has no `beforeOid`. */
    beforeSkipped?: "binary" | "large";
    /** Why the after-state has no `afterOid`. */
    afterSkipped?: "binary" | "large";
}

export interface ChangeSink {
    hash: (bytes: Buffer) => string;
    /** Every blob of one call in ONE store operation, oids in the same order. `hash` is the fallback. */
    hashAll?: (blobs: Buffer[]) => string[];
    log: (line: string) => void;
}

export interface ChangeBytes {
    before?: Buffer;
    after?: Buffer;
    beforeSkipped?: "binary" | "large";
    afterSkipped?: "binary" | "large";
}

/**
 * One session's change log, shared by the hook that writes it and the command that reads it.
 * The id comes from a hook payload or a CLI argument, so it must be one plain path segment:
 * `../../x` would otherwise write and read outside the agents directory. Throws on anything else.
 */
export function sessionChangesPath(session: string): string {
    const safe = safeSegment(session);

    if (safe === null) {
        throw new Error(`not a session id: "${session}"`);
    }

    return genesisToolsDir("agents", safe, "changes.jsonl");
}

/** The tail of a change log the Bash-write lookup reads; older rows are not read, and the cap is logged. */
export const BASH_LOOKUP_MAX_BYTES = 8 * 1024 * 1024;

/** The Bash-write indexes loaded in this process, kept for this many sessions (least recently used goes first). */
const BASH_INDEX_SESSIONS = 8;

interface BashWriteIndex {
    size: number;
    mtimeMs: number;
    maxBytes: number;
    byPath: Map<string, RmBashWrite[]>;
}

/** One index per session, reused while its log keeps the same size and mtime: a sweep of many requests reads once. */
const bashWriteIndexes = new Map<string, BashWriteIndex>();

/**
 * Every Bash command of `session` that recorded writing each path (`tools rm`'s own-files rule asks), in log order:
 * when it began (rows before 2026-11-02 carry no start) and when its row was written. The log's last
 * `maxBytes` are read once, on the first lookup, into an index by path that later lookups of the same session in
 * this process share while the log is unchanged. A row of another source, a torn line, a missing log or an unsafe
 * id give no entry.
 */
export function bashWriteLookup(
    session: string,
    { maxBytes = BASH_LOOKUP_MAX_BYTES }: { maxBytes?: number } = {}
): (path: string) => RmBashWrite[] {
    let index: Map<string, RmBashWrite[]> | null | undefined;

    return (path) => {
        if (index === undefined) {
            index = bashWriteIndex(session, maxBytes);
        }

        return index?.get(path) ?? [];
    };
}

function bashWriteIndex(session: string, maxBytes: number): Map<string, RmBashWrite[]> | null {
    let file: string;
    let size: number;
    let mtimeMs: number;

    try {
        file = sessionChangesPath(session);
        ({ size, mtimeMs } = statSync(file));
    } catch (error) {
        logger.debug({ session, error }, "agents: no change log to read Bash writes from");
        return null;
    }

    const cached = bashWriteIndexes.get(session);
    bashWriteIndexes.delete(session);

    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.maxBytes === maxBytes) {
        bashWriteIndexes.set(session, cached);
        return cached.byPath;
    }

    let text: string;

    try {
        text = readTail(file, size, maxBytes);
    } catch (error) {
        logger.debug({ session, error }, "agents: cannot read the change log for Bash writes");
        return null;
    }

    if (size > maxBytes) {
        logger.debug(
            { session, size, maxBytes },
            "agents: change log over the cap: Bash writes before its last bytes are not read"
        );
    }

    const byPath = new Map<string, RmBashWrite[]>();

    for (const line of text.split("\n")) {
        if (!line.includes('"source":"bash"')) {
            continue;
        }

        let row: unknown;

        try {
            row = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            logger.debug({ session, error }, "agents: skipping a torn change-log row");
            continue;
        }

        const write = bashWriteOf(row);

        if (!write) {
            continue;
        }

        // One array per path, appended in log order: a copy per row made N writes of one path cost O(N²).
        const writes = byPath.get(write.path);

        if (writes) {
            writes.push(write.write);
        } else {
            byPath.set(write.path, [write.write]);
        }
    }

    bashWriteIndexes.set(session, { size, mtimeMs, maxBytes, byPath });

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
        const text = buffer.subarray(0, read).toString("utf8");
        return text.slice(text.indexOf("\n") + 1);
    } finally {
        closeSync(fd);
    }
}

/** A Bash row's path, start and end; null for any other row. */
function bashWriteOf(row: unknown): { path: string; write: RmBashWrite } | null {
    if (
        typeof row !== "object" ||
        row === null ||
        !("source" in row) ||
        row.source !== "bash" ||
        !("path" in row) ||
        typeof row.path !== "string" ||
        !("ts" in row) ||
        typeof row.ts !== "string"
    ) {
        return null;
    }

    const began = "began" in row && typeof row.began === "string" ? row.began : undefined;
    return { path: row.path, write: { ...(began ? { began } : {}), ended: row.ts } };
}

/** The harness file tools this log records: Edit and MultiEdit as `edit`, Write as `write`. */
export function fileToolSource(tool: string): "edit" | "write" | null {
    const normalized = tool.toLowerCase().replace(/_/g, "");

    if (normalized === "edit" || normalized === "multiedit") {
        return "edit";
    }

    return normalized === "write" ? "write" : null;
}

/**
 * Record one Edit or Write. The harness hands the text before the call as `originalFile` (a
 * string for an edit, null for a file the call created); the text after is read from disk.
 * Any other tool records nothing. Never throws.
 */
export function recordFileToolEdit(
    file: string,
    event: Omit<ChangeEvent, "ts" | "source" | "beforeOid" | "afterOid"> & { ts?: string },
    original: string | null | undefined,
    sink: ChangeSink
): void {
    const source = fileToolSource(event.tool);

    if (!source) {
        return;
    }

    const after = readCapped(event.path);
    const before = typeof original === "string" ? Buffer.from(original) : undefined;
    // Both blobs in ONE `git hash-object` run: measured 2026-09-24, two runs cost the Edit hook
    // 11.5 ms against 7.9 ms for a batched Bash call (docs/benchmarks-cpu.md).
    recordChange(
        file,
        { ...event, source },
        { before, after: after.after, afterSkipped: after.afterSkipped },
        prehashed(sink, [before, after.after])
    );
}

/**
 * A shell command that writes files, as opposed to one that only reads.
 *
 * Edit and Write are recorded from their own hook payloads (`recordFileToolEdit`).
 * fable-replace, python, and the in-place editors go through Bash, which used to leave no row
 * at all. A print-only `python -c` and a plain `git status` stay read-only: a read-only command
 * writes nothing.
 */
export function commandEditsFiles(command: string): boolean {
    const text = command.trim();

    if (text.length === 0) {
        return false;
    }

    if (/\bfable-replace\b/.test(text)) {
        return true;
    }

    // The in-place flag must belong to the editor itself, in its own pipeline stage:
    // `sed -n p f | grep -i x` only reads.
    if (/\b(?:sed|perl|ruby)\b[^|;&]*\s-[A-Za-z]*i/.test(text)) {
        return true;
    }

    if (
        text
            .split(/\|\||&&|[|;&\n]/)
            .some((stage) => stageWritesFiles(stage.trim()) || pythonStageWrites(stage.trim(), text))
    ) {
        return true;
    }

    // A redirection token, not an arrow inside an argument (`->`, `=>`), a descriptor dup
    // (`2>&1`) or a discard (`>/dev/null`). `2> err.log` and `&> out` still write a file.
    return /(?:^|[\s;&|(])(?:\d+|&)?>>?(?!&)\s*(?!\/dev\/(?:null|stdout|stderr|tty)\b)[^\s;&|)]/.test(text);
}

/**
 * One pipeline stage whose COMMAND changes files: delete, move and copy, the git verbs that
 * rewrite the working tree, and formatters in their write mode. Judged by the command word at
 * the start of the stage (after env assignments and a `bunx`/`npx` runner), never by a name
 * appearing anywhere, so `echo rm` or `grep checkout` stays read-only.
 */
function stageWritesFiles(stage: string): boolean {
    const command = stage.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+)?(?:bunx|npx|bun\s+x)?\s*/, "");

    return (
        /^(?:rm|rmdir|mv|cp|ln|unlink|truncate|install|patch|tee)\s/.test(command) ||
        /^git\s+(?:-C\s+\S+\s+)?(?:apply|checkout|switch|restore|stash|reset|mv|rm|am|cherry-pick|revert|merge|rebase|pull)\b/.test(
            command
        ) ||
        /^(?:prettier|biome|eslint)\b.*\s--(?:write|fix|apply)\b/.test(command) ||
        /^(?:gofmt|goimports)\b.*\s-w\b/.test(command) ||
        /^(?:rustfmt|black)\s/.test(command) ||
        /^ruff\s+(?:format\b|check\b.*\s--fix\b)/.test(command)
    );
}

/** Python code that writes: a file opened for writing, a write call, or a file-system mutation. */
const PYTHON_WRITES =
    /\bopen\s*\([^()]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]|\.write\s*\(|\bwrite_(?:text|bytes)\s*\(|\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\s*\(|\bshutil\.\w+\s*\(|\.(?:unlink|touch|mkdir|rmdir)\s*\(/;

/** `python -m` modules that rewrite files in place (the formatters). */
const PYTHON_WRITING_MODULES = new Set(["black", "isort", "autopep8", "yapf"]);

/**
 * One pipeline stage that runs Python, judged by what it runs rather than by the interpreter's
 * name: inline code (`-c`, a heredoc, stdin) edits only with a write in the command text, a
 * script file counts as an edit because its code is not in the command, `-m` counts for the
 * formatters only, and `--version`, `-m pytest` or a mention of python in another command do not.
 */
function pythonStageWrites(stage: string, text: string): boolean {
    const args = stage.match(
        /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+)?(?:\S*\/)?python(?:3(?:\.\d+)?)?(?:\s+(.*))?$/s
    );

    if (!args) {
        return false;
    }

    const words = (args[1] ?? "").split(/\s+/).filter(Boolean);

    for (const [index, word] of words.entries()) {
        if (word === "-c" || word === "-" || word.startsWith("<")) {
            return PYTHON_WRITES.test(text);
        }

        if (word === "-m") {
            return PYTHON_WRITING_MODULES.has(words[index + 1] ?? "") || PYTHON_WRITES.test(text);
        }

        if (!word.startsWith("-")) {
            return true;
        }
    }

    return PYTHON_WRITES.test(text);
}

/** The same caps for bytes from any source: past the size limit or binary, only the reason is kept. */
export function capBlob(bytes: Buffer): ChangeBytes {
    if (bytes.length > MAX_BYTES) {
        return { afterSkipped: "large" };
    }

    if (bytes.subarray(0, SAMPLE_BYTES).includes(0)) {
        return { afterSkipped: "binary" };
    }

    return { after: bytes };
}

/** The largest blob kept whole; a reader may ask for one byte more to learn it is too large. */
export const MAX_BLOB_BYTES = MAX_BYTES;

/** Read a file the hook already capped, or mark it skipped. Never throws. */
export function readCapped(path: string | null): ChangeBytes {
    if (!path || !existsSync(path)) {
        return {};
    }

    try {
        if (statSync(path).size > MAX_BYTES) {
            return { afterSkipped: "large" };
        }

        return capBlob(readFileSync(path));
    } catch {
        return {};
    }
}

function discoveredPaths(command: string, cwd: string): string[] {
    let named: string[] = [];

    try {
        named = namedArguments(command, [cwd]);
    } catch {
        return [];
    }

    const kept = named.filter((path) => !path.includes(`${sep}fable-replace${sep}`));

    if (!/\bpython3?\b/.test(command)) {
        return kept;
    }

    const script = kept.find((path) => path.endsWith(".py"));

    if (!script) {
        return kept;
    }

    return kept.filter((path) => path !== script);
}

function modifiedSince(path: string, since: number): boolean {
    try {
        return statSync(path).mtimeMs >= since;
    } catch {
        // A path that cannot be stat'ed now was not written by this command.
        return false;
    }
}

function blobKind(bytes: Buffer | undefined): "binary" | "large" | undefined {
    if (!bytes) {
        return undefined;
    }

    if (bytes.length > MAX_BYTES) {
        return "large";
    }

    if (bytes.subarray(0, SAMPLE_BYTES).includes(0)) {
        return "binary";
    }

    return undefined;
}

export interface ScriptedTouch {
    path: string;
    before?: Buffer;
    after?: Buffer;
    beforeSkipped?: "binary" | "large";
    afterSkipped?: "binary" | "large";
}

/**
 * Record files a scripted editor changed. A read-only command records nothing, even when the
 * caller hands it paths. Never throws.
 */
export function recordScriptedEdits(
    file: string,
    command: string,
    {
        since,
        known,
        ...event
    }: Omit<ChangeEvent, "ts" | "source" | "path" | "beforeOid" | "afterOid"> & {
        ts?: string;
        /**
         * When the command began, in epoch ms. A path the command only NAMES is logged when
         * its mtime is at or after this; without it, only `touched` is logged. A named input
         * (`python3 transform.py in.csv > out.csv`) is otherwise not a change.
         */
        since?: number;
        /** Paths another call records for this same command: a named path among them is not logged again. */
        known?: ReadonlySet<string>;
    },
    touched: ScriptedTouch[],
    sink: ChangeSink
): void {
    try {
        if (!commandEditsFiles(command)) {
            return;
        }

        const byPath = new Map<string, ScriptedTouch>();

        for (const item of touched) {
            byPath.set(item.path, item);
        }

        const discovered = since === undefined ? [] : discoveredPaths(command, event.cwd);

        for (const path of discovered) {
            if (byPath.has(path) || known?.has(path) || since === undefined || !modifiedSince(path, since)) {
                continue;
            }

            const read = readCapped(path);

            if (!read.after && !read.afterSkipped) {
                continue;
            }

            byPath.set(path, { path, after: read.after, afterSkipped: read.afterSkipped });
        }

        const items = [...byPath.values()];
        const batched = prehashed(
            sink,
            items.flatMap((item) => [item.before, item.after])
        );

        for (const item of items) {
            recordChange(
                file,
                { ...event, path: item.path, source: "bash" },
                {
                    before: item.before,
                    after: item.after,
                    beforeSkipped: item.beforeSkipped,
                    afterSkipped: item.afterSkipped,
                },
                batched
            );
        }
    } catch (error) {
        sink.log(`changes sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * A sink that answers from ONE `hashAll` over every storable blob of a call. A codemod that
 * touched N files used to start about 2N `git` processes, one per blob, against a hook timeout.
 * A sink without `hashAll`, or a batch that fails, falls back to hashing each blob on its own.
 */
function prehashed(sink: ChangeSink, blobs: Array<Buffer | undefined>): ChangeSink {
    const storable = blobs.filter((bytes): bytes is Buffer => bytes !== undefined && blobKind(bytes) === undefined);

    if (!sink.hashAll || storable.length === 0) {
        return sink;
    }

    let oids: string[];

    try {
        oids = sink.hashAll(storable);
    } catch (error) {
        sink.log(
            `batched hashing failed, hashing blob by blob: ${error instanceof Error ? error.message : String(error)}`
        );
        return sink;
    }

    const known = new Map<Buffer, string>();
    storable.forEach((bytes, index) => {
        const oid = oids[index];

        if (oid) {
            known.set(bytes, oid);
        }
    });

    return { ...sink, hash: (bytes) => known.get(bytes) ?? sink.hash(bytes) };
}

/** Append one change. Never throws. Identical content is stored once by the hash function. */
export function recordChange(
    file: string,
    event: Omit<ChangeEvent, "ts" | "beforeOid" | "afterOid"> & { ts?: string },
    bytes: ChangeBytes | null,
    sink: ChangeSink
): void {
    try {
        const row: ChangeEvent = {
            ts: event.ts ?? new Date().toISOString(),
            ...event,
            beforeOid: null,
            afterOid: null,
        };

        const beforeKind = bytes?.beforeSkipped ?? blobKind(bytes?.before);

        if (beforeKind) {
            row.skipped = beforeKind;
            row.beforeSkipped = beforeKind;
        } else if (bytes?.before) {
            row.beforeOid = sink.hash(bytes.before);
        }

        const afterKind = bytes?.afterSkipped ?? blobKind(bytes?.after);

        if (afterKind) {
            row.skipped = afterKind;
            row.afterSkipped = afterKind;
        } else if (bytes?.after) {
            row.afterOid = sink.hash(bytes.after);
        }

        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${SafeJSON.stringify(row)}\n`);
    } catch (error) {
        sink.log(`changes sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** The ids of the last `count` turns in log order (a turn's rows can interleave with the next one's). */
export function lastTurnIds(rows: ReadonlyArray<Pick<ChangeEvent, "turn">>, count: number): string[] {
    const order: string[] = [];

    for (const row of rows) {
        const at = order.indexOf(row.turn);

        if (at !== -1) {
            order.splice(at, 1);
        }

        order.push(row.turn);
    }

    return order.slice(-count);
}
