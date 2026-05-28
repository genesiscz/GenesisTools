import { out } from "@app/logger";
import { sessionFilePaths } from "@app/task/lib/paths";
import { suggestDashboard, suggestGet, suggestLogs, suggestLogsFollow, suggestTail } from "@app/task/lib/suggest-flags";
import type { RunBannerInput, RunExitSummaryInput } from "@app/task/types";
import { escapeShellArg } from "@app/utils/string";

export function formatCommandDisplay(command: string[]): string {
    return command.map((part) => escapeShellArg(part)).join(" ");
}

export function printRunBanner({ session, command, mode }: RunBannerInput): void {
    const paths = sessionFilePaths(session);
    const modeLabel = mode === "pty" ? "pty (interactive)" : "pipe (non-interactive)";
    const cmdDisplay = formatCommandDisplay(command);
    const pad = Math.max(0, 60 - session.length);

    out.printlnErr("");
    out.printlnErr(`┌ task session: ${session} ${"─".repeat(pad)}┐`);
    out.printlnErr(`│ Command:  ${cmdDisplay}`);
    out.printlnErr(`│ Mode:     ${modeLabel}`);
    out.printlnErr(`│ Logs:     ${paths.jsonl}`);
    out.printlnErr(`│           ${paths.stdout}`);
    out.printlnErr(`│           ${paths.stderr}`);
    out.printlnErr("│");
    out.printlnErr(`│ Session info:  ${suggestGet(session)}`);
    out.printlnErr(`│ Read logs:     ${suggestLogs(session, ["--lines", "100"])}`);
    out.printlnErr(`│ Live follow:   ${suggestTail(session)}`);
    out.printlnErr(`│ Same as above: ${suggestLogsFollow(session)}`);
    out.printlnErr(`│ Grep-safe:     ${suggestLogs(session, ["--raw"])} | grep PATTERN`);
    out.printlnErr(`│ Dashboard:     ${suggestDashboard(session)}`);
    out.printlnErr(`└${"─".repeat(76)}┘`);
    out.printlnErr("");
}

export function printRunExitSummary({ session, exitCode, durationMs }: RunExitSummaryInput): void {
    const seconds = Math.round(durationMs / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    out.printlnErr(`Session ${session} ended (code ${exitCode}, ${duration})`);
    out.printlnErr(`Tip: ${suggestGet(session)}`);
}
