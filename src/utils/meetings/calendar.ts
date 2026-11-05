import { macosCalendarDoctorCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { logger } from "@genesiscz/utils/logger";
import { MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import type { CalendarLookup } from "./calendar-entry";
import type { MeetingCalendar } from "./record";

const { log } = logger.scoped("meetings-calendar");

/** An event counts as the meeting's when it starts this close to the recording. */
const CALENDAR_WITHIN_MS = 15 * 60_000;

/**
 * The Apple Calendar event that starts closest to `start` (within 15 minutes), skipping all-day events. A missing
 * Calendar grant or any other failure returns undefined and is logged: a recording never waits for the calendar.
 */
export async function calendarAround(start: Date): Promise<MeetingCalendar | undefined> {
    if (process.platform !== "darwin") {
        return undefined;
    }

    try {
        const events = await MacCalendar.listEvents({
            from: new Date(start.getTime() - CALENDAR_WITHIN_MS),
            to: new Date(start.getTime() + CALENDAR_WITHIN_MS),
        });
        const distance = (iso: string) => Math.abs(Date.parse(iso) - start.getTime());
        const event = events
            .filter((candidate) => !candidate.is_all_day && distance(candidate.start_date) <= CALENDAR_WITHIN_MS)
            .sort((a, b) => distance(a.start_date) - distance(b.start_date))[0];
        log.debug({ start: start.toISOString(), events: events.length, picked: event?.identifier }, "calendar lookup");

        if (!event) {
            return undefined;
        }

        return {
            from: "apple-calendar",
            eventId: event.identifier,
            calendar: event.calendar_title,
            title: event.title,
            start: new Date(event.start_date).toISOString(),
            end: new Date(event.end_date).toISOString(),
            attendees: [],
            ...(event.url ? { conferenceUrl: event.url } : {}),
        };
    } catch (err) {
        log.warn({ err }, "calendar lookup failed; the meeting gets no calendar entry");
        return undefined;
    }
}

/**
 * The Apple Calendar entries that start in the range (Outlook and Teams accounts synced into macOS Calendar), all-day
 * entries left out. It reads the grant status first and never shows the macOS dialog, so a missing grant answers
 * `ok: false` with the fix, never an empty list. darwinkit gives no attendees, so `people` stays empty; a source's own
 * calendar (Wispr Flow) gives them for the same entry.
 */
export async function appleCalendarEntries(range: { from: Date; to: Date }): Promise<CalendarLookup> {
    const from = "apple-calendar";

    if (process.platform !== "darwin") {
        return { ok: false, from, reason: "Apple Calendar exists only on macOS" };
    }

    try {
        const auth = await MacCalendar.authorizationStatus();

        if (auth.status !== "fullAccess") {
            log.info({ status: auth.status }, "calendar not read: no full access");
            return {
                ok: false,
                from,
                reason: `Calendar access is "${auth.status}", not full access`,
                fix: `${macosCalendarDoctorCommand()}, then grant GenesisTools.app Full Access to Calendars`,
            };
        }

        const events = await MacCalendar.listEvents({ from: range.from, to: range.to });
        log.debug({ events: events.length, from: range.from.toISOString() }, "apple calendar entries");
        return {
            ok: true,
            from,
            entries: events
                .filter((event) => !event.is_all_day)
                .map((event) => ({
                    from,
                    entryId: event.identifier,
                    calendar: event.calendar_title,
                    title: event.title,
                    start: new Date(event.start_date).toISOString(),
                    end: new Date(event.end_date).toISOString(),
                    people: [],
                    ...(event.url ? { conferenceUrl: event.url } : {}),
                })),
        };
    } catch (err) {
        log.warn({ err }, "apple calendar read failed");
        return { ok: false, from, reason: `Apple Calendar read failed: ${err instanceof Error ? err.message : err}` };
    }
}
