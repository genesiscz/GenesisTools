import { out } from "@app/logger";
import { printTailStatus } from "@app/task/lib/log-hints";
import { queryLogs, sliceLogLines } from "@app/task/lib/log-query";
import { jsonlPath } from "@app/task/lib/paths";
import type { LogQueryOpts } from "@app/task/types";
import { FileTailer } from "@app/utils/fs/file-tailer";
import { SafeJSON } from "@app/utils/json";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord, JsonlLineRecord, JsonlRecord } from "@app/utils/log-session/types";

function matchesFilters(
    line: JsonlLineRecord,
    opts: LogQueryOpts,
    seenSeq: Set<number>,
    grepRe: RegExp | null
): boolean {
    if (line.type !== "line") {
        return false;
    }

    if (seenSeq.has(line.seq)) {
        return false;
    }

    if (!opts.streams.has(line.out)) {
        return false;
    }

    if (opts.fromSeq !== undefined && line.seq < opts.fromSeq) {
        return false;
    }

    if (opts.toSeq !== undefined && line.seq > opts.toSeq) {
        return false;
    }

    if (grepRe && !grepRe.test(line.text)) {
        return false;
    }

    return true;
}

function compileGrep(pattern: string | undefined): RegExp | null {
    if (!pattern) {
        return null;
    }

    try {
        return new RegExp(pattern, "i");
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`invalid --grep pattern: ${detail}`);
    }
}

function emitLine(line: JsonlLineRecord, format: LogQueryOpts["format"]): void {
    if (format === "jsonl") {
        out.print(`${SafeJSON.stringify(line, { jsonl: true })}\n`);
        return;
    }

    if (format === "raw") {
        out.print(`${line.text}\n`);
        return;
    }

    out.print(`=== [${line.out}] seq ${line.seq} ===\n${line.text}\n`);
}

function findExitRecord(records: JsonlRecord[]): JsonlExitRecord | undefined {
    return records.find(
        (record): record is JsonlExitRecord =>
            record.type === "exit" && typeof (record as JsonlExitRecord).code === "number"
    );
}

function filterExistingLines(records: JsonlLineRecord[], opts: LogQueryOpts, grepRe: RegExp | null): JsonlLineRecord[] {
    const seenSeq = new Set<number>();
    const matched: JsonlLineRecord[] = [];

    for (const line of records) {
        if (matchesFilters(line, opts, seenSeq, grepRe)) {
            seenSeq.add(line.seq);
            matched.push(line);
        }
    }

    if (opts.fromSeq !== undefined || opts.toSeq !== undefined) {
        return matched;
    }

    return sliceLogLines(matched, opts).lines;
}

export async function tailSession(
    opts: LogQueryOpts & { follow: true },
    tailOpts?: { propagateExit?: boolean }
): Promise<number | undefined> {
    const path = jsonlPath(opts.session);
    const seenSeq = new Set<number>();
    const grepRe = compileGrep(opts.grep);

    const records = await readJsonlFile(path);
    const existingExit = findExitRecord(records);
    const existing = filterLineRecords(records);
    const initial = filterExistingLines(existing, opts, grepRe);

    for (const line of initial) {
        emitLine(line, opts.format);
    }

    if (existingExit) {
        out.printlnErr(`Session exited (code ${existingExit.code}).`);
        return tailOpts?.propagateExit ? existingExit.code : undefined;
    }

    printTailStatus(opts.session);

    let resolveFollow: ((code?: number) => void) | undefined;
    let onSigint: (() => void) | undefined;

    const tailer = new FileTailer<JsonlRecord>(path, {
        onLine: (entry) => {
            if (entry.type === "exit") {
                const exit = entry as JsonlExitRecord;
                tailer.stop();

                if (onSigint) {
                    process.off("SIGINT", onSigint);
                }

                out.printlnErr(`\nSession exited (code ${exit.code}).`);
                resolveFollow?.(exit.code);
                return;
            }

            if (entry.type !== "line") {
                return;
            }

            const line = entry as JsonlLineRecord;
            if (matchesFilters(line, opts, seenSeq, grepRe)) {
                seenSeq.add(line.seq);
                emitLine(line, opts.format);
            }
        },
    });

    tailer.start();

    return new Promise<number | undefined>((resolve) => {
        resolveFollow = (code?: number) => {
            resolve(code);
        };

        onSigint = (): void => {
            if (onSigint) {
                process.off("SIGINT", onSigint);
            }

            tailer.stop();
            out.printlnErr("\nStopped tailing.");
            resolve(undefined);
        };

        process.on("SIGINT", onSigint);
    });
}

export async function tailOrQuery(
    opts: LogQueryOpts,
    follow: boolean,
    tailOpts?: { propagateExit?: boolean }
): Promise<number | undefined> {
    if (follow) {
        return tailSession({ ...opts, follow: true }, tailOpts);
    }

    await queryLogs(opts);
    return undefined;
}
