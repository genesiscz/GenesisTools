import { out } from "@app/logger";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import { suggestGet, suggestLogs, suggestTail } from "@app/task/lib/suggest-flags";

export function printLogNavigationHints(opts: {
    session: string;
    lines: JsonlLineRecord[];
    totalLines: number;
    windowLabel: string;
    streams: Set<"stdout" | "stderr">;
}): void {
    const { session, lines, totalLines, windowLabel, streams } = opts;

    if (lines.length === 0) {
        out.printlnErr(`── session ${session} ── no matching lines`);
        out.printlnErr(`  Live follow → ${suggestTail(session)}`);
        out.printlnErr(`  Info        → ${suggestGet(session)}`);
        return;
    }

    const firstSeq = lines[0].seq;
    const lastSeq = lines[lines.length - 1].seq;
    const streamLabel = streams.size === 2 ? "stdout+stderr" : streams.has("stdout") ? "stdout" : "stderr";

    out.printlnErr(`── session ${session} ${"─".repeat(Math.max(0, 40 - session.length))}`);
    out.printlnErr(
        `  Showing seq ${firstSeq}–${lastSeq} of ${totalLines.toLocaleString()} lines (${windowLabel}, streams: ${streamLabel})`
    );
    out.printlnErr("");
    out.printlnErr("  Navigate:");

    if (firstSeq > 1) {
        out.printlnErr(`    earlier  → ${suggestLogs(session, ["--to-seq", String(firstSeq - 1), "--tail", "50"])}`);
    }

    if (lastSeq < totalLines) {
        out.printlnErr(`    later    → ${suggestLogs(session, ["--from-seq", String(lastSeq + 1), "--tail", "50"])}`);
    }

    out.printlnErr(`    live     → ${suggestTail(session)}`);
    out.printlnErr(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    out.printlnErr(`    info     → ${suggestGet(session)}`);
    out.printlnErr("");
    out.printlnErr("  Piping (--raw or --jsonl on stdout):");
    out.printlnErr(`    grep     → ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    out.printlnErr(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    out.printlnErr(`  (Hints use --follow not -f — see: ${suggestGet(session)})`);
    out.printlnErr("──");
}

export function printTailStatus(session: string): void {
    out.printlnErr(`Watching session ${session} (Ctrl+C to stop)...`);
    out.printlnErr(`Tip: ${suggestGet(session)}`);
}
