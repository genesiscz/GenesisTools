/**
 * A copy of a Claude session that resumes in Code Mode. Claude Code pins a session's mode when the session starts: a
 * `{"type":"repl-mode","replMode":true}` row marks a Code Mode session, and a session without one resumes with the
 * ordinary tools even when CLAUDE_CODE_EXPERIMENTAL_CODE_MODE is 1. Its own `--fork-session` keeps that pin: on
 * 2.1.328 (2026-11-23) the fork printed "Code Mode is on, but this session isn't using it". The same fork with the
 * row added resumed in Code Mode, its next answer ran through REPL, and Claude Code then wrote its own `repl-mode`
 * rows. The binary's resume plan reads the pin as `replMode ?? <guess from the messages> ?? false`.
 */
import { once } from "node:events";
import { createReadStream, createWriteStream, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { scanFileMatches } from "@genesiscz/utils/ai/transcripts/file-scan";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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

export interface CodeModeForkIds {
    sourceId: string;
    forkId: string;
}

/** What one pass over the source saw. */
export interface CodeModeForkScan {
    rows: number;
    /** The source's own `repl-mode` rows: the fork gets one pin of its own. */
    droppedPins: number;
    /** The source's `/rename` rows: the fork gets one title of its own. */
    droppedTitles: number;
    /** Lines that are not JSON, copied as they are. */
    unreadableRows: number;
    /** The first working folder a row names: where `claude --resume` must run. */
    cwd: string | null;
}

export function emptyForkScan(): CodeModeForkScan {
    return { rows: 0, droppedPins: 0, droppedTitles: 0, unreadableRows: 0, cwd: null };
}

/**
 * One source line as the fork writes it, or null when the fork drops it. A row of the source session gets the fork's
 * id, as Claude Code's own fork writes it; a row of another session keeps its id.
 */
export function codeModeForkLine(line: string, ids: CodeModeForkIds, scan: CodeModeForkScan): string | null {
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

    if (row.type === "custom-title") {
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

    return SafeJSON.stringify({ ...row, sessionId: ids.forkId }, { strict: true });
}

/** The rows the fork ends with: where it came from (as Claude Code's fork writes it), the Code Mode pin, its title. */
export function codeModeForkTail(ids: CodeModeForkIds, title: string): string[] {
    const rows = [
        {
            type: "derived-from",
            v: 1,
            sessionId: ids.forkId,
            sessions: [{ type: "claude_code_session", id: ids.sourceId, via: "fork" }],
        },
        { type: "repl-mode", replMode: true, sessionId: ids.forkId },
        { type: "custom-title", customTitle: title, sessionId: ids.forkId },
    ];
    return rows.map((row) => SafeJSON.stringify(row, { strict: true }));
}

export interface CodeModeForkWrite extends CodeModeForkIds {
    sourcePath: string;
    forkPath: string;
    title: string;
}

/**
 * Writes the fork beside a temporary name and renames it into place, so a crash never leaves a half transcript that
 * Claude Code would list as a session. Streams the source: a 200 MB transcript is never one string.
 */
export async function writeCodeModeFork(input: CodeModeForkWrite): Promise<CodeModeForkScan> {
    const scan = emptyForkScan();
    const temporary = `${input.forkPath}.${process.pid}.tmp`;
    const output = createWriteStream(temporary, { mode: 0o600 });
    const lines = createInterface({ input: createReadStream(input.sourcePath), crlfDelay: Number.POSITIVE_INFINITY });

    const write = async (text: string) => {
        if (!output.write(`${text}\n`)) {
            await once(output, "drain");
        }
    };

    for await (const line of lines) {
        const copied = codeModeForkLine(line, input, scan);

        if (copied !== null) {
            await write(copied);
        }
    }

    for (const row of codeModeForkTail(input, input.title)) {
        await write(row);
    }

    output.end();
    await once(output, "finish");
    renameSync(temporary, input.forkPath);
    log.info({ sourceId: input.sourceId, forkId: input.forkId, ...scan }, "wrote a Code Mode fork of a Claude session");
    return scan;
}
