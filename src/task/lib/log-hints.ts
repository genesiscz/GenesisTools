import { out } from "@app/logger";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
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
        out.log.info(`── session ${session} ── no matching lines`);
        out.log.info(`  Live follow → ${suggestTail(session)}`);
        out.log.info(`  Info        → ${suggestGet(session)}`);
        return;
    }

    const firstSeq = lines[0].seq;
    const lastSeq = lines[lines.length - 1].seq;
    const streamLabel = streams.size === 2 ? "stdout+stderr" : streams.has("stdout") ? "stdout" : "stderr";
    const linesLabel = linesRequested ? `--lines ${linesRequested}` : "all";

    out.log.info(`── session ${session} ${"─".repeat(Math.max(0, 40 - session.length))}`);
    out.log.info(
        `  Showing seq ${firstSeq}–${lastSeq} of ${totalLines.toLocaleString()} lines (${linesLabel}, streams: ${streamLabel})`
    );
    out.log.info("");
    out.log.info("  Navigate:");

    if (firstSeq > 1) {
        out.log.info(`    earlier  → ${suggestLogs(session, ["--to-seq", String(firstSeq - 1), "--lines", "50"])}`);
    }

    if (lastSeq < totalLines) {
        out.log.info(`    later    → ${suggestLogs(session, ["--from-seq", String(lastSeq + 1), "--lines", "50"])}`);
    }

    out.log.info(`    live     → ${suggestTail(session)}`);
    out.log.info(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    out.log.info(`    info     → ${suggestGet(session)}`);
    out.log.info("");
    out.log.info("  Piping (--raw or --jsonl on stdout):");
    out.log.info(`    grep     → ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    out.log.info(`    stderr   → ${suggestLogs(session, ["--stderr", "--raw"])} | grep warn`);
    out.log.info(`  (Hints use --follow not -f — see: ${suggestGet(session)})`);
    out.log.info("──");
}

export function printTailStatus(session: string): void {
    out.log.info(`Watching session ${session} (Ctrl+C to stop)...`);
    out.log.info(`Tip: ${suggestGet(session)}`);
}
