import type { CalendarAuthorizedResult, CalendarEventInfo, CalendarInfo, SourceInfo } from "@genesiscz/darwinkit";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { getDarwinKit } from "./darwinkit";
import { describeResponsibleIdentity } from "./genesis-app";

export type { CalendarAuthorizedResult, CalendarEventInfo, CalendarInfo, SourceInfo };

/** EventKit hands this single fake calendar back when the process has Add Only (write-only) access. */
export const CALENDAR_PLACEHOLDER_IDENTIFIER = "VIRTUAL_APP_CALENDAR_UUID";

/** `authorized()` blocks inside EventKit while the macOS prompt is on screen; give a human time to read it. */
const AUTH_TIMEOUT_MS = 120_000;
/** The Swift side polls up to 15 s for the user's answer to the upgrade dialog. */
const UPGRADE_TIMEOUT_MS = 40_000;

export interface CalendarAuthClient {
    /** prompts when the status is notDetermined */
    authorized: (opts?: { timeout?: number }) => Promise<CalendarAuthorizedResult>;
    /** never prompts */
    authorizationStatus: (opts?: { timeout?: number }) => Promise<CalendarAuthorizedResult>;
    requestFullAccess: (opts?: { timeout?: number }) => Promise<CalendarAuthorizedResult>;
}

export interface EnsureAccessOptions {
    /** Ask macOS to upgrade Add Only to Full Access (shows a system dialog). Defaults to TTY-only. */
    requestUpgrade?: boolean;
}

export function calendarPermissionMessage(status: string, need: "read" | "write"): string {
    const target = need === "read" ? "Full Access" : "Add Only or Full Access";
    const host = describeResponsibleIdentity();
    const fix = `Fix: System Settings > Privacy & Security > Calendars, set ${host} to ${target}, then re-run. macOS grants Calendar access to the responsible app, not to \`tools\`. Run \`tools macos calendar doctor\` to see what macOS granted.`;

    switch (status) {
        case "writeOnly":
            return `Calendar access for this process is Add Only (status: writeOnly): events and calendars are hidden. ${fix}`;
        case "denied":
            return `Calendar access for this process is denied (status: denied). ${fix}`;
        case "restricted":
            return `Calendar access for this process is restricted by a profile or parental controls (status: restricted). ${fix}`;
        default:
            return `Calendar access for this process is not granted (status: ${status}) and macOS showed no permission prompt. ${fix}`;
    }
}

export class CalendarPermissionError extends Error {
    readonly name = "CalendarPermissionError";
    readonly status: string;

    constructor(status: string, need: "read" | "write") {
        super(calendarPermissionMessage(status, need));
        this.status = status;
    }
}

export function isPlaceholderCalendarList(calendars: CalendarInfo[]): boolean {
    if (calendars.length !== 1) {
        return false;
    }

    const [only] = calendars;
    return (
        only.identifier === CALENDAR_PLACEHOLDER_IDENTIFIER || (only.title === "Calendar" && only.source === "Account")
    );
}

/** Read access needs fullAccess. `authorized()` itself triggers the macOS prompt when the status is notDetermined. */
export async function resolveCalendarReadAccess(
    auth: CalendarAuthClient,
    options?: EnsureAccessOptions
): Promise<CalendarAuthorizedResult> {
    let result = await auth.authorized({ timeout: AUTH_TIMEOUT_MS });
    const requestUpgrade = options?.requestUpgrade ?? isInteractive();

    if (result.status === "writeOnly" && requestUpgrade) {
        logger.info("Calendar access is Add Only; asking macOS to upgrade to Full Access (watch for a system dialog)");
        result = await auth.requestFullAccess({ timeout: UPGRADE_TIMEOUT_MS });
    }

    if (result.status !== "fullAccess") {
        throw new CalendarPermissionError(result.status, "read");
    }

    return result;
}

