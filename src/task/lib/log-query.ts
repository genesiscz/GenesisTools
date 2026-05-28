import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import {
    filterByStream,
    filterFromSeq,
    filterLineRecords,
    filterToSeq,
    readJsonlFile,
} from "@app/utils/log-session/jsonl-reader";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import type { LogQueryOpts } from "@app/task/types";
import { printLogNavigationHints } from "@app/task/lib/log-hints";
import { jsonlPath } from "@app/task/lib/paths";

export interface SliceResult<T> {
    lines: T[];
    elidedCount: number;
    headCount: number;
}

export function sliceLogLines<T>(lines: T[], opts: Pick<LogQueryOpts, "head" | "tail" | "all">): SliceResult<T> {
    if (opts.all || lines.length === 0) {
        return { lines, elidedCount: 0, headCount: 0 };
    }

    if (opts.head === undefined && opts.tail === undefined) {
        return { lines, elidedCount: 0, headCount: 0 };
    }

    const h = opts.head ?? 0;
    const t = opts.tail ?? 0;

    if (h === 0 && t === 0) {
        return { lines: [], elidedCount: 0, headCount: 0 };
    }

    if (h + t >= lines.length) {
        return { lines, elidedCount: 0, headCount: 0 };
    }

    const headSlice = h > 0 ? lines.slice(0, h) : [];
    const tailSlice = t > 0 ? lines.slice(-t) : [];

    return {
        lines: [...headSlice, ...tailSlice],
        elidedCount: lines.length - headSlice.length - tailSlice.length,
        headCount: headSlice.length,
    };
}

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

function selectLines(allLines: JsonlLineRecord[], opts: LogQueryOpts): SliceResult<JsonlLineRecord> {
    let lines = [...allLines];

    if (opts.fromSeq !== undefined) {
        lines = filterFromSeq(lines, opts.fromSeq);
    }

    if (opts.toSeq !== undefined) {
        lines = filterToSeq(lines, opts.toSeq);
    }

    lines = filterByStream(lines, opts.streams);
    lines = applyGrep(lines, opts.grep);

    if (opts.fromSeq !== undefined || opts.toSeq !== undefined) {
        return { lines, elidedCount: 0, headCount: 0 };
    }

    return sliceLogLines(lines, opts);
}

function formatHuman(lines: JsonlLineRecord[], elision?: { count: number; afterIndex: number }): void {
    let i = 0;
    while (i < lines.length) {
        if (elision && i === elision.afterIndex) {
            out.print(`... ${elision.count} lines elided ...\n`);
        }

        const blockStart = i;
        const blockStream = lines[i].out;
        let blockEnd = i;
        while (blockEnd + 1 < lines.length && lines[blockEnd + 1].out === blockStream) {
            blockEnd += 1;
        }

        if (blockStart > 0 && !(elision && blockStart === elision.afterIndex)) {
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

function formatRaw(lines: JsonlLineRecord[], elision?: { count: number; afterIndex: number }): void {
    for (let i = 0; i < lines.length; i++) {
        if (elision && i === elision.afterIndex) {
            out.print(`... ${elision.count} lines elided ...\n`);
        }

        out.print(`${lines[i].text}\n`);
    }
}

function formatJsonl(lines: JsonlLineRecord[], elision?: { count: number; afterIndex: number }): void {
    for (let i = 0; i < lines.length; i++) {
        if (elision && i === elision.afterIndex) {
            out.print(`${SafeJSON.stringify({ type: "elision", count: elision.count }, { jsonl: true })}\n`);
        }

        out.print(`${SafeJSON.stringify(lines[i], { jsonl: true })}\n`);
    }
}

export async function queryLogs(opts: LogQueryOpts): Promise<void> {
    const records = await readJsonlFile(jsonlPath(opts.session));
    const allLines = filterLineRecords(records);
    const { lines, elidedCount, headCount } = selectLines(allLines, opts);
    const elision =
        elidedCount > 0 && (opts.head ?? 0) > 0 && (opts.tail ?? 0) > 0
            ? { count: elidedCount, afterIndex: headCount }
            : undefined;

    if (opts.format === "raw") {
        formatRaw(lines, elision);
    } else if (opts.format === "jsonl") {
        formatJsonl(lines, elision);
    } else {
        formatHuman(lines, elision);
    }

    if (opts.format === "human") {
        printLogNavigationHints({
            session: opts.session,
            lines,
            totalLines: allLines.length,
            windowLabel: windowLabel(opts),
            streams: opts.streams,
        });
    }
}

function windowLabel(opts: LogQueryOpts): string {
    if (opts.all) {
        return "all";
    }

    const parts: string[] = [];
    if (opts.head) {
        parts.push(`--head ${opts.head}`);
    }

    if (opts.tail) {
        parts.push(`--tail ${opts.tail}`);
    }

    return parts.length > 0 ? parts.join(" ") : "default";
}

export async function loadSessionLines(session: string): Promise<JsonlLineRecord[]> {
    const records = await readJsonlFile(jsonlPath(session));
    return filterLineRecords(records);
}
