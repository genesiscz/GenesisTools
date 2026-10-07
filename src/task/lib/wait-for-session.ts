import { jsonlPath } from "@app/task/lib/paths";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { readJsonlFile } from "@genesiscz/utils/log-session/jsonl-reader";
import type { JsonlRecord } from "@genesiscz/utils/log-session/types";
import { logger } from "@genesiscz/utils/logger";

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
    /** Test seam: called when a live record arrives before the snapshot finished and is held back. */
    onBuffered?: (entry: JsonlRecord) => void;
}

export async function waitForSession(opts: WaitOptions, deps: WaitDependencies = {}): Promise<WaitResult> {
    const path = jsonlPath(opts.session);
    const readExisting = deps.readExisting ?? readJsonlFile;
    let resolveResult: (result: WaitResult) => void = () => {};
    let rejectResult: (error: unknown) => void = () => {};
    const result = new Promise<WaitResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
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
                deps.onBuffered?.(entry);
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

    const fail = (error: unknown): void => {
        if (settled) {
            logger.debug({ error, session: opts.session }, "wait: snapshot read failed after the wait had settled");
            return;
        }

        settled = true;
        tailer.stop();
        if (timer) {
            clearTimeout(timer);
        }

        rejectResult(error);
    };

    // The snapshot loads beside the deadline, not in front of it: a stalled read must not hold
    // the caller past timeoutMs, and nothing is scanned once the wait has settled.
    const loadSnapshot = async (): Promise<void> => {
        const existing = await readExisting(path);

        for (const entry of [...existing, ...buffered]) {
            if (settled) {
                return;
            }

            const terminal = inspect(entry);
            if (terminal) {
                settle(terminal);
                return;
            }
        }

        snapshotComplete = true;
    };

    tailer.start();
    loadSnapshot().catch(fail);

    return result;
}