export async function resolveCalendarWriteAccess(auth: CalendarAuthClient): Promise<CalendarAuthorizedResult> {
    const result = await auth.authorized({ timeout: AUTH_TIMEOUT_MS });

    if (result.status !== "fullAccess" && result.status !== "writeOnly") {
        throw new CalendarPermissionError(result.status, "write");
    }

    return result;
}

export interface CreateEventOptions {
    title: string;
    notes?: string;
    startDate: Date;
    endDate?: Date;
    alerts?: number[];
    url?: string;
    location?: string;
    isAllDay?: boolean;
    availability?: "free" | "busy" | "tentative" | "unavailable";
    calendarName?: string;
}

export interface UpdateEventOptions {
    title?: string;
    notes?: string;
    startDate?: Date;
    endDate?: Date;
    alerts?: number[];
    url?: string;
    location?: string;
    isAllDay?: boolean;
    availability?: "free" | "busy" | "tentative" | "unavailable";
}

export class MacCalendar {
    /** Current status, read-only: never shows the macOS prompt (diagnostics use this). */
    static async authorizationStatus(): Promise<CalendarAuthorizedResult> {
        return getDarwinKit().calendar.authorizationStatus({ timeout: 10_000 });
    }

    static async ensureReadAccess(options?: EnsureAccessOptions): Promise<void> {
        await resolveCalendarReadAccess(getDarwinKit().calendar, options);
    }

    static async ensureWriteAccess(): Promise<void> {
        await resolveCalendarWriteAccess(getDarwinKit().calendar);
    }

    static async listCalendars(): Promise<CalendarInfo[]> {
        await MacCalendar.ensureReadAccess();
        return MacCalendar.listCalendarsUnguarded();
    }

    /** Unguarded: under Add Only this is the single placeholder calendar, which is still a valid save target. */
    static async listCalendarsUnguarded(): Promise<CalendarInfo[]> {
        const result = await getDarwinKit().calendar.calendars();
        return result.calendars;
    }

    static async listEvents(options: { calendarName?: string; from?: Date; to?: Date }): Promise<CalendarEventInfo[]> {
        await MacCalendar.ensureReadAccess();
        const dk = getDarwinKit();
        const from = options.from ?? new Date();
        const to = options.to ?? new Date(from.getTime() + 30 * 24 * 60 * 60_000);

        let calendarIdentifiers: string[] | undefined;

        if (options.calendarName) {
            const calendars = await MacCalendar.listCalendarsUnguarded();
            const filtered = calendars.filter((c) => c.title === options.calendarName);

            if (filtered.length === 0) {
                throw new Error(`Calendar not found: "${options.calendarName}"`);
            }

            if (filtered.length > 1) {
                throw new Error(
                    `Multiple calendars found with name "${options.calendarName}". Please use a unique calendar name.`
                );
            }

            calendarIdentifiers = [filtered[0].identifier];
        }

        const result = await dk.calendar.events({
            start_date: from.toISOString(),
            end_date: to.toISOString(),
            calendar_identifiers: calendarIdentifiers,
        });
        return result.events;
    }

    static async searchEvents(
        query: string,
        options?: { calendarName?: string; from?: Date; to?: Date }
    ): Promise<CalendarEventInfo[]> {
        const events = await MacCalendar.listEvents(options ?? {});
        const q = query.toLowerCase();
        return events.filter(
            (e) =>
                e.title.toLowerCase().includes(q) ||
                e.notes?.toLowerCase().includes(q) ||
                e.location?.toLowerCase().includes(q)
        );
    }

    static async createEvent(options: CreateEventOptions): Promise<string> {
        await MacCalendar.ensureWriteAccess();
        const dk = getDarwinKit();
        const calendarId = await MacCalendar.ensureCalendarExists(options.calendarName ?? "GenesisTools");
        let startDate = options.startDate;
        let endDate = options.endDate ?? new Date(startDate.getTime() + 30 * 60_000);

        if (options.isAllDay) {
            startDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            endDate = new Date(startDate.getTime() + 24 * 60 * 60_000);
        }

        if (endDate.getTime() < startDate.getTime()) {
            throw new Error("Event end date must be on or after the start date");
        }

        const result = await dk.calendar.saveEvent({
            calendar_identifier: calendarId,
            title: options.title,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            notes: options.notes,
            location: options.location,
            url: options.url,
            is_all_day: options.isAllDay,
            availability: options.availability,
            alarms: options.alerts,
        });

        if (!result.success || !result.identifier) {
            throw new Error(`Failed to create event: ${result.error ?? "unknown error"}`);
        }

        return result.identifier;
    }

