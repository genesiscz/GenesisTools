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
import { createReadStream, createWriteStream, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { scanFileMatches } from "@genesiscz/utils/ai/transcripts/file-scan";
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
 * Claude Code would list as a session. Streams the source: a 200 MB transcript is never one string.
 */
export async function writeSessionCopy(input: SessionCopyWrite): Promise<SessionCopyScan> {
    const scan = emptyCopyScan();
    const temporary = `${input.copyPath}.${process.pid}.tmp`;
    const output = createWriteStream(temporary, { mode: 0o600 });
    const lines = createInterface({ input: createReadStream(input.sourcePath), crlfDelay: Number.POSITIVE_INFINITY });

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
