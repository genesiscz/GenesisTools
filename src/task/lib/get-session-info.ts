import { out } from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { filterByStream, filterLineRecords, lastNLines, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { sessionFilePaths } from "./paths";
import { TaskSessionStore } from "./session-store";
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

    out.log.info("");
    out.log.info(`╔ task session: ${session} ${"═".repeat(Math.max(0, 58 - session.length))}╗`);
    out.log.info("║ STATUS");
    out.log.info(`║   State:     ${formatState(meta)}`);
    out.log.info(`║   Mode:      ${modeLabel}`);
    out.log.info(`║   Command:   ${meta?.command ?? "(unknown)"}`);
    out.log.info(`║   CWD:       ${meta?.cwd ?? "(unknown)"}`);

    if (meta?.pid) {
        out.log.info(`║   PID:       ${meta.pid}`);
    }

    out.log.info("║");
    out.log.info("║ LOG FILES");
    out.log.info(`║   jsonl:     ${paths.jsonl}  (${formatBytes(jsonlSize)})`);
    out.log.info(`║   stdout:    ${paths.stdout}  (${formatBytes(stdoutSize)})`);
    out.log.info(`║   stderr:    ${paths.stderr}  (${formatBytes(stderrSize)})`);
    out.log.info("║");
    out.log.info("║ COUNTS");
    out.log.info(`║   Lines:     ${allLines.length.toLocaleString()} (seq ${firstSeq}–${lastSeq})`);
    out.log.info(
        `║   stdout:    ${stdoutLines.length.toLocaleString()} lines · stderr: ${stderrLines.length.toLocaleString()} lines`
    );

    if (allLines.length > 0) {
        const latest = allLines[allLines.length - 1];
        out.log.info(`║   Latest:    seq ${latest.seq} @ ${new Date(latest.ts).toLocaleTimeString()}`);
    }

    out.log.info("║");
    out.log.info("║ LAST 10 LINES (preview)");

    if (preview.length === 0) {
        out.log.info("║   (no lines yet)");
    } else {
        for (const line of preview) {
            const text = line.text.length > 60 ? `${line.text.slice(0, 57)}...` : line.text;
            out.log.info(`║   #${line.seq}  ${line.out.padEnd(6)}  ${text}`);
        }
    }

    out.log.info("║");
    out.log.info("║ WHAT TO RUN NEXT (copy-paste)");
    out.log.info(`║   Read last 100    ${suggestLogs(session, ["--lines", "100"])}`);
    out.log.info(`║   Live follow      ${suggestTail(session)}`);
    out.log.info(`║   Same as above    ${suggestLogsFollow(session)}`);
    out.log.info(`║   Stderr only      ${suggestLogs(session, ["--stderr", "--raw"])}`);
    out.log.info(`║   Grep stdout      ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    out.log.info(`║   JSONL + rg       ${suggestLogs(session, ["--jsonl"])} | rg error`);
    out.log.info(`║   Dashboard        ${suggestDashboard(session)}`);
    out.log.info("║");
    out.log.info("║ FLAGS (logs + tail — short forms also work but mean the same)");
    out.log.info("║   --follow       Stream live until Ctrl+C (alias: -f)");
    out.log.info("║   --tail         On logs only — same as --follow");
    out.log.info("║   --lines N      Last N lines by seq (alias: -n)");
    out.log.info("║   --from-seq N   Include from seq N onward");
    out.log.info("║   --to-seq N     Include up to seq N");
    out.log.info("║   --stdout       Stdout lines only (default: both streams)");
    out.log.info("║   --stderr       Stderr lines only");
    out.log.info("║   --raw          Plain text on stdout → safe for | grep");
    out.log.info("║   --jsonl        JSON lines on stdout → safe for | rg");
    out.log.info("║   --grep PAT     Filter before printing");
    out.log.info("║");
    out.log.info("║ I/O CONTRACT");
    out.log.info("║   this panel (get)     → stderr — don't pipe");
    out.log.info("║   logs/tail content    → stdout — pipe with --raw or --jsonl for grep");
    out.log.info(`╚${"═".repeat(76)}╝`);
    out.log.info("");
}
