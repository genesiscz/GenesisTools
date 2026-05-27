import { out } from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { filterByStream, filterLineRecords, lastNLines, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { formatSessionState } from "@app/task/lib/format-session-state";
import { sessionFilePaths } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import {
    suggestDashboard,
    suggestLogs,
    suggestLogsAllGrep,
    suggestLogsFollow,
    suggestTail,
} from "@app/task/lib/suggest-flags";

export async function getSessionInfo(session: string): Promise<void> {
    const store = new TaskSessionStore();
    const meta = await store.reconcileSessionState(session);
    const paths = sessionFilePaths(session);
    const records = await readJsonlFile(paths.jsonl);
    const allLines = filterLineRecords(records);
    const stdoutLines = filterByStream(allLines, new Set(["stdout"]));
    const stderrLines = filterByStream(allLines, new Set(["stderr"]));
    const preview = lastNLines(allLines, 10);

    const jsonlSize = await store.getSessionFileSize(paths.jsonl);
    const stdoutSize = await store.getSessionFileSize(paths.stdout);
    const stderrSize = await store.getSessionFileSize(paths.stderr);

    const firstSeq = allLines[0]?.seq ?? 0;
    const lastSeq = allLines[allLines.length - 1]?.seq ?? 0;
    const modeLabel = meta?.mode === "pty" ? "pty (interactive — j/r/d keys work)" : "pipe (non-interactive)";

    out.printlnErr("");
    out.printlnErr(`╔ task session: ${session} ${"═".repeat(Math.max(0, 58 - session.length))}╗`);
    out.printlnErr("║ STATUS");
    out.printlnErr(`║   State:     ${formatSessionState(meta)}`);
    out.printlnErr(`║   Mode:      ${modeLabel}`);

    if (meta?.mode === "pty") {
        out.printlnErr("║   Streams:   merged (use pipe mode for --stdout/--stderr filters)");
    }
    out.printlnErr(`║   Command:   ${meta?.command ?? "(unknown)"}`);
    out.printlnErr(`║   CWD:       ${meta?.cwd ?? "(unknown)"}`);

    if (meta?.requestedAs) {
        out.printlnErr(`║   Requested:  ${meta.requestedAs} (auto-suffixed)`);
    }

    const related = await store.listRelatedSessionNames(session, meta?.requestedAs);
    if (related.length > 1) {
        out.printlnErr(`║   Related:    ${related.join(", ")}`);
    }

    if (meta?.pid) {
        out.printlnErr(`║   PID:       ${meta.pid}`);
    }

    out.printlnErr("║");
    out.printlnErr("║ LOG FILES");
    out.printlnErr(`║   jsonl:     ${paths.jsonl}  (${formatBytes(jsonlSize)})`);
    out.printlnErr(`║   stdout:    ${paths.stdout}  (${formatBytes(stdoutSize)})`);
    out.printlnErr(`║   stderr:    ${paths.stderr}  (${formatBytes(stderrSize)})`);
    out.printlnErr("║");
    out.printlnErr("║ COUNTS");
    out.printlnErr(`║   Lines:     ${allLines.length.toLocaleString()} (seq ${firstSeq}–${lastSeq})`);
    out.printlnErr(
        `║   stdout:    ${stdoutLines.length.toLocaleString()} lines · stderr: ${stderrLines.length.toLocaleString()} lines`
    );

    if (allLines.length > 0) {
        const latest = allLines[allLines.length - 1];
        // ISO time (UTC) — locale-stable so this banner remains a copy-
        // pasteable diagnostic and any agent scraping it parses the same
        // shape on every machine. toLocaleTimeString() previously drifted
        // between 12h/24h, AM/PM order and separators across locales.
        const iso = new Date(latest.ts).toISOString();
        out.printlnErr(`║   Latest:    seq ${latest.seq} @ ${iso}`);
    }

    out.printlnErr("║");
    out.printlnErr("║ LAST 10 LINES (preview)");

    if (preview.length === 0) {
        out.printlnErr("║   (no lines yet)");
    } else {
        for (const line of preview) {
            const text = line.text.length > 60 ? `${line.text.slice(0, 57)}...` : line.text;
            out.printlnErr(`║   #${line.seq}  ${line.out.padEnd(6)}  ${text}`);
        }
    }

    out.printlnErr("║");
    out.printlnErr("║ WHAT TO RUN NEXT (copy-paste)");
    out.printlnErr(`║   Read last 100    ${suggestLogs(session, ["--tail", "100"])}`);
    out.printlnErr(`║   All lines        ${suggestLogs(session, ["--all", "--raw"])}`);
    out.printlnErr(`║   Live follow      ${suggestTail(session)}`);
    out.printlnErr(`║   Same as above    ${suggestLogsFollow(session)}`);
    out.printlnErr(`║   Stderr only      ${suggestLogs(session, ["--stderr", "--raw"])}`);
    out.printlnErr(`║   Grep stdout      ${suggestLogsAllGrep(session)}`);
    out.printlnErr(`║   JSONL + rg       ${suggestLogs(session, ["--jsonl"])} | rg error`);
    out.printlnErr(`║   Dashboard        ${suggestDashboard(session)}`);
    out.printlnErr("║   Clean all        tools task clean --all");
    out.printlnErr("║");
    out.printlnErr("║ FLAGS (logs + tail — short forms also work but mean the same)");
    out.printlnErr("║   -f, --follow  Stream live until Ctrl+C");
    out.printlnErr("║   -H, --head N  First N lines");
    out.printlnErr("║   -t, --tail N  Last N lines (default: logs=50, tail=10)");
    out.printlnErr("║   --head X --tail Y   First X + last Y, with elision marker between");
    out.printlnErr("║   --all         Full session (no slicing)");
    out.printlnErr("║                 (non-TTY default: --all, so | grep sees everything)");
    out.printlnErr("║   --from-seq N  Include from seq N onward");
    out.printlnErr("║   --to-seq N    Include up to seq N");
    out.printlnErr("║   --stdout      Stdout lines only (default: both streams)");
    out.printlnErr("║   --stderr      Stderr lines only");
    out.printlnErr("║   --raw         Plain text on stdout → safe for | grep");
    out.printlnErr("║   --jsonl       JSON lines on stdout → safe for | rg");
    out.printlnErr("║   --grep PAT    Filter before printing (implies --all unless --head/--tail given)");
    out.printlnErr("║");
    out.printlnErr("║ I/O CONTRACT");
    out.printlnErr("║   this panel (get)     → stderr — don't pipe");
    out.printlnErr("║   logs/tail content    → stdout — pipe with --raw or --jsonl for grep");
    out.printlnErr(`╚${"═".repeat(76)}╝`);
    out.printlnErr("");
}