    static async updateEvent(eventId: string, options: UpdateEventOptions): Promise<string> {
        await MacCalendar.ensureReadAccess();
        const dk = getDarwinKit();
        const existing = await dk.calendar.event({ identifier: eventId });

        if (!existing?.identifier) {
            throw new Error(`Event not found: ${eventId}`);
        }

        const startDate = options.startDate ?? new Date(existing.start_date);
        const endDate = options.endDate ?? new Date(existing.end_date);

        if (endDate.getTime() < startDate.getTime()) {
            throw new Error("Event end date must be on or after the start date");
        }

        const result = await dk.calendar.saveEvent({
            id: eventId,
            calendar_identifier: existing.calendar_identifier,
            title: options.title ?? existing.title,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            notes: options.notes ?? existing.notes,
            location: options.location ?? existing.location,
            url: options.url ?? existing.url,
            is_all_day: options.isAllDay ?? existing.is_all_day,
            availability: options.availability ?? existing.availability,
            alarms: options.alerts ?? existing.alarms,
        });

        if (!result.success || !result.identifier) {
            throw new Error(`Failed to update event: ${result.error ?? "unknown error"}`);
        }

        return result.identifier;
    }

    static async deleteEvent(options: { eventId: string }): Promise<boolean> {
        await MacCalendar.ensureReadAccess();
        const dk = getDarwinKit();
        const result = await dk.calendar.removeEvent({
            identifier: options.eventId,
        });
        return result.ok;
    }

    static async getSources(): Promise<SourceInfo[]> {
        const dk = getDarwinKit();
        const result = await dk.calendar.sources();
        return result.sources;
    }

    static async ensureCalendarExists(name: string, calendars?: CalendarInfo[]): Promise<string> {
        const allCalendars = calendars ?? (await MacCalendar.listCalendarsUnguarded());
        const filtered = allCalendars.filter((c) => c.title === name);

        if (filtered.length > 1) {
            throw new Error(`Multiple calendars found with name "${name}". Please use a unique calendar name.`);
        }

        if (filtered.length === 1) {
            return filtered[0].identifier;
        }

        const sources = await MacCalendar.getSources();

        if (sources.length === 0) {
            throw new Error("No calendar source available");
        }

        const priority: SourceInfo["source_type"][] = ["local", "calDAV", "mobileMe", "exchange"];
        const ordered = [
            ...sources
                .filter((s) => s.title.toLowerCase().includes("icloud"))
                .filter((s) => priority.includes(s.source_type)),
            ...priority.flatMap((type) =>
                sources.filter((s) => s.source_type === type && !s.title.toLowerCase().includes("icloud"))
            ),
        ];
        const candidates = ordered.length > 0 ? ordered : sources;

        const dk = getDarwinKit();
        const errors: string[] = [];

        for (const source of candidates) {
            const result = await dk.calendar.saveCalendar({
                title: name,
                source_identifier: source.identifier,
            });

            if (result.success && result.identifier) {
                return result.identifier;
            }

            errors.push(`${source.title} (${source.source_type}): ${result.error ?? "unknown error"}`);
        }

        const writable = allCalendars.find((c) => c.allows_content_modifications);

        if (writable) {
            return writable.identifier;
        }

        throw new Error(
            `Failed to create calendar "${name}" in any source and no writable existing calendar available. Tried: ${errors.join("; ")}. ` +
                `Hint: pass an existing calendar via calendarName, or grant Calendar write access in System Settings > Privacy & Security > Calendars.`
        );
    }
}
