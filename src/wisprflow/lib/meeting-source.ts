import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingCalendar } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { readEvidence } from "./evidence";
import { importedMeetingFolder, importedMeetingRevision, importedSelfName, readImportedExport } from "./imported";
import {
    dictionaryCandidates,
    hasLocalMeeting,
    listLocalCalendar,
    listLocalFolders,
    listLocalMeetings,
    liveLocalMeeting,
    localAvailable,
    localMeetingFolders,
    localMeetingRevision,
    localSelfName,
    WISPR_DIR,
} from "./local";
import { loadMeeting } from "./source";
import type { Meeting, Sourced } from "./types";

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
 * The meeting's raw Wispr folder and the recording user's name: the app's own data when this Mac's database holds the
 * meeting, else an imported export, else the app's folder when the app is here (it may hold files without a row).
 */
function rawFolder(id: string): { folder: string; selfName?: string } | undefined {
    const local = () => ({ folder: join(WISPR_DIR, "meetings", id), selfName: localSelfName(id) });

    if (localAvailable() && hasLocalMeeting(id)) {
        return local();
    }

    const imported = readImportedExport(id);
    const folder = importedMeetingFolder(id);

    if (imported && folder) {
        return { folder, selfName: importedSelfName(imported.meeting) };
    }

    return localAvailable() ? local() : undefined;
}

function evidenceOf(id: string): MeetingEvidence | null {
    const raw = rawFolder(id);
    return raw ? readEvidence(raw.folder, raw.selfName) : null;
}

/**
 * The participants, with the recording user marked. Wispr knows the user as a person of the speaker map (origin
 * "self") even when no speaker is assigned to them, so the name may be missing from the speaker list.
 */
function participantsOf(meeting: Meeting, evidence: MeetingEvidence | null): SourceMeeting["participants"] {
    const self = evidence?.selfName;
    const roster = evidence?.participants ?? [];
    const people: SourceMeeting["participants"] = meeting.participants.map((person) => ({
        name: person.name,
        ...(person.isSelf || person.name === self ? { self: true } : {}),
        from: ["wisprflow"],
    }));
    const merged = mergeRoster(people, roster);
    return self && !merged.some((person) => person.name === self)
        ? [...merged, { name: self, self: true, from: ["wisprflow"] }]
        : merged;
}

/**
 * The platform roster folded into the speaker list by name. A roster row fills in what it knows, but never takes a
 * self marker away: the speaker map or the local self name set it, and a partial roster row may not carry the field.
 */
export function mergeRoster(
    people: SourceMeeting["participants"],
    roster: SourceMeeting["participants"]
): SourceMeeting["participants"] {
    const merged = people.map((person) => ({ ...person }));

    for (const person of roster) {
        const known = merged.find((one) => one.name === person.name);
        if (known) {
            Object.assign(known, person, {
                from: [...new Set([...known.from, ...person.from])],
                ...(known.self || person.self ? { self: true } : {}),
            });
        } else {
            merged.push(person);
        }
    }
    return merged;
}

function toSourceMeeting(loaded: Sourced<Meeting>): SourceMeeting {
    const meeting = loaded.data;
    const evidence = evidenceOf(meeting.id);
    // An imported meeting keeps the calendar event of the Mac that recorded it; this Mac's calendar may not have it.
    const calendar =
        (loaded.source === "imported" ? readImportedExport(meeting.id)?.calendar : undefined) ?? calendarFor(meeting);
    return {
        sourceMeetingId: meeting.id,
        title: meeting.title,
        start: meeting.start,
        ...(meeting.end ? { end: meeting.end } : {}),
        participants: participantsOf(meeting, evidence),
        observations: evidence?.speaking,
        speakers: meeting.participants,
        transcript: meeting.transcript,
        calendar,
        folders: meeting.folders.map((folder) => folder.name),
        ...(meeting.summary?.trim() ? { summary: meeting.summary } : {}),
        // An imported export was recorded on another Mac: its `self` is the person at that microphone.
        ...(loaded.source === "imported"
            ? { recordedBy: { owner: false as const, ...(evidence?.selfName ? { person: evidence.selfName } : {}) } }
            : {}),
    };
}

export const wisprflowSource: TranscriptSource = {
    id: "wisprflow",
    // The upload encoder interleaves mic.pcm as channel 0 and system.pcm as channel 1.
    sourceLayout: "left-mic",
    label: "Wispr Flow",

    async load(sourceMeetingId) {
        const loaded = await loadMeeting(sourceMeetingId, { source: "auto", transcript: true });
        log.debug({ id: sourceMeetingId, source: loaded.source, notes: loaded.notes }, "wisprflow meeting loaded");
        return toSourceMeeting(loaded);
    },

    async revision(sourceMeetingId) {
        // Only the local copy and an imported export have a cheap revision; a meeting the MCP answers is read again.
        return (
            (localAvailable() ? localMeetingRevision(sourceMeetingId) : undefined) ??
            importedMeetingRevision(sourceMeetingId) ??
            null
        );
    },

    describe(meeting) {
        return {
            meetingId: meeting.sourceMeetingId,
            folders: meeting.folders,
            ...(meeting.calendar?.eventId ? { calendarEventId: meeting.calendar.eventId } : {}),
            // Read from the import store (`tools wisprflow meetings import`), not this Mac's Wispr Flow.
            ...(meeting.recordedBy
                ? {
                      imported: {
                          from: "export",
                          ...(meeting.recordedBy.person ? { recordedBy: meeting.recordedBy.person } : {}),
                      },
                  }
                : {}),
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
        // The raw meeting folder exists only in the local app data or an imported export; the MCP keeps none of it.
        return evidenceOf(sourceMeetingId);
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

    async meetingsBetween(range) {
        // The app's local copy lists meetings without a network call; the MCP is not asked for a picker.
        if (!localAvailable()) {
            return null;
        }

        return listLocalMeetings({ since: range.from.toISOString(), until: range.to.toISOString(), limit: 50 }).map(
            (meeting) => ({
                sourceMeetingId: meeting.id,
                title: meeting.title,
                start: meeting.start,
                ...(meeting.end ? { end: meeting.end } : {}),
                hasTranscript: meeting.hasTranscript,
            })
        );
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
