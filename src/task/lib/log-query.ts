import { out } from "@app/logger";
import { printLogNavigationHints } from "@app/task/lib/log-hints";
import { jsonlPath } from "@app/task/lib/paths";
import type { LogQueryOpts } from "@app/task/types";
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

function applyGrep(lines: JsonlLineRecord[], pattern?: string): JsonlLineRecord[] {
    if (!pattern) {
        return lines;
    }

    let re: RegExp;
    try {
        re = new RegExp(pattern, "i");
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`invalid --grep pattern: ${detail}`);
    }

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
    // A "block" is a maximal contiguous run of lines from the same stream.
    // Headers are emitted as `=== [stream] seq A-B ===` where A and B are
    // the first and LAST seq in the block. The previous implementation set
    // rangeEnd to the current line's seq inline, so the displayed header
    // was always degenerate (`seq A`); compute the block boundaries up
    // front by scanning forward to the next stream change.
    let i = 0;
    while (i < lines.length) {
        const blockStart = i;
        const blockStream = lines[i].out;
        let blockEnd = i;
        while (blockEnd + 1 < lines.length && lines[blockEnd + 1].out === blockStream) {
            blockEnd += 1;
        }

        if (blockStart > 0) {
            out.print(`\n`);
        }

        const startSeq = lines[blockStart].seq;
        const endSeq = lines[blockEnd].seq;
        const rangeLabel = endSeq !== startSeq ? `${startSeq}–${endSeq}` : `${startSeq}`;
        out.print(`=== [${blockStream}] seq ${rangeLabel} ===\n`);

        for (let j = blockStart; j <= blockEnd; j++) {
            out.print(`${lines[j].text}\n`);
        }

        i = blockEnd + 1;
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
