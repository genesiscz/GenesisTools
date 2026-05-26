import { out } from "@app/logger";
import { FileTailer } from "@app/utils/fs/file-tailer";
import { SafeJSON } from "@app/utils/json";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord, JsonlLineRecord, JsonlRecord } from "@app/utils/log-session/types";
import type { LogQueryOpts } from "../types";
import { printTailStatus } from "./log-hints";
import { queryLogs } from "./log-query";
import { jsonlPath } from "./paths";

function matchesFilters(line: JsonlLineRecord, opts: LogQueryOpts, seenSeq: Set<number>): boolean {
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

    if (opts.grep) {
        const re = new RegExp(opts.grep, "i");
        if (!re.test(line.text)) {
            return false;
        }
    }

    return true;
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

    const records = await readJsonlFile(path);
    const existingExit = findExitRecord(records);
    const existing = filterLineRecords(records);
    const tailCount = opts.lines ?? 10;
    const initial = existing.slice(-tailCount);

    for (const line of initial) {
        if (matchesFilters(line, opts, seenSeq)) {
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
            if (matchesFilters(line, opts, seenSeq)) {
                seenSeq.add(line.seq);
                emitLine(line, opts.format);
            }
        },
    });

    tailer.start();

    await new Promise<void>((resolve) => {
        resolveFollow = resolve;

        onSigint = (): void => {
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
