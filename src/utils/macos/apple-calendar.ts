import { spawnSync } from "node:child_process";

import { SafeJSON } from "@app/utils/json";

function ensureMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Apple Calendar is only available on macOS");
    }
}

function runJxa(script: string, timeout = 15_000): string {
    const proc = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
        encoding: "utf-8",
        timeout,
    });

    if (proc.status !== 0) {
        throw new Error(`JXA error: ${proc.stderr?.trim() || "unknown error"}`);
    }

    return proc.stdout.trim();
}

function escapeJxa(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ensureCalendarExists(name: string): void {
    ensureMacOS();

    const escapedName = escapeJxa(name);

    const script = `
const Calendar = Application("Calendar");
const calendars = Calendar.calendars.whose({name: "${escapedName}"});
if (calendars.length === 0) {
    Calendar.Calendar({name: "${escapedName}"}).make();
}
"ok";
`;

    runJxa(script);
}

export function createCalendarEvent(options: {
    title: string;
    notes?: string;
    startDate: Date;
    endDate?: Date;
    alerts?: number[];
    calendarName?: string;
}): string {
    ensureMacOS();

    const calendarName = options.calendarName ?? "GenesisTools";
    const startMs = options.startDate.getTime();
    const endMs = options.endDate?.getTime() ?? startMs + 30 * 60_000;
    const escapedTitle = escapeJxa(options.title);
    const escapedCalendar = escapeJxa(calendarName);
    const escapedNotes = options.notes ? escapeJxa(options.notes) : "";
    const alertsJson = SafeJSON.stringify(options.alerts ?? []);

    const script = `
const Calendar = Application("Calendar");
const calendars = Calendar.calendars.whose({name: "${escapedCalendar}"});
if (calendars.length === 0) {
    Calendar.Calendar({name: "${escapedCalendar}"}).make();
}

const cal = Calendar.calendars.whose({name: "${escapedCalendar}"})[0];
const event = Calendar.Event({
    summary: "${escapedTitle}",
    startDate: new Date(${startMs}),
    endDate: new Date(${endMs}),
    description: "${escapedNotes}"
});
cal.events.push(event);

const alerts = ${alertsJson};
for (const mins of alerts) {
    const alarm = Calendar.DisplayAlarm({triggerInterval: -mins * 60});
    event.displayAlarms.push(alarm);
}

event.uid();
`;

    return runJxa(script, 30_000);
}

export function deleteCalendarEvent(options: { eventId: string; calendarName?: string }): boolean {
    ensureMacOS();

    const calendarName = options.calendarName ?? "GenesisTools";
    const escapedCalendar = escapeJxa(calendarName);
    const escapedId = escapeJxa(options.eventId);

    const script = `
const Calendar = Application("Calendar");
const calendars = Calendar.calendars.whose({name: "${escapedCalendar}"});
if (calendars.length === 0) {
    "false";
} else {
    const cal = calendars[0];
    const events = cal.events.whose({uid: "${escapedId}"});
    if (events.length === 0) {
        "false";
    } else {
        Calendar.delete(events[0]);
        "true";
    }
}
`;

    const result = runJxa(script, 30_000);
    return result === "true";
}
