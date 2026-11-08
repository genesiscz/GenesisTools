import { closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { out } from "@genesiscz/utils/logger";
import { getLocalIpv4 } from "@genesiscz/utils/network";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import { LOG_SESSION_MARKER } from "./log-cap";
import { ensureLogFile } from "./pidFile";
import type { DashboardBindHost } from "./types";

export { LOG_SESSION_MARKER };

/** The most a tail reader loads: the session marker and the requested lines are looked for in the last 2 MiB. */
export const LOG_TAIL_WINDOW_BYTES = 2 * 1024 * 1024;

export function resetLogFile(key: string): string {
    const file = ensureLogFile(key);
    const marker = `${LOG_SESSION_MARKER}${new Date().toISOString()} ---\n`;
    writeFileSync(file, marker);
    return file;
}

/**
 * The last `lines` lines of the log, read from its last 2 MiB only (a runaway log can be gigabytes). With
 * `sessionOnly`, the text starts at the last session marker in that window.
 */
export function readLogTail(logFile: string, lines: number, sessionOnly = true): string {
    if (!existsSync(logFile)) {
        return "";
    }

    const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 50;
    const fd = openSync(logFile, "r");
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - LOG_TAIL_WINDOW_BYTES);
        const buf = Buffer.alloc(size - start);
        let window = buf.subarray(0, readSync(fd, buf, 0, buf.length, start));
        const marker = sessionOnly ? window.lastIndexOf(LOG_SESSION_MARKER) : -1;

        if (marker >= 0) {
            window = window.subarray(marker);
        } else if (start > 0) {
            window = window.subarray(window.indexOf("\n") + 1);
        }

        return window.toString().split("\n").slice(-lineCount).join("\n");
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
