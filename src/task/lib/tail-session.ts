import { out } from "@app/logger";
import { FileTailer } from "@app/utils/fs/file-tailer";
import { SafeJSON } from "@app/utils/json";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord, JsonlLineRecord, JsonlRecord } from "@app/utils/log-session/types";
import type { LogQueryOpts } from "@app/task/types";
import { printTailStatus } from "@app/task/lib/log-hints";
import { queryLogs } from "@app/task/lib/log-query";
import { jsonlPath } from "@app/task/lib/paths";

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

export async function tailSession(opts: LogQueryOpts & { follow: true }): Promise<void> {
    const path = jsonlPath(opts.session);
    const seenSeq = new Set<number>();
    // Compile once at the entry — a bad pattern fails up-front (loud and
    // recoverable) instead of throwing per-line inside the live tailer's
    // onLine callback where the error is swallowed and the tail dies silent.
    const grepRe = compileGrep(opts.grep);

    const records = await readJsonlFile(path);
    const existingExit = findExitRecord(records);
    const existing = filterLineRecords(records);
    // `opts.lines ?? 10` lets `--lines 0` mean "show no backlog, just stream
    // new lines" (rather than the default 10). slice(-0) === slice(0) returns
    // the WHOLE array, so guard the zero case explicitly.
    const tailCount = opts.lines ?? 10;
    const initial = tailCount > 0 ? existing.slice(-tailCount) : [];

    for (const line of initial) {
        if (matchesFilters(line, opts, seenSeq, grepRe)) {
            seenSeq.add(line.seq);
            emitLine(line, opts.format);
        }
    }

    if (existingExit) {
        out.printlnErr(`Session exited (code ${existingExit.code}).`);
        return;
    }

    printTailStatus(opts.session);

    let resolveFollow: (() => void) | undefined;
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
                resolveFollow?.();
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

    await new Promise<void>((resolve) => {
        resolveFollow = resolve;

        onSigint = (): void => {
            // Detach ourselves so we don't leak the listener — a subsequent
            // tailSession() call in the same process (tests, repeated CLI use,
            // long-lived MCP) would otherwise stack handlers and a single
            // Ctrl+C would resolve multiple promises out of order. The exit-
            // record branch above already calls process.off; do the same here
            // for the explicit-cancel branch.
            if (onSigint) {
                process.off("SIGINT", onSigint);
            }

            tailer.stop();
            out.printlnErr("\nStopped tailing.");
            resolve();
        };

        process.on("SIGINT", onSigint);
    });
}

export async function tailOrQuery(opts: LogQueryOpts, follow: boolean): Promise<void> {
    if (follow) {
        await tailSession({ ...opts, follow: true });
        return;
    }

    await queryLogs(opts);
}
