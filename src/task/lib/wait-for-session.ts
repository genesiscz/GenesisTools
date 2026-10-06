import { jsonlPath } from "@app/task/lib/paths";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { readJsonlFile } from "@genesiscz/utils/log-session/jsonl-reader";
import type { JsonlRecord } from "@genesiscz/utils/log-session/types";

export interface WaitOptions {
    session: string;
    exitOnMatch?: RegExp;
    timeoutMs?: number;
    waitForExit?: boolean;
}

export interface WaitResult {
    reason: "match" | "session-exit" | "timeout";
    matchedLine?: string;
    sessionExitCode?: number;
}

export interface WaitDependencies {
    readExisting?: (path: string) => Promise<JsonlRecord[]>;
}

export async function waitForSession(opts: WaitOptions, deps: WaitDependencies = {}): Promise<WaitResult> {
    const path = jsonlPath(opts.session);
    const readExisting = deps.readExisting ?? readJsonlFile;
    let resolveResult: (result: WaitResult) => void = () => {};
    const result = new Promise<WaitResult>((resolve) => {
        resolveResult = resolve;
    });
    let settled = false;
    let snapshotComplete = false;
    const buffered: JsonlRecord[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const inspect = (entry: JsonlRecord): WaitResult | null => {
        if (opts.exitOnMatch && entry.type === "line" && "text" in entry && typeof entry.text === "string") {
            if (opts.exitOnMatch.test(entry.text)) {
                return { reason: "match", matchedLine: entry.text };
            }
        }

        if (opts.waitForExit && entry.type === "exit" && "code" in entry && typeof entry.code === "number") {
            return { reason: "session-exit", sessionExitCode: entry.code };
        }

        return null;
    };

    const tailer = new FileTailer<JsonlRecord>(path, {
        onLine: (entry) => {
            if (!snapshotComplete) {
                buffered.push(entry);
                return;
            }

            const terminal = inspect(entry);
            if (terminal) {
                settle(terminal);
            }
        },
    });

    const settle = (terminal: WaitResult): void => {
        if (settled) {
            return;
        }

        settled = true;
        tailer.stop();
        if (timer) {
            clearTimeout(timer);
        }

        resolveResult(terminal);
    };

    if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => settle({ reason: "timeout" }), opts.timeoutMs);
    }

    tailer.start();
    let existing: JsonlRecord[];
    try {
        existing = await readExisting(path);
    } catch (error) {
        tailer.stop();
        if (timer) {
            clearTimeout(timer);
        }

        throw error;
    }

    for (const entry of existing) {
        const terminal = inspect(entry);
        if (terminal) {
            settle(terminal);
            return result;
        }
    }

    snapshotComplete = true;
    for (const entry of buffered) {
        const terminal = inspect(entry);
        if (terminal) {
            settle(terminal);
            break;
        }
    }

    return result;
}
