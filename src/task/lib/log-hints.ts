import type { JsonlLineRecord } from "@app/utils/log-session/types";
import { statusLine } from "./stderr-status";
import { suggestGet, suggestLogs, suggestTail } from "./suggest-flags";

export function printLogNavigationHints(opts: {
    session: string;
    lines: JsonlLineRecord[];
    totalLines: number;
    linesRequested?: number;
    streams: Set<"stdout" | "stderr">;
}): void {
    const { session, lines, totalLines, linesRequested, streams } = opts;

    if (lines.length === 0) {
        statusLine(`── session ${session} ── no matching lines`);
        statusLine(`  Live follow → ${suggestTail(session)}`);
        statusLine(`  Info        → ${suggestGet(session)}`);
        return;
    }

    const firstSeq = lines[0].seq;
    const lastSeq = lines[lines.length - 1].seq;
    const streamLabel = streams.size === 2 ? "stdout+stderr" : streams.has("stdout") ? "stdout" : "stderr";
    const linesLabel = linesRequested ? `--lines ${linesRequested}` : "all";

    statusLine(`── session ${session} ${"─".repeat(Math.max(0, 40 - session.length))}`);
    statusLine(
        `  Showing seq ${firstSeq}–${lastSeq} of ${totalLines.toLocaleString()} lines (${linesLabel}, streams: ${streamLabel})`
    );
    statusLine("");
    statusLine("  Navigate:");

    if (firstSeq > 1) {
        statusLine(`    earlier  → ${suggestLogs(session, ["--to-seq", String(firstSeq - 1), "--lines", "50"])}`);
    }

    if (lastSeq < totalLines) {
        statusLine(`    later    → ${suggestLogs(session, ["--from-seq", String(lastSeq + 1), "--lines", "50"])}`);
    }

    statusLine(`    live     → ${suggestTail(session)}`);
    statusLine(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    statusLine(`    info     → ${suggestGet(session)}`);
    statusLine("");
    statusLine("  Piping (--raw or --jsonl on stdout):");
    statusLine(`    grep     → ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    statusLine(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    statusLine(`  (Hints use --follow not -f — see: ${suggestGet(session)})`);
    statusLine("──");
}

export function printTailStatus(session: string): void {
    statusLine(`Watching session ${session} (Ctrl+C to stop)...`);
    statusLine(`Tip: ${suggestGet(session)}`);
}
