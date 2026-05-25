import { formatBytes } from "@app/utils/format";
import { filterByStream, filterLineRecords, lastNLines, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { sessionFilePaths } from "./paths";
import { TaskSessionStore } from "./session-store";
import { statusLine } from "./stderr-status";
import { suggestDashboard, suggestLogs, suggestLogsFollow, suggestTail } from "./suggest-flags";

function formatDurationMs(ms: number): string {
    const seconds = Math.round(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }

    return `${secs}s`;
}

function formatState(meta: Awaited<ReturnType<TaskSessionStore["getSessionMeta"]>>): string {
    if (!meta) {
        return "unknown";
    }

    if (meta.exitCode !== undefined) {
        return `exited (code ${meta.exitCode}, ${formatDurationMs(meta.durationMs ?? 0)})`;
    }

    const runningMs = Date.now() - meta.createdAt;
    return `active (running ${formatDurationMs(runningMs)})`;
}

export async function getSessionInfo(session: string): Promise<void> {
    const store = new TaskSessionStore();
    const meta = await store.getSessionMeta(session);
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

    statusLine("");
    statusLine(`╔ task session: ${session} ${"═".repeat(Math.max(0, 58 - session.length))}╗`);
    statusLine("║ STATUS");
    statusLine(`║   State:     ${formatState(meta)}`);
    statusLine(`║   Mode:      ${modeLabel}`);
    statusLine(`║   Command:   ${meta?.command ?? "(unknown)"}`);
    statusLine(`║   CWD:       ${meta?.cwd ?? "(unknown)"}`);

    if (meta?.pid) {
        statusLine(`║   PID:       ${meta.pid}`);
    }

    statusLine("║");
    statusLine("║ LOG FILES");
    statusLine(`║   jsonl:     ${paths.jsonl}  (${formatBytes(jsonlSize)})`);
    statusLine(`║   stdout:    ${paths.stdout}  (${formatBytes(stdoutSize)})`);
    statusLine(`║   stderr:    ${paths.stderr}  (${formatBytes(stderrSize)})`);
    statusLine("║");
    statusLine("║ COUNTS");
    statusLine(`║   Lines:     ${allLines.length.toLocaleString()} (seq ${firstSeq}–${lastSeq})`);
    statusLine(
        `║   stdout:    ${stdoutLines.length.toLocaleString()} lines · stderr: ${stderrLines.length.toLocaleString()} lines`
    );

    if (allLines.length > 0) {
        const latest = allLines[allLines.length - 1];
        statusLine(`║   Latest:    seq ${latest.seq} @ ${new Date(latest.ts).toLocaleTimeString()}`);
    }

    statusLine("║");
    statusLine("║ LAST 10 LINES (preview)");

    if (preview.length === 0) {
        statusLine("║   (no lines yet)");
    } else {
        for (const line of preview) {
            const text = line.text.length > 60 ? `${line.text.slice(0, 57)}...` : line.text;
            statusLine(`║   #${line.seq}  ${line.out.padEnd(6)}  ${text}`);
        }
    }

    statusLine("║");
    statusLine("║ WHAT TO RUN NEXT (copy-paste)");
    statusLine(`║   Read last 100    ${suggestLogs(session, ["--lines", "100"])}`);
    statusLine(`║   Live follow      ${suggestTail(session)}`);
    statusLine(`║   Same as above    ${suggestLogsFollow(session)}`);
    statusLine(`║   Stderr only      ${suggestLogs(session, ["--stderr", "--raw"])}`);
    statusLine(`║   Grep stdout      ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    statusLine(`║   JSONL + rg       ${suggestLogs(session, ["--jsonl"])} | rg error`);
    statusLine(`║   Dashboard        ${suggestDashboard(session)}`);
    statusLine("║");
    statusLine("║ FLAGS (logs + tail — short forms also work but mean the same)");
    statusLine("║   --follow       Stream live until Ctrl+C (alias: -f)");
    statusLine("║   --tail         On logs only — same as --follow");
    statusLine("║   --lines N      Last N lines by seq (alias: -n)");
    statusLine("║   --from-seq N   Include from seq N onward");
    statusLine("║   --to-seq N     Include up to seq N");
    statusLine("║   --stdout       Stdout lines only (default: both streams)");
    statusLine("║   --stderr       Stderr lines only");
    statusLine("║   --raw          Plain text on stdout → safe for | grep");
    statusLine("║   --jsonl        JSON lines on stdout → safe for | rg");
    statusLine("║   --grep PAT     Filter before printing");
    statusLine("║");
    statusLine("║ I/O CONTRACT");
    statusLine("║   this panel (get)     → stderr — don't pipe");
    statusLine("║   logs/tail content    → stdout — pipe with --raw or --jsonl for grep");
    statusLine(`╚${"═".repeat(76)}╝`);
    statusLine("");
}
