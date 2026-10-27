import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { ForwardRead, ForwardRow, ReadForwardOptions } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("question-rows");

/**
 * Where a session's question items were asked, for "jump to": the row of each `❓ DECISION N` first ask (an assistant
 * text that asks it without a link) and every question tool call with its time. One index per transcript under
 * `~/.genesis-tools/question/cache/transcript-rows/`, shared by every caller (each session's mods, the hub, the
 * widget): a call reads only the bytes appended since the index's offset, and an unchanged transcript costs one `stat`.
 */

/** v1: the first index. Bump when what a row or a call means changes, so an old index is read again from 0. */
const INDEX_VERSION = 1;
/** Bytes before the offset kept as a fingerprint: a file rewritten in place under the same inode starts again at 0. */
const GUARD_BYTES = 64;
/** Raw-row filter: only rows holding one of these are parsed. The parse itself is the provider reader's. */
export const ROW_FILTER = [
    "DECISION",
    "question_post",
    "question_update",
    "question_answer",
    "inbox_send",
    "tools question",
] as const;
const FIRST_ASK = /(^|[^[])❓\s*\**\s*DECISION\s+(\d+)/gm;
const QUESTION_TOOL = /genesis[-_]tools.*(question_post|question_update|question_answer|inbox_send)$/;
/** Shell tools of Claude (Bash), Codex (exec_command, shell, local_shell) and Grok (bash, run_terminal_cmd). */
const SHELL_TOOL = /^(bash|shell|exec_command|local_shell|run_terminal_cmd|container\.exec)$/i;
const SHELL_QUESTION = /\btools question\b/;

export interface QuestionCall {
    id: string;
    /** Epoch ms of the call, 0 when the provider records no time (Grok). */
    at: number;
}

export interface TranscriptRows {
    transcript: string;
    provider: string;
    /** The file the provider read (Grok reads its chat file), its inode, and how far the index reaches. */
    file: { path: string; ino: number } | null;
    offset: number;
    /** What this call read: `from` to `to`; equal when nothing was appended since the last call. */
    scanned: { from: number; to: number };
    /** Decision number to the key of the row that first asked it. */
    asks: { number: number; row: string }[];
    calls: QuestionCall[];
    issues: string[];
}

interface RowsIndex {
    version: number;
    transcript: string;
    provider: string;
    path: string;
    ino: number;
    offset: number;
    guard: string;
    asks: [number, string][];
    calls: QuestionCall[];
    at: number;
}

export interface TranscriptRowsDeps {
    read: (options: ReadForwardOptions & { kind: string; transcriptPath: string }) => Promise<ForwardRead>;
    indexPath: (transcript: string, provider: string) => string;
}

async function realRead(options: ReadForwardOptions & { kind: string; transcriptPath: string }): Promise<ForwardRead> {
    const { readSessionForward } = await import("@genesiscz/utils/agent-sessions/session-backward");
    return readSessionForward(options);
}

export const realTranscriptRowsDeps: TranscriptRowsDeps = {
    read: realRead,
    indexPath: (transcript, provider) =>
        toolDataDir(
            "question",
            "cache",
            "transcript-rows",
            `${createHash("sha1").update(`${provider}\0${transcript}`).digest("hex")}.json`
        ),
};

/** Each decision's first ask in these rows: the first assistant text entry that asks it without a link. */
export function firstAsksIn(rows: readonly ForwardRow[]): Map<number, string> {
    const found = new Map<number, string>();

    for (const row of rows) {
        for (const entry of row.entries) {
            if (entry.role !== "assistant" || entry.toolEvent) {
                continue;
            }

            for (const match of entry.text.matchAll(FIRST_ASK)) {
                const n = Number(match[2]);

                if (!found.has(n)) {
                    found.set(n, row.key);
                }
            }
        }
    }

    return found;
}

/**
 * Whether a shell call runs `tools question`. `inputText` is the input's values, capped per field, so a long script
 * that names it late is found in `text`, the whole input as JSON, where a line break before it is the two characters `\n`.
 */
function namesQuestionTool(inputText: string | undefined, text: string): boolean {
    return SHELL_QUESTION.test(inputText ?? "") || SHELL_QUESTION.test(text.replaceAll("\\n", "\n"));
}

/** The question tool calls in these rows: a genesis-tools question MCP tool, or a shell call of `tools question`. */
export function questionCallsIn(rows: readonly ForwardRow[]): QuestionCall[] {
    const calls: QuestionCall[] = [];

    for (const row of rows) {
        for (const entry of row.entries) {
            if (entry.toolEvent !== "call" || !entry.callId || !entry.tool) {
                continue;
            }

            const isQuestion =
                QUESTION_TOOL.test(entry.tool) ||
                (SHELL_TOOL.test(entry.tool) && namesQuestionTool(entry.inputText, entry.text));

            if (isQuestion) {
                const at = entry.timestamp ? Date.parse(entry.timestamp) : 0;
                calls.push({ id: entry.callId, at: Number.isFinite(at) ? at : 0 });
            }
        }
    }

    return calls;
}

/** The last `GUARD_BYTES` before `offset`, hex; "" at 0 or when they cannot be read. */
function guardAt(path: string, offset: number): string {
    if (offset <= 0) {
        return "";
    }

    const length = Math.min(GUARD_BYTES, offset);
    const buffer = Buffer.alloc(length);
    let fd: number | undefined;

    try {
        fd = openSync(path, "r");
        const got = readSync(fd, buffer, 0, length, offset - length);
        return got === length ? buffer.toString("hex") : "";
    } catch (error) {
        log.debug({ error, path, offset }, "transcript rows: guard bytes not read");
        return "";
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

function isIndex(value: unknown): value is RowsIndex {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === INDEX_VERSION &&
        "path" in value &&
        typeof value.path === "string" &&
        "ino" in value &&
        typeof value.ino === "number" &&
        "offset" in value &&
        typeof value.offset === "number" &&
        "guard" in value &&
        typeof value.guard === "string" &&
        "asks" in value &&
        Array.isArray(value.asks) &&
        "calls" in value &&
        Array.isArray(value.calls)
    );
}

function loadIndex(file: string, transcript: string, provider: string): RowsIndex | null {
    let raw: string;

    try {
        raw = readFileSync(file, "utf8");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            log.debug({ error, file }, "transcript rows: index not readable, scanning from 0");
        }

        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(raw, { strict: true });
        return isIndex(parsed) && parsed.transcript === transcript && parsed.provider === provider ? parsed : null;
    } catch (error) {
        log.debug({ error, file }, "transcript rows: index not parseable, scanning from 0");
        return null;
    }
}

/** Whether the indexed file is still the one the index read, at least as long, with the same bytes before the offset. */
function stillAppended(index: RowsIndex): { ok: boolean; size: number } {
    const stat = statSync(index.path, { throwIfNoEntry: false });

    if (!stat || stat.ino !== index.ino || stat.size < index.offset) {
        return { ok: false, size: stat?.size ?? -1 };
    }

    return { ok: guardAt(index.path, index.offset) === index.guard, size: stat.size };
}

function answer(index: RowsIndex, scanned: { from: number; to: number }, issues: string[]): TranscriptRows {
    return {
        transcript: index.transcript,
        provider: index.provider,
        file: { path: index.path, ino: index.ino },
        offset: index.offset,
        scanned,
        asks: index.asks.map(([number, row]) => ({ number, row })).sort((a, b) => a.number - b.number),
        calls: index.calls,
        issues,
    };
}

/**
 * The decision rows of one transcript, from the shared index plus whatever was appended since it was saved. A file
 * replaced (another inode), shortened, or rewritten before the offset is read again from 0. An unchanged file is
 * answered from the index after one `stat`; nothing is read.
 */
export async function transcriptRows({
    transcript,
    provider = "claude",
    deps = realTranscriptRowsDeps,
}: {
    transcript: string;
    provider?: string;
    deps?: TranscriptRowsDeps;
}): Promise<TranscriptRows> {
    const indexFile = deps.indexPath(transcript, provider);
    let index = loadIndex(indexFile, transcript, provider);

    if (index) {
        const check = stillAppended(index);

        if (!check.ok) {
            log.info(
                { transcript, path: index.path, offset: index.offset, size: check.size },
                "transcript rows: the file was replaced or rewritten; scanning from 0"
            );
            index = null;
        } else if (check.size === index.offset) {
            return answer(index, { from: index.offset, to: index.offset }, []);
        }
    }

    let from = index?.offset ?? 0;
    let read = await deps.read({ kind: provider, transcriptPath: transcript, fromOffset: from, contains: ROW_FILTER });

    // The file changed between the check and the read: another inode, or shorter than the offset. Read it whole.
    if (index && read.file && (read.file.ino !== index.ino || read.file.size < from)) {
        index = null;
        from = 0;
        read = await deps.read({ kind: provider, transcriptPath: transcript, fromOffset: 0, contains: ROW_FILTER });
    }

    const issues = read.issues.map((issue) => issue.message);

    if (!read.file) {
        log.warn({ transcript, provider, issues }, "transcript rows: the transcript could not be read");
        return index
            ? answer(index, { from, to: from }, issues)
            : {
                  transcript,
                  provider,
                  file: null,
                  offset: 0,
                  scanned: { from: 0, to: 0 },
                  asks: [],
                  calls: [],
                  issues,
              };
    }

    const asks = new Map<number, string>(index?.asks ?? []);

    for (const [n, row] of firstAsksIn(read.rows)) {
        if (!asks.has(n)) {
            asks.set(n, row);
        }
    }

    const known = new Set((index?.calls ?? []).map((call) => call.id));
    const calls = [...(index?.calls ?? []), ...questionCallsIn(read.rows).filter((call) => !known.has(call.id))];
    const next: RowsIndex = {
        version: INDEX_VERSION,
        transcript,
        provider,
        path: read.file.path,
        ino: read.file.ino,
        offset: read.endOffset,
        guard: guardAt(read.file.path, read.endOffset),
        asks: [...asks],
        calls,
        at: Date.now(),
    };

    try {
        atomicWriteFileSync(indexFile, SafeJSON.stringify(next, { strict: true }));
    } catch (error) {
        log.warn({ error, indexFile }, "transcript rows: index not saved; the next call reads these bytes again");
    }

    log.debug(
        { transcript, from, to: read.endOffset, rows: read.rows.length, asks: asks.size, calls: calls.length },
        "transcript rows: scanned"
    );

    return answer(next, { from, to: read.endOffset }, issues);
}
