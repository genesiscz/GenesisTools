/**
 * Moving a Claude session into Code Mode. Claude Code pins a session's mode when the session starts: a
 * `{"type":"repl-mode","replMode":true}` row marks a Code Mode session, and a session without one resumes with the
 * ordinary tools even when CLAUDE_CODE_EXPERIMENTAL_CODE_MODE is 1. Its own `--fork-session` keeps that pin: on
 * 2.1.328 (2026-11-23) the fork printed "Code Mode is on, but this session isn't using it". The same session with the
 * row added resumed in Code Mode, its next answer ran through REPL, and Claude Code then wrote its own `repl-mode`
 * rows. The binary's resume plan reads the pin as `replMode ?? <guess from the messages> ?? false`.
 *
 * The session keeps its id and gets the row; a copy under a new id keeps the conversation without Code Mode. Links,
 * cmux layouts and notes that name the id then reach the Code Mode session, and its sub-agents and file checkpoints
 * stay with it.
 */
import { once } from "node:events";
import { createWriteStream, renameSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { scanFileMatches } from "@genesiscz/utils/ai/transcripts/file-scan";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { appendClaudeRows, claudeRenameRows } from "./claude-title";

const { log } = logger.scoped("claude-fork");

/** Where a Code Mode pin row starts: Claude writes `type` as its first key. */
const REPL_MODE_ROW = '"type":"repl-mode"';

/** Bytes kept after each pin row's start; the row is about 100 bytes. */
const PIN_WINDOW = 512;

/** The session's newest Code Mode pin: its last `repl-mode` row, or null when it has none (an ordinary session). */
export function claudeCodeModePin(path: string): boolean | null {
    let pin: boolean | null = null;
    scanFileMatches(path, REPL_MODE_ROW, PIN_WINDOW, (slice) => {
        const text = slice.toString("utf8");
        const end = text.indexOf("\n");

        try {
            const row: unknown = SafeJSON.parse(`{${end === -1 ? text : text.slice(0, end)}`, { strict: true });

            if (isJsonObject(row) && typeof row.replMode === "boolean") {
                pin = row.replMode;
            }
        } catch (error) {
            log.debug({ error, path }, "a repl-mode row that does not parse inside the window");
        }
    });

    return pin;
}

export interface SessionCopyIds {
    sourceId: string;
    copyId: string;
}

/** What one pass over the source saw. */
export interface SessionCopyScan {
    rows: number;
    /** The source's `repl-mode` rows: the copy is an ordinary session. */
    droppedPins: number;
    /** The source's `/rename` rows (`custom-title`, `agent-name`): the copy gets one name of its own. */
    droppedTitles: number;
    /** Lines that are not JSON, copied as they are. */
    unreadableRows: number;
    /** The first working folder a row names: where `claude --resume` must run. */
    cwd: string | null;
}

export function emptyCopyScan(): SessionCopyScan {
    return { rows: 0, droppedPins: 0, droppedTitles: 0, unreadableRows: 0, cwd: null };
}

/**
 * One source line as the copy writes it, or null when the copy drops it. A row of the source session gets the copy's
 * id, as Claude Code's own fork writes it; a row of another session keeps its id.
 */
export function sessionCopyLine(line: string, ids: SessionCopyIds, scan: SessionCopyScan): string | null {
    if (line.trim() === "") {
        return null;
    }

    let row: unknown;

    try {
        row = SafeJSON.parse(line, { jsonl: true });
    } catch (error) {
        log.debug({ error, length: line.length }, "a transcript line that is not JSON is copied as it is");
        scan.unreadableRows++;
        scan.rows++;
        return line;
    }

    if (!isJsonObject(row)) {
        scan.rows++;
        return line;
    }

    if (row.type === "repl-mode") {
        scan.droppedPins++;
        return null;
    }

    if (row.type === "custom-title" || row.type === "agent-name") {
        scan.droppedTitles++;
        return null;
    }

    if (scan.cwd === null && typeof row.cwd === "string" && row.cwd !== "") {
        scan.cwd = row.cwd;
    }

    scan.rows++;

    if (row.sessionId !== ids.sourceId) {
        return line;
    }

    return SafeJSON.stringify({ ...row, sessionId: ids.copyId }, { strict: true });
}

/** The rows the copy ends with: where it came from (as Claude Code's fork writes it), and its name. */
export function sessionCopyTail(ids: SessionCopyIds, title: string): string[] {
    const derivedFrom = {
        type: "derived-from",
        v: 1,
        sessionId: ids.copyId,
        sessions: [{ type: "claude_code_session", id: ids.sourceId, via: "fork" }],
    };
    return [SafeJSON.stringify(derivedFrom, { strict: true }), ...claudeRenameRows(ids.copyId, title)];
}

export interface SessionCopyWrite extends SessionCopyIds {
    sourcePath: string;
    copyPath: string;
    title: string;
}

/**
 * Writes the copy beside a temporary name and renames it into place, so a crash never leaves a half transcript that
 * Claude Code would list as a session. Streams the source: a 200 MB transcript is never one string. Lines end at
 * "\n" only: `node:readline` also ends them at U+2028 and U+2029, and on 2026-11-23 it cut 5 rows of an 860 MB
 * transcript into 37 pieces that the copy wrote as broken lines.
 */
export async function writeSessionCopy(input: SessionCopyWrite): Promise<SessionCopyScan> {
    const scan = emptyCopyScan();
    const temporary = `${input.copyPath}.${process.pid}.tmp`;
    const output = createWriteStream(temporary, { mode: 0o600 });
    const lines = readLines(input.sourcePath);

    const write = async (text: string) => {
        if (!output.write(`${text}\n`)) {
            await once(output, "drain");
        }
    };

    for await (const line of lines) {
        const copied = sessionCopyLine(line, input, scan);

        if (copied !== null) {
            await write(copied);
        }
    }

    for (const row of sessionCopyTail(input, input.title)) {
        await write(row);
    }

    output.end();
    await once(output, "finish");
    renameSync(temporary, input.copyPath);
    log.info({ sourceId: input.sourceId, copyId: input.copyId, ...scan }, "wrote a copy of a Claude session");
    return scan;
}

/** Marks a session as a Code Mode session: its next resume with Code Mode on runs in Code Mode. */
export function appendClaudeCodeModePin(path: string, sessionId: string): void {
    appendClaudeRows(path, [SafeJSON.stringify({ type: "repl-mode", replMode: true, sessionId }, { strict: true })]);
    log.info({ sessionId, path }, "marked a Claude session as a Code Mode session");
}

export type PairCheckStatus = "ok" | "fail" | "warn" | "info";

export interface PairCheck {
    name: string;
    status: PairCheckStatus;
    detail: string;
}

interface AfterFork {
    rows: number;
    repl: number;
    otherTools: number;
    apiErrors: number;
    notCodeMode: number;
}

const NOT_CODE_MODE = /isn't using it|can't be resumed|Code Mode is off/;

function parsedRow(line: string): Record<string, unknown> | null {
    try {
        const row: unknown = SafeJSON.parse(line, { jsonl: true });
        return isJsonObject(row) ? row : null;
    } catch (error) {
        log.debug({ error, length: line.length }, "a transcript line that is not JSON");
        return null;
    }
}

function countAfterFork(row: Record<string, unknown>, into: AfterFork): void {
    into.rows++;

    if (row.isApiErrorMessage === true) {
        into.apiErrors++;
    }

    const message = isJsonObject(row.message) ? row.message : null;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const texts = [row.content, ...blocks.map((block) => (isJsonObject(block) ? block.text : undefined))];

    if (texts.some((text) => typeof text === "string" && NOT_CODE_MODE.test(text))) {
        into.notCodeMode++;
    }

    for (const block of blocks) {
        if (isJsonObject(block) && block.type === "tool_use") {
            if (block.name === "REPL") {
                into.repl++;
            } else {
                into.otherTools++;
            }
        }
    }
}

/** The fork's own `derived-from` row: the copy names the session it was made from. */
function isCopyTail(row: Record<string, unknown>, ids: SessionCopyIds): boolean {
    return (
        row.type === "derived-from" &&
        row.sessionId === ids.copyId &&
        Array.isArray(row.sessions) &&
        row.sessions.some((entry) => isJsonObject(entry) && entry.id === ids.sourceId && entry.via === "fork")
    );
}

/** The session a copy was made from, from the copy's own `derived-from` row; null when it names none. */
export async function copySourceOf(copyPath: string, copyId: string): Promise<string | null> {
    let source: string | null = null;
    const lines = readLines(copyPath);

    for await (const line of lines) {
        if (!line.startsWith('{"type":"derived-from"')) {
            continue;
        }

        const row = parsedRow(line);
        const sessions = row && row.sessionId === copyId && Array.isArray(row.sessions) ? row.sessions : [];
        const fork = sessions.find((entry) => isJsonObject(entry) && entry.via === "fork");

        if (isJsonObject(fork) && typeof fork.id === "string") {
            source = fork.id;
        }
    }

    return source;
}

function lastName(names: { title: string | null; agent: string | null }, row: Record<string, unknown>): void {
    if (row.type === "custom-title" && typeof row.customTitle === "string") {
        names.title = row.customTitle;
    }

    if (row.type === "agent-name" && typeof row.agentName === "string") {
        names.agent = row.agentName;
    }
}

/**
 * Checks a session moved into Code Mode against its copy, streaming both: the copy's rows up to its own `derived-from`
 * row must equal the session's rows in order (ids mapped, name and pin rows aside), the session's newest pin must be
 * Code Mode and the copy's must not, both names must match their titles, and the turns after the move must use REPL
 * in the session and never in the copy. Reads only.
 */
export async function checkCodeModePair(input: {
    ids: SessionCopyIds;
    sessionPath: string;
    copyPath: string;
    suffix: string;
}): Promise<PairCheck[]> {
    const { ids } = input;
    const sessionLines = readLines(input.sessionPath);
    const sessionNames = { title: null as string | null, agent: null as string | null };
    const copyNames = { title: null as string | null, agent: null as string | null };
    let sessionPin: boolean | null = null;
    let copyPin: boolean | null = null;
    let sessionLine = 0;
    // The move appends a Code Mode pin to a session whose newest pin was not one, so its rows after the move start at
    // the first pin of the session's last run of Code Mode pins. Counting from there works also when the rows before
    // it do not line up with the copy.
    const emptyAfter = (): AfterFork => ({ rows: 0, repl: 0, otherTools: 0, apiErrors: 0, notCodeMode: 0 });
    let sessionAfter: AfterFork | null = null;

    /** The session's next row that the copy also has (its name and pin rows are not copied). */
    const nextSessionRow = async (): Promise<{
        line: number;
        raw: string;
        row: Record<string, unknown> | null;
    } | null> => {
        while (true) {
            const next = await sessionLines.next();

            if (next.done) {
                return null;
            }

            sessionLine++;

            if (next.value.trim() === "") {
                continue;
            }

            const row = parsedRow(next.value);

            if (row?.type === "repl-mode") {
                sessionPin = row.replMode === true;

                if (!sessionPin) {
                    sessionAfter = null;
                } else if (sessionAfter === null) {
                    sessionAfter = emptyAfter();
                }

                continue;
            }

            if (row?.type === "custom-title" || row?.type === "agent-name") {
                lastName(sessionNames, row);
                continue;
            }

            if (row && sessionAfter !== null) {
                countAfterFork(row, sessionAfter);
            }

            return { line: sessionLine, raw: next.value, row };
        }
    };

    let compared = 0;
    let mismatch: string | null = null;
    let tailLine: number | null = null;
    const copyAfter: AfterFork = { rows: 0, repl: 0, otherTools: 0, apiErrors: 0, notCodeMode: 0 };
    let copyLine = 0;
    const copyLines = readLines(input.copyPath);

    for await (const raw of copyLines) {
        copyLine++;

        if (raw.trim() === "") {
            continue;
        }

        const row = parsedRow(raw);

        if (row?.type === "repl-mode") {
            copyPin = row.replMode === true;
            continue;
        }

        if (row?.type === "custom-title" || row?.type === "agent-name") {
            lastName(copyNames, row);
            continue;
        }

        if (tailLine === null && row && isCopyTail(row, ids)) {
            tailLine = copyLine;
            continue;
        }

        if (tailLine !== null) {
            if (row) {
                countAfterFork(row, copyAfter);
            }

            continue;
        }

        if (mismatch !== null) {
            continue;
        }

        const original = await nextSessionRow();

        if (!original) {
            mismatch = `the session ends before copy line ${copyLine}`;
            continue;
        }

        const expected =
            original.row && original.row.sessionId === ids.sourceId
                ? { ...original.row, sessionId: ids.copyId }
                : original.row;
        const same = row && expected ? isDeepStrictEqual(row, expected) : raw === original.raw;

        if (!same) {
            mismatch = `copy line ${copyLine} differs from session line ${original.line}`;
            continue;
        }

        compared++;
    }

    while ((await nextSessionRow()) !== null) {
        // Drains the session: nextSessionRow counts its rows after the move.
    }

    const after: AfterFork = sessionAfter ?? emptyAfter();

    const short = (id: string) => id.slice(0, 8);
    const turns = (after: AfterFork) =>
        `${after.rows} rows, ${after.repl} REPL scripts, ${after.otherTools} other tool calls, ${after.apiErrors} API errors`;
    const named = (names: { title: string | null; agent: string | null }) =>
        `list title "${names.title ?? "none"}", prompt name "${names.agent ?? "none"}"`;

    const sessionMode: PairCheck =
        after.notCodeMode > 0 || (after.otherTools > 0 && after.repl === 0)
            ? { name: "session runs in Code Mode", status: "fail", detail: turns(after) }
            : after.repl > 0
              ? { name: "session runs in Code Mode", status: "ok", detail: turns(after) }
              : {
                    name: "session runs in Code Mode",
                    status: "info",
                    detail: `no tool call yet (${turns(after)})`,
                };

    return [
        tailLine === null
            ? { name: "copy names the session", status: "fail", detail: `no derived-from row naming ${ids.sourceId}` }
            : {
                  name: "copy names the session",
                  status: "ok",
                  detail: `${short(ids.copyId)} came from ${short(ids.sourceId)} (copy line ${tailLine})`,
              },
        mismatch === null && tailLine !== null
            ? {
                  name: "conversation copied whole",
                  status: "ok",
                  detail: `${compared} rows match row by row, ids mapped`,
              }
            : { name: "conversation copied whole", status: "fail", detail: mismatch ?? `${compared} rows compared` },
        {
            name: "session has the Code Mode marker",
            status: sessionPin === true ? "ok" : "fail",
            detail: `newest repl-mode row: ${sessionPin ?? "none"}`,
        },
        {
            name: "copy has no Code Mode marker",
            status: copyPin === true ? "fail" : "ok",
            detail: `newest repl-mode row: ${copyPin ?? "none"}`,
        },
        {
            name: "session name",
            status:
                sessionNames.title !== null &&
                sessionNames.title === sessionNames.agent &&
                !sessionNames.title.endsWith(input.suffix)
                    ? "ok"
                    : "warn",
            detail: named(sessionNames),
        },
        {
            name: "copy name",
            status: copyNames.title?.endsWith(input.suffix) && copyNames.agent?.endsWith(input.suffix) ? "ok" : "fail",
            detail: named(copyNames),
        },
        sessionMode,
        copyAfter.repl > 0
            ? { name: "copy runs without Code Mode", status: "fail", detail: turns(copyAfter) }
            : {
                  name: "copy runs without Code Mode",
                  status: copyAfter.rows > 0 ? "ok" : "info",
                  detail: copyAfter.rows > 0 ? turns(copyAfter) : "not resumed yet",
              },
        {
            name: "API errors after the move",
            status: after.apiErrors + copyAfter.apiErrors > 0 ? "warn" : "ok",
            detail: `session ${after.apiErrors}, copy ${copyAfter.apiErrors}`,
        },
    ];
}
