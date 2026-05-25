import { escapeShellArg } from "@app/utils/string";
import { sessionFilePaths } from "./paths";
import { statusLine } from "./stderr-status";
import { suggestDashboard, suggestGet, suggestLogs, suggestLogsFollow, suggestTail } from "./suggest-flags";

export function formatCommandDisplay(command: string[]): string {
    return command.map((part) => escapeShellArg(part)).join(" ");
}

export function printRunBanner(session: string, command: string[], mode: "pty" | "pipe"): void {
    const paths = sessionFilePaths(session);
    const modeLabel = mode === "pty" ? "pty (interactive)" : "pipe (non-interactive)";
    const cmdDisplay = formatCommandDisplay(command);
    const pad = Math.max(0, 60 - session.length);

    statusLine("");
    statusLine(`┌ task session: ${session} ${"─".repeat(pad)}┐`);
    statusLine(`│ Command:  ${cmdDisplay}`);
    statusLine(`│ Mode:     ${modeLabel}`);
    statusLine(`│ Logs:     ${paths.jsonl}`);
    statusLine(`│           ${paths.stdout}`);
    statusLine(`│           ${paths.stderr}`);
    statusLine("│");
    statusLine(`│ Session info:  ${suggestGet(session)}`);
    statusLine(`│ Read logs:     ${suggestLogs(session, ["--lines", "100"])}`);
    statusLine(`│ Live follow:   ${suggestTail(session)}`);
    statusLine(`│ Same as above: ${suggestLogsFollow(session)}`);
    statusLine(`│ Grep-safe:     ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    statusLine(`│ Dashboard:     ${suggestDashboard(session)}`);
    statusLine(`└${"─".repeat(76)}┘`);
    statusLine("");
}

export function printRunExitSummary(session: string, exitCode: number, durationMs: number): void {
    const seconds = Math.round(durationMs / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    statusLine(`Session ${session} ended (code ${exitCode}, ${duration})`);
    statusLine(`Tip: ${suggestGet(session)}`);
}
