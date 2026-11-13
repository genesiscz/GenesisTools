import { readdirSync, readFileSync, statSync } from "node:fs";
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

export type WebLogRootState = "missing" | "unreadable" | "readable";

/**
 * Whether the log folder exists and can be listed. Without Full Disk Access, macOS privacy makes an existing folder
 * unreadable, and that must not read as "no log". The folder is listed directly, never checked with `existsSync`
 * first: a parent folder that cannot be searched makes `existsSync` answer false, so a denied path read as missing.
 * Only ENOENT and ENOTDIR mean missing. Read-only.
 */
export function webLogRootState(root: string): WebLogRootState {
    try {
        readdirSync(root);
        return "readable";
    } catch (err) {
        const code = err instanceof Error && "code" in err ? err.code : undefined;

        if (code === "ENOENT" || code === "ENOTDIR") {
            return "missing";
        }

        log.debug({ err, root }, "[ms-teams] the web-client log directory cannot be listed");
        return "unreadable";
    }
}

/**
 * Every file of the Teams web-client log under the WebView file system, read one at a time. Read-only. Teams
 * rotates these files within one to two hours, so a reader sees only the recent past. A file or folder that vanished
 * or cannot be read is skipped; this never throws.
 */
export function* readWebLogFiles(root: string): Generator<WebLogFile> {
    const state = webLogRootState(root);

    if (state !== "readable") {
        log.debug({ root, state }, "[ms-teams] no readable web-client log directory");
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
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (err) {
        // A folder that rotation removed mid-read, or one macOS privacy hides, is skipped, never fatal.
        log.debug({ err, dir }, "[ms-teams] skipped a web-client log directory that cannot be listed");
        return out;
    }

    for (const name of names) {
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
