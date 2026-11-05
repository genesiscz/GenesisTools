import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingCalendar } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { readEvidence } from "./evidence";
import {
    dictionaryCandidates,
    listLocalCalendar,
    listLocalFolders,
    liveLocalMeeting,
    localAvailable,
    localMeetingFolders,
    localSelfName,
    WISPR_DIR,
} from "./local";
import { loadMeeting } from "./source";
import type { Meeting } from "./types";

const { log } = logger.scoped("wisprflow-meeting-source");

/** A calendar event counts as this meeting's when it starts this close to the recording. */
const CALENDAR_WITHIN_MS = 15 * 60_000;

/** The Wispr calendar event that starts closest to the meeting (within 15 minutes), from the local app data. */
export function calendarFor(meeting: Meeting): MeetingCalendar | undefined {
    if (!localAvailable()) {
        return undefined;
    }

    const start = Date.parse(meeting.start);
    const events = listLocalCalendar({ since: start - CALENDAR_WITHIN_MS, until: start + CALENDAR_WITHIN_MS });
    const event = events.sort(
        (a, b) => Math.abs(Date.parse(a.start) - start) - Math.abs(Date.parse(b.start) - start)
    )[0];

    if (!event) {
        return undefined;
    }

    return {
        from: "wisprflow",
        eventId: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        attendees: event.attendees,
        ...(event.conferenceUrl ? { conferenceUrl: event.conferenceUrl } : {}),
    };
}

/**
 * The participants, with the recording user marked. Wispr knows the user as a person of the speaker map (origin
 * "self") even when no speaker is assigned to them, so the name may be missing from the speaker list.
 */
function participantsOf(meeting: Meeting): SourceMeeting["participants"] {
    const self = localAvailable() ? localSelfName(meeting.id) : undefined;
    const people = meeting.participants.map((person) => ({
        name: person.name,
        ...(person.isSelf || person.name === self ? { self: true } : {}),
        from: ["wisprflow"],
    }));

    return self && !people.some((person) => person.name === self)
        ? [...people, { name: self, self: true, from: ["wisprflow"] }]
        : people;
}

function toSourceMeeting(meeting: Meeting): SourceMeeting {
    return {
        sourceMeetingId: meeting.id,
        title: meeting.title,
        start: meeting.start,
        ...(meeting.end ? { end: meeting.end } : {}),
        participants: participantsOf(meeting),
        speakers: meeting.participants,
        transcript: meeting.transcript,
        calendar: calendarFor(meeting),
        folders: meeting.folders.map((folder) => folder.name),
        ...(meeting.summary?.trim() ? { summary: meeting.summary } : {}),
    };
}

export const wisprflowSource: TranscriptSource = {
    id: "wisprflow",
    label: "Wispr Flow",

    async load(sourceMeetingId) {
        const loaded = await loadMeeting(sourceMeetingId, { source: "auto", transcript: true });
        log.debug({ id: sourceMeetingId, source: loaded.source, notes: loaded.notes }, "wisprflow meeting loaded");
        return toSourceMeeting(loaded.data);
    },

    describe(meeting) {
        return {
            meetingId: meeting.sourceMeetingId,
            folders: meeting.folders,
            ...(meeting.calendar?.eventId ? { calendarEventId: meeting.calendar.eventId } : {}),
        };
    },

    async dictionary() {
        // The app's dictionary is only on this Mac; the MCP has none.
        return localAvailable() ? dictionaryCandidates() : [];
    },

    async recordingClock(sourceMeetingId) {
        // Transcript second 0 is the meeting's start (checked 2026-11-02 against Teams leave times, within 4 s).
        const loaded = await loadMeeting(sourceMeetingId, { source: "auto", transcript: false });
        return { startedAt: loaded.data.start };
    },

    async evidence(sourceMeetingId) {
        // The raw meeting folder exists only in the local app data; the MCP keeps none of it.
        if (!localAvailable()) {
            return null;
        }

        return readEvidence(sourceMeetingId, localSelfName(sourceMeetingId));
    },

    async liveRecording() {
        if (!localAvailable()) {
            return null;
        }

        const live = liveLocalMeeting();

        if (!live) {
            return null;
        }

        const livePath = join(WISPR_DIR, "meetings", live.id, "live.ndjson");
        const changedMs = existsSync(livePath) ? statSync(livePath).mtimeMs : 0;
        return {
            sourceMeetingId: live.id,
            title: live.title,
            startedAt: live.start,
            liveChangedAt: new Date(changedMs).toISOString(),
        };
    },

    async calendarEntries(range) {
        // The app's local copy has the attendees' emails; reading it needs no grant and no network.
        if (!localAvailable()) {
            return { ok: false, from: "wisprflow", reason: "Wispr Flow's app data is not on this Mac" };
        }

        const events = listLocalCalendar({ since: range.from.getTime(), until: range.to.getTime() });
        return {
            ok: true,
            from: "wisprflow",
            entries: events.map((event) => ({
                from: "wisprflow",
                entryId: event.id,
                title: event.title,
                start: event.start,
                end: event.end,
                people: event.people ?? event.attendees.map((name) => ({ name })),
                ...(event.conferenceUrl ? { conferenceUrl: event.conferenceUrl } : {}),
            })),
        };
    },

    async folders() {
        return localAvailable() ? listLocalFolders() : null;
    },

    async meetingFolders(sourceMeetingId) {
        return localAvailable() ? localMeetingFolders(sourceMeetingId) : null;
    },

    // Checked 2026-11-04 on Wispr Flow's own surfaces: its MCP server lists 16 tools and all of them read
    // (list_folders, list_folder_meetings, ... none adds a meeting to a folder); its wispr-flow:// scheme routes only
    // open/<page>, start-hands-free, stop-hands-free, switch-mic and the auth, billing and LinkedIn callbacks. The
    // database belongs to the running app and is never written from here. Checked again 2026-11-05 on 1.6.1376: the
    // same 16 read tools; open/notetaker/shared/<share slug> opens one meeting's page, but no route files it in a
    // folder. Its public API only turns speech into text.
    folderWrite: {
        supported: false,
        reason: "Wispr Flow offers no folder write: its MCP tools only read, and its URL scheme only opens pages",
        manualStep: "In Wispr Flow open Notes (wispr-flow://open/notetaker), open the meeting and add it to the folder",
    },
};
