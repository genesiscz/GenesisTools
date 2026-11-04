import { z } from "zod";

/** A person on a calendar entry. Apple Calendar names none through darwinkit; Wispr Flow's calendar gives the emails. */
export const calendarPersonSchema = z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    self: z.boolean().optional(),
});
export type CalendarPerson = z.infer<typeof calendarPersonSchema>;

/** One calendar entry, from whichever calendar holds it. */
export const calendarEntrySchema = z.object({
    /** "apple-calendar", or the id of a source with its own calendar ("wisprflow"). */
    from: z.string().min(1),
    entryId: z.string().min(1),
    /** The calendar's name, when the calendar has names (Apple Calendar). */
    calendar: z.string().optional(),
    title: z.string(),
    start: z.string().min(1),
    end: z.string().min(1),
    people: z.array(calendarPersonSchema).default([]),
    conferenceUrl: z.string().optional(),
    /** The same entry as another calendar holds it (one Outlook meeting in Apple Calendar and in Wispr Flow). */
    alsoIn: z.array(z.object({ from: z.string(), entryId: z.string(), calendar: z.string().optional() })).optional(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

/**
 * What one calendar answered. A calendar that could not be read says why: an empty list from a calendar without its
 * grant is never "no entries".
 */
export type CalendarLookup =
    | { ok: true; from: string; entries: CalendarEntry[] }
    | { ok: false; from: string; reason: string; fix?: string };
