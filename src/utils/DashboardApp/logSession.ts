import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { out } from "@app/logger";
import { getLocalIpv4 } from "@app/utils/network";
import { stripAnsi } from "@app/utils/string";
import pc from "picocolors";
import { ensureLogFile } from "./pidFile";
import type { DashboardBindHost } from "./types";

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

    const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 50;
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
        return allLines.slice(-lineCount).join("\n");
    } finally {
        closeSync(fd);
    }
}

const BANNER_LINE =
    /(?:VITE v[\d.]+|➜\s+Local:|➜\s+Network:|Local:\s+https?:\/\/|Network:\s+https?:\/\/|ready in \d+)/i;

/** Print the Vite/dev-server banner from the current log session to the terminal. */
export function printDevServerBanner(
    logFile: string,
    port: number,
    opts: { color?: boolean; bindHost?: DashboardBindHost } = {}
): void {
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

    const hasNetworkLine = bannerLines.some((line) => /network:/i.test(stripAnsi(line)));
    const bindHost = opts.bindHost ?? "127.0.0.1";

    if (bannerLines.length === 0) {
        const local = bindHost === "0.0.0.0" ? `http://localhost:${port}/` : `http://127.0.0.1:${port}/`;
        out.print(
            `\n  ${color ? pc.cyan("➜") : "➜"}  ${color ? pc.bold("Local:") : "Local:"}   ${color ? pc.cyan(local) : local}\n`
        );

        if (bindHost === "0.0.0.0") {
            const network = `http://${getLocalIpv4()}:${port}/`;
            out.print(
                `  ${color ? pc.cyan("➜") : "➜"}  ${color ? pc.bold("Network:") : "Network:"} ${color ? pc.cyan(network) : network}\n`
            );
        }

        return;
    }

    const rendered = bannerLines.map((line) => (color ? line : stripAnsi(line)));

    if (bindHost === "0.0.0.0" && !hasNetworkLine) {
        const network = `http://${getLocalIpv4()}:${port}/`;
        rendered.push(
            `  ${color ? pc.cyan("➜") : "➜"}  ${color ? pc.bold("Network:") : "Network:"} ${color ? pc.cyan(network) : network}`
        );
    }

    out.print(`\n${rendered.join("\n")}\n`);
}
