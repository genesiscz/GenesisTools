import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { asRecord } from "./ingest-parse";

const log = logger.scoped("ms-teams").log;

export interface WebLogLine {
    message: string;
    at: number;
}

export interface WebLogFile {
    path: string;
    text: string;
}

/**
 * Every file of the Teams web-client log under the WebView file system, read one at a time. Read-only. Teams
 * rotates these files within one to two hours, so a reader sees only the recent past. A file that vanished or
 * cannot be read is skipped.
 */
export function* readWebLogFiles(root: string): Generator<WebLogFile> {
    if (!existsSync(root)) {
        log.debug({ root }, "[ms-teams] no web-client log directory");
        return;
    }

    for (const path of listWebLogFiles(root)) {
        try {
            yield { path, text: readFileSync(path, "utf8") };
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skipped an unreadable web-client log file");
        }
    }
}

/** Parse one log file body (`{"logsArray":[{message,timeStamp}]}`). Throws when Teams is still writing it. */
export function parseWebLogFile(text: string): WebLogLine[] {
    const root = asRecord(SafeJSON.parse(text, { strict: true }));
    const raw = Array.isArray(root?.logsArray) ? root.logsArray : [];
    const lines: WebLogLine[] = [];

    for (const entry of raw) {
        const line = asRecord(entry);
        const message = typeof line?.message === "string" ? line.message : null;
        const at = typeof line?.timeStamp === "string" ? Date.parse(line.timeStamp) : Number.NaN;

        if (!message || Number.isNaN(at)) {
            continue;
        }

        lines.push({ message, at });
    }

    return lines;
}

function listWebLogFiles(dir: string): string[] {
    const out: string[] = [];

    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let isDir: boolean;

        try {
            isDir = statSync(path).isDirectory();
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skipped a web-client log entry that vanished");
            continue;
        }

        if (isDir) {
            out.push(...listWebLogFiles(path));
        } else if (!name.startsWith(".") && name !== "LOG" && !name.endsWith(".ldb") && !name.endsWith(".log")) {
            out.push(path);
        }
    }

    return out;
}
