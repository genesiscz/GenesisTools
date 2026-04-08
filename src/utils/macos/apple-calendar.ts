import type { CalendarEventInfo, CalendarInfo, MethodMap } from "@genesiscz/darwinkit";

import { getDarwinKit } from "./darwinkit";

export type { CalendarEventInfo, CalendarInfo };

type SourceInfo = MethodMap["calendar.sources"]["result"]["sources"][number];

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
    static async ensureAuthorized(): Promise<void> {
        const dk = getDarwinKit();
        const auth = await dk.calendar.authorized();

        if (!auth.authorized && auth.status !== "writeOnly") {
            throw new Error(
                `Calendar access not authorized (status: ${auth.status}). Grant at least write access in System Settings > Privacy & Security > Calendars.`
            );
        }
    }

    static async listCalendars(): Promise<CalendarInfo[]> {
        const dk = getDarwinKit();
        const result = await dk.calendar.calendars();
        return result.calendars;
    }

    static async listEvents(options: { calendarName?: string; from?: Date; to?: Date }): Promise<CalendarEventInfo[]> {
        const dk = getDarwinKit();
        const from = options.from ?? new Date();
        const to = options.to ?? new Date(from.getTime() + 30 * 24 * 60 * 60_000);

        let calendarIdentifiers: string[] | undefined;

        if (options.calendarName) {
            const calendars = await MacCalendar.listCalendars();
            const match = calendars.find((c) => c.title === options.calendarName);

            if (!match) {
                return [];
            }

            calendarIdentifiers = [match.identifier];
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
        const dk = getDarwinKit();
        const calendarId = await MacCalendar.ensureCalendarExists(options.calendarName ?? "GenesisTools");
        const startDate = options.startDate;
        const endDate = options.endDate ?? new Date(startDate.getTime() + 30 * 60_000);

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
        const dk = getDarwinKit();
        const existing = await dk.calendar.event({ identifier: eventId });

        if (!existing || !existing.identifier) {
            throw new Error(`Event not found: ${eventId}`);
        }

        const result = await dk.calendar.saveEvent({
            id: eventId,
            calendar_identifier: existing.calendar_identifier,
            title: options.title ?? existing.title,
            start_date: options.startDate?.toISOString() ?? existing.start_date,
            end_date: options.endDate?.toISOString() ?? existing.end_date,
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
        const allCalendars = calendars ?? (await MacCalendar.listCalendars());
        const existing = allCalendars.find((c) => c.title === name);

        if (existing) {
            return existing.identifier;
        }

        const sources = await MacCalendar.getSources();
        const icloudSource =
            sources.find((s) => s.title.toLowerCase().includes("icloud")) ??
            sources.find((s) => s.source_type === "calDAV");
        const sourceId = icloudSource?.identifier ?? sources[0]?.identifier;

        if (!sourceId) {
            throw new Error("No calendar source available");
        }

        const dk = getDarwinKit();
        const result = await dk.calendar.saveCalendar({
            title: name,
            source_identifier: sourceId,
        });

        if (!result.success || !result.identifier) {
            throw new Error(`Failed to create calendar "${name}": ${result.error ?? "unknown error"}`);
        }

        return result.identifier;
    }
}
