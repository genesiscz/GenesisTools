import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("meetings");

/**
 * The append-only line files of a meeting (the decision journal, the answer log, the comments): one JSON value per
 * line. A writer that dies mid-line (a crash, a full disk) leaves a torn last line with no line end. The readers pass
 * over it, and the next append starts on a line of its own: glued onto the torn bytes, the newest line would be the
 * one that no longer reads.
 */

/** Appends whole lines in one write; after a torn last line, on a line of their own. */
export function appendLines(path: string, lines: string[], options: { mode?: number } = {}): void {
    if (lines.length === 0) {
        return;
    }

    mkdirSync(dirname(path), { recursive: true });
    const text = lines.map((line) => `${line}\n`).join("");
    appendFileSync(path, endsTorn(path) ? `\n${text}` : text, options.mode === undefined ? {} : { mode: options.mode });
}

/** The file's last byte is not a line end: the next line must start on a line of its own. */
export function endsTorn(path: string): boolean {
    if (!existsSync(path)) {
        return false;
    }

    const size = statSync(path).size;

    if (size === 0) {
        return false;
    }

    const fd = openSync(path, "r");

    try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        return last[0] !== 10;
    } finally {
        closeSync(fd);
    }
}

/** One line's value, or nothing for a blank line or one that is not JSON (a torn line, a hand edit). */
export function parseJsonLine(line: string, path: string): unknown {
    if (!line.trim()) {
        return undefined;
    }

    try {
        return SafeJSON.parse(line, { jsonl: true });
    } catch (error) {
        log.warn({ path, error }, "a meeting line file has a line that is not JSON; skipped");
        return undefined;
    }
}
