import type { GenesisAppRpcOutcome } from "@genesiscz/utils/macos/genesis-app-rpc";
import type { NotificationCenterStatus, NotificationFallbackState } from "@genesiscz/utils/macos/notifications";
import type { CalendarDoctorReport } from "../calendar/doctor";
import type { PermissionsReport } from "../permissions/report";
import type { RemindersDoctorReport } from "../reminders/doctor";

/** One section of `tools macos doctor`: a name, pass/fail, and the lines to print under it. */
export interface DoctorCheckSummary {
    name: string;
    ok: boolean;
    lines: string[];
}

export function summarizePermissionsCheck(report: Pick<PermissionsReport, "problems">): DoctorCheckSummary {
    return {
        name: "GenesisTools.app & permissions",
        ok: report.problems.length === 0,
        lines: report.problems.length === 0 ? ["No problems found."] : report.problems,
    };
}

function summarizeFixableCheck(
    name: string,
    report: Pick<CalendarDoctorReport, "verdict" | "fix">
): DoctorCheckSummary {
    return {
        name,
        ok: !report.fix,
        lines: report.fix ? [report.verdict, `Fix: ${report.fix}`] : [report.verdict],
    };
}

export function summarizeCalendarCheck(report: Pick<CalendarDoctorReport, "verdict" | "fix">): DoctorCheckSummary {
    return summarizeFixableCheck("Calendar", report);
}

export function summarizeRemindersCheck(report: Pick<RemindersDoctorReport, "verdict" | "fix">): DoctorCheckSummary {
    return summarizeFixableCheck("Reminders", report);
}

/**
 * `notificationStatus()` only answers once GenesisTools.app is reachable, so a missing app
 * reads as an RPC failure rather than "not authorized". The fallback state names what would
 * actually carry the next notification instead of just "unavailable" (#455 item 5).
 */
export function summarizeNotificationsCheck(
    outcome: GenesisAppRpcOutcome<NotificationCenterStatus>,
    fallback: NotificationFallbackState
): DoctorCheckSummary {
    if (!outcome.ok) {
        if (fallback.kind === "terminal-notifier") {
            return {
                name: "Notifications",
                ok: false,
                lines: [
                    `GenesisTools.app missing; using terminal-notifier at ${fallback.path} (not confirmed authorized).`,
                ],
            };
        }

        if (fallback.kind === "osascript-only") {
            return {
                name: "Notifications",
                ok: false,
                lines: [
                    "GenesisTools.app missing, terminal-notifier not found; osascript only, delivery cannot be confirmed.",
                ],
            };
        }

        return { name: "Notifications", ok: false, lines: [`${outcome.error.code}: ${outcome.error.message}`] };
    }

    return {
        name: "Notifications",
        ok: outcome.result.authorization === "authorized",
        lines: [`authorization: ${outcome.result.authorization}`, `alertStyle: ${outcome.result.alertStyle}`],
    };
}

/** True only when every check passed. */
export function combineDoctorChecks(checks: readonly Pick<DoctorCheckSummary, "ok">[]): boolean {
    return checks.every((check) => check.ok);
}
