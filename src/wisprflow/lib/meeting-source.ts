import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingCalendar } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { dictionaryCandidates, listLocalCalendar, liveLocalMeeting, localAvailable, WISPR_DIR } from "./local";
import { loadMeeting } from "./source";
import type { Meeting } from "./types";

const { log } = logger.scoped("wisprflow-meeting-source");

/** A calendar event counts as this meeting's when it starts this close to the recording. */
const CALENDAR_WITHIN_MS = 15 * 60_000;

function calendarFor(meeting: Meeting): MeetingCalendar | undefined {
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

function toSourceMeeting(meeting: Meeting): SourceMeeting {
    return {
        sourceMeetingId: meeting.id,
        title: meeting.title,
        start: meeting.start,
        ...(meeting.end ? { end: meeting.end } : {}),
        participants: meeting.participants.map((person) => ({
            name: person.name,
            ...(person.isSelf ? { self: true } : {}),
            from: ["wisprflow"],
        })),
        speakers: meeting.participants,
        transcript: meeting.transcript,
        calendar: calendarFor(meeting),
        folders: meeting.folders.map((folder) => folder.name),
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
};
