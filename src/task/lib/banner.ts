import { out } from "@app/logger";
import { sessionFilePaths } from "./paths";
import { suggestDashboard, suggestGet, suggestLogs, suggestLogsFollow, suggestTail } from "./suggest-flags";

export function printRunBanner(session: string, command: string, mode: "pty" | "pipe"): void {
    const paths = sessionFilePaths(session);
    const modeLabel = mode === "pty" ? "pty (interactive)" : "pipe (non-interactive)";

    out.log.info("");
    out.log.info(`┌ task session: ${session} ${"─".repeat(Math.max(0, 60 - session.length))}┐`);
    out.log.info(`│ Command:  ${command}`);
    out.log.info(`│ Mode:     ${modeLabel}`);
    out.log.info(`│ Logs:     ${paths.jsonl}`);
    out.log.info(`│           ${paths.stdout}`);
    out.log.info(`│           ${paths.stderr}`);
    out.log.info("│");
    out.log.info(`│ Session info:  ${suggestGet(session)}`);
    out.log.info(`│ Read logs:     ${suggestLogs(session, ["--lines", "100"])}`);
    out.log.info(`│ Live follow:   ${suggestTail(session)}`);
    out.log.info(`│ Same as above: ${suggestLogsFollow(session)}`);
    out.log.info(`│ Grep-safe:     ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    out.log.info(`│ Dashboard:     ${suggestDashboard(session)}`);
    out.log.info(`└${"─".repeat(76)}┘`);
    out.log.info("");
}

export function printRunExitSummary(session: string, exitCode: number, durationMs: number): void {
    const seconds = Math.round(durationMs / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    out.log.info(`Session ${session} ended (code ${exitCode}, ${duration})`);
    out.log.info(`Tip: ${suggestGet(session)}`);
}
