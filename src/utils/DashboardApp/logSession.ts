import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { stripAnsi } from "@app/utils/string";
import pc from "picocolors";
import { ensureLogFile } from "./pidFile";

export const LOG_SESSION_MARKER = "--- DashboardApp session ";

export function resetLogFile(key: string): string {
    const file = ensureLogFile(key);
    const marker = `${LOG_SESSION_MARKER}${new Date().toISOString()} ---\n`;
    writeFileSync(file, marker);
    return file;
}

/** Byte offset of the most recent session marker, or 0 when none. */
export function currentLogSessionOffset(logFile: string): number {
    if (!existsSync(logFile)) {
        return 0;
    }

    const content = readFileSync(logFile, "utf-8");
    const markerIndex = content.lastIndexOf(LOG_SESSION_MARKER);

    if (markerIndex < 0) {
        return 0;
    }

    return markerIndex;
}

export function readLogTail(logFile: string, lines: number, sessionOnly = true): string {
    if (!existsSync(logFile)) {
        return "";
    }

    const start = sessionOnly ? currentLogSessionOffset(logFile) : 0;
    const size = statSync(logFile).size;

    if (size <= start) {
        return "";
    }

    const fd = openSync(logFile, "r");
    try {
        const buf = Buffer.alloc(size - start);
        const read = readSync(fd, buf, 0, buf.length, start);
        const text = buf.subarray(0, read).toString();
        const allLines = text.split("\n");
        return allLines.slice(-lines).join("\n");
    } finally {
        closeSync(fd);
    }
}

const BANNER_LINE =
    /(?:VITE v[\d.]+|➜\s+Local:|➜\s+Network:|Local:\s+https?:\/\/|Network:\s+https?:\/\/|ready in \d+)/i;

/** Print the Vite/dev-server banner from the current log session to the terminal. */
export function printDevServerBanner(logFile: string, port: number, opts: { color?: boolean } = {}): void {
    const color = opts.color ?? Boolean(process.stdout.isTTY);
    const tail = readLogTail(logFile, 40, true);
    const bannerLines: string[] = [];

    for (const line of tail.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        if (BANNER_LINE.test(stripAnsi(trimmed))) {
            bannerLines.push(trimmed);
        }
    }

    if (bannerLines.length === 0) {
        const local = `http://localhost:${port}/`;
        process.stdout.write(
            `\n  ${color ? pc.cyan("➜") : "➜"}  ${color ? pc.bold("Local:") : "Local:"}   ${color ? pc.cyan(local) : local}\n`
        );
        return;
    }

    const rendered = bannerLines.map((line) => (color ? line : stripAnsi(line)));
    process.stdout.write(`\n${rendered.join("\n")}\n`);
}
