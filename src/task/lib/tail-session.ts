import { out } from "@app/logger";
import { FileTailer } from "@app/utils/fs/file-tailer";
import { SafeJSON } from "@app/utils/json";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import type { LogQueryOpts } from "../types";
import { printTailStatus } from "./log-hints";
import { queryLogs } from "./log-query";
import { jsonlPath } from "./paths";
import { statusLine } from "./stderr-status";

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

export async function tailSession(opts: LogQueryOpts & { follow: true }): Promise<void> {
    const path = jsonlPath(opts.session);
    const seenSeq = new Set<number>();

    const records = await readJsonlFile(path);
    const existing = filterLineRecords(records);
    const tailCount = opts.lines ?? 10;
    const initial = existing.slice(-tailCount);

    for (const line of initial) {
        if (matchesFilters(line, opts, seenSeq)) {
            seenSeq.add(line.seq);
            emitLine(line, opts.format);
        }
    }

    printTailStatus(opts.session);

    const tailer = new FileTailer<JsonlLineRecord>(path, {
        onLine: (entry) => {
            if (entry.type !== "line") {
                return;
            }

            if (matchesFilters(entry, opts, seenSeq)) {
                seenSeq.add(entry.seq);
                emitLine(entry, opts.format);
            }
        },
    });

    tailer.start();

    await new Promise<void>((resolve) => {
        const onSigint = (): void => {
            tailer.stop();
            statusLine("\nStopped tailing.");
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
