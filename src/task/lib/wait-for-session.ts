import { jsonlPath } from "@app/task/lib/paths";
import { FileTailer } from "@app/utils/fs/file-tailer";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord, JsonlLineRecord, JsonlRecord } from "@app/utils/log-session/types";

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

export async function waitForSession(opts: WaitOptions): Promise<WaitResult> {
    const path = jsonlPath(opts.session);

    const existing = await readJsonlFile(path);
    if (opts.exitOnMatch) {
        for (const rec of filterLineRecords(existing)) {
            if (opts.exitOnMatch.test(rec.text)) {
                return { reason: "match", matchedLine: rec.text };
            }
        }
    }

    if (opts.waitForExit) {
        const exit = existing.find((r): r is JsonlExitRecord => r.type === "exit");
        if (exit) {
            return { reason: "session-exit", sessionExitCode: exit.code };
        }
    }

    return new Promise<WaitResult>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const settle = (result: WaitResult): void => {
            if (settled) {
                return;
            }

            settled = true;
            tailer.stop();

            if (timer) {
                clearTimeout(timer);
            }

            resolve(result);
        };

        const tailer = new FileTailer<JsonlRecord>(path, {
            onLine: (entry) => {
                if (opts.exitOnMatch && entry.type === "line") {
                    const line = entry as JsonlLineRecord;
                    if (opts.exitOnMatch.test(line.text)) {
                        settle({ reason: "match", matchedLine: line.text });

                        return;
                    }
                }

                if (opts.waitForExit && entry.type === "exit") {
                    const exit = entry as JsonlExitRecord;
                    settle({ reason: "session-exit", sessionExitCode: exit.code });
                }
            },
        });

        if (opts.timeoutMs !== undefined) {
            timer = setTimeout(() => {
                settle({ reason: "timeout" });
            }, opts.timeoutMs);
        }

        tailer.start();
    });
}
