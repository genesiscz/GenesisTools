import type { GenesisAppRpcOutcome } from "@genesiscz/utils/macos/genesis-app-rpc";
import {
    type NotificationCenterStatus,
    type NotificationFallbackState,
    notificationStatus,
    resolveNotificationFallbackState,
} from "@genesiscz/utils/macos/notifications";
import { type CalendarDoctorReport, runCalendarDoctor } from "../calendar/doctor";
import { type PermissionsReport, permissionsReport } from "../permissions/report";
import { type RemindersDoctorReport, runRemindersDoctor } from "../reminders/doctor";
import {
    combineDoctorChecks,
    type DoctorCheckSummary,
    summarizeCalendarCheck,
    summarizeNotificationsCheck,
    summarizePermissionsCheck,
    summarizeRemindersCheck,
} from "./summarize";

export interface MacosDoctorReport {
    ok: boolean;
    checks: DoctorCheckSummary[];
    reports: {
        permissions: PermissionsReport;
        calendar: CalendarDoctorReport;
        reminders: RemindersDoctorReport;
        notifications: GenesisAppRpcOutcome<NotificationCenterStatus>;
        fallback: NotificationFallbackState;
    };
}

/**
 * Every read-only macOS check in one pass, as one report: `tools macos doctor` renders it, and any
 * other surface gets the same answer from here. Calls each check's library function directly
 * (never spawns `tools macos calendar doctor` etc.), and none of them can show a permission dialog
 * or write durable state, the same contract as each individual doctor.
 */
export async function runMacosDoctor(): Promise<MacosDoctorReport> {
    // Sequential, not Promise.all: Calendar and Reminders share one DarwinKit child process, and
    // #448 was exactly this kind of concurrent call racing a permission decision. None of these
    // calls can prompt, so there is nothing to gain by overlapping them and a real failure mode
    // to avoid.
    const permissions = permissionsReport();
    const calendar = await runCalendarDoctor();
    const reminders = await runRemindersDoctor();
    const notifications = await notificationStatus();
    const fallback = await resolveNotificationFallbackState();

    const checks: DoctorCheckSummary[] = [
        summarizePermissionsCheck(permissions),
        summarizeCalendarCheck(calendar),
        summarizeRemindersCheck(reminders),
        summarizeNotificationsCheck(notifications, fallback),
    ];

    return {
        ok: combineDoctorChecks(checks),
        checks,
        reports: { permissions, calendar, reminders, notifications, fallback },
    };
}
