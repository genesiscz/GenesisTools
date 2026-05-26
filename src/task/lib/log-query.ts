import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import {
    filterByStream,
    filterFromSeq,
    filterLineRecords,
    filterToSeq,
    lastNLines,
    readJsonlFile,
} from "@app/utils/log-session/jsonl-reader";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import type { LogQueryOpts } from "@app/task/types";
import { printLogNavigationHints } from "@app/task/lib/log-hints";
import { jsonlPath } from "@app/task/lib/paths";

function applyGrep(lines: JsonlLineRecord[], pattern?: string): JsonlLineRecord[] {
    if (!pattern) {
        return lines;
    }

    const re = new RegExp(pattern, "i");
    return lines.filter((l) => re.test(l.text));
}

function selectLines(allLines: JsonlLineRecord[], opts: LogQueryOpts): JsonlLineRecord[] {
    let lines = [...allLines];

    if (opts.fromSeq !== undefined) {
        lines = filterFromSeq(lines, opts.fromSeq);
    }

    if (opts.toSeq !== undefined) {
        lines = filterToSeq(lines, opts.toSeq);
    }

    lines = filterByStream(lines, opts.streams);
    lines = applyGrep(lines, opts.grep);

    if (opts.fromSeq === undefined && opts.toSeq === undefined && opts.lines !== undefined) {
        lines = lastNLines(lines, opts.lines);
    }

    return lines;
}

function formatHuman(lines: JsonlLineRecord[]): void {
    let currentStream: string | null = null;
    let rangeStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const next = lines[i + 1];

        if (currentStream !== line.out) {
            if (currentStream !== null) {
                out.print(`\n`);
            }

            rangeStart = line.seq;
            currentStream = line.out;
            const rangeEnd = line.seq;
            out.print(`=== [${line.out}] seq ${rangeStart}${rangeEnd !== rangeStart ? `–${rangeEnd}` : ""} ===\n`);
        }

        out.print(`${line.text}\n`);

        if (next && next.out !== line.out) {
            currentStream = null;
        }
    }
}

function formatRaw(lines: JsonlLineRecord[]): void {
    for (const line of lines) {
        out.print(`${line.text}\n`);
    }
}

function formatJsonl(lines: JsonlLineRecord[]): void {
    for (const line of lines) {
        out.print(`${SafeJSON.stringify(line, { jsonl: true })}\n`);
    }
}

export async function queryLogs(opts: LogQueryOpts): Promise<void> {
    const records = await readJsonlFile(jsonlPath(opts.session));
    const allLines = filterLineRecords(records);
    const lines = selectLines(allLines, opts);

    if (opts.format === "raw") {
        formatRaw(lines);
    } else if (opts.format === "jsonl") {
        formatJsonl(lines);
    } else {
        formatHuman(lines);
    }

    if (opts.format === "human") {
        printLogNavigationHints({
            session: opts.session,
            lines,
            totalLines: allLines.length,
            linesRequested: opts.lines,
            streams: opts.streams,
        });
    }
}

export async function loadSessionLines(session: string): Promise<JsonlLineRecord[]> {
    const records = await readJsonlFile(jsonlPath(session));
    return filterLineRecords(records);
}
