import { formatLocalIso } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { callLogEventKey } from "./call-log";
import { decodeHtmlEntities } from "./html-to-text";
import { asRecord } from "./ingest-parse";
import type { TeamsCache } from "./store";
import type { AttendanceRow, CallLogEvent, ConversationRow, MeetingAttendance, MessageRow, Person } from "./types";

const log = logger.scoped("ms-teams").log;

/** A participant the observer's client listed this soon after its own join was already in the call. */
const PRESENT_AT_JOIN_MS = 2000;

export interface CallEndedRecord {
    callId: string;
    endedAt: number;
    startedAt: number | null;
    organizer: string | null;
    scheduledStart: number | null;
    scheduledEnd: number | null;
    participants: Array<{ id: string; name: string }>;
}

/** Parse the `Event/Call` `callEnded` system message that Teams posts into a meeting chat. */
export function parseCallEndedMessage(
    message: Pick<MessageRow, "html" | "originalArrivalTime">
): CallEndedRecord | null {
    const html = message.html ?? "";

    if (!html.includes("<ended/>") && tag(html, "callEventType") !== "callEnded") {
        return null;
    }

    const callId = tag(html, "callId")?.toLowerCase();

    if (!callId) {
        return null;
    }

    const participants: CallEndedRecord["participants"] = [];

    for (const match of html.matchAll(/<part identity="([^"]+)">([\s\S]*?)<\/part>/g)) {
        const id = decodeHtmlEntities(match[1]);
        participants.push({ id, name: tag(match[2], "displayName") ?? tag(match[2], "name") ?? id });
    }

    return {
        callId,
        endedAt: message.originalArrivalTime,
        startedAt: parseTeamsUtc(tag(html, "conversationStartTime")),
        organizer: tag(html, "organizerUpn"),
        scheduledStart: parseTeamsUtc(tag(html, "startTime")),
        scheduledEnd: parseTeamsUtc(tag(html, "endTime")),
        participants,
    };
}

/** `11/02/2026 14:00:00` is UTC in Teams call messages. */
export function parseTeamsUtc(value: string | null): number | null {
    const match = value?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);

    if (!match) {
        return null;
    }

    const [, month, day, year, hour, minute, second] = match.map(Number);

    return Date.UTC(year, month - 1, day, hour, minute, second);
}

interface Interval {
    mri: string;
    joinedAt: number;
    leftAt: number | null;
    joinedAtExact: boolean;
}

interface Observer {
    joinedAt: number | null;
    leftAt: number | null;
}

/** Each connection of the observer to the call: a rejoin after a disconnect is a session of its own. */
function observerSessions(events: CallLogEvent[]): Observer[] {
    const sessions: Observer[] = [];
    let current: Observer | undefined;

    for (const event of events) {
        if (event.kind !== "self-state") {
            continue;
        }

        if (event.state === "Connected" && !current) {
            current = { joinedAt: event.at, leftAt: null };
            sessions.push(current);
        }

        if ((event.state === "Disconnected" || event.state === "Disconnecting") && current) {
            current.leftAt = event.at;
            current = undefined;
        }
    }

    return sessions;
}

/** The observer's whole stay: its first join and the end of its last session. */
export function observerFromEvents(events: CallLogEvent[]): Observer {
    const sessions = observerSessions(events);
    return { joinedAt: sessions[0]?.joinedAt ?? null, leftAt: sessions.at(-1)?.leftAt ?? null };
}

/** Presence intervals of remote participants, from the observer's participant added and removed events. */
export function intervalsFromEvents(events: CallLogEvent[], observer: Observer): Interval[] {
    const open = new Map<string, Interval>();
    const closed: Interval[] = [];
    const firstAdd = events.find((e) => e.kind === "participant-added")?.at ?? null;
    const joinMark = observer.joinedAt ?? firstAdd;

    for (const event of events) {
        if (event.kind === "participant-added" && !open.has(event.mri)) {
            const presentAtJoin = joinMark !== null && event.at <= joinMark + PRESENT_AT_JOIN_MS;
            open.set(event.mri, { mri: event.mri, joinedAt: event.at, leftAt: null, joinedAtExact: !presentAtJoin });
        }

        if (event.kind === "participant-removed") {
            const interval = open.get(event.mri);

            if (interval) {
                interval.leftAt = event.at;
                closed.push(interval);
                open.delete(event.mri);
            }
        }
    }

    return [...closed, ...open.values()].sort((a, b) => a.joinedAt - b.joinedAt);
}

export interface BuildAttendanceOptions {
    cache: TeamsCache;
    conversation: ConversationRow;
    liveEvents: CallLogEvent[];
    callId?: string;
}

/** One attendance record per call of a meeting chat, newest first. */
export function buildMeetingAttendance(opts: BuildAttendanceOptions): MeetingAttendance[] {
    const { cache, conversation } = opts;
    const ended = new Map<string, CallEndedRecord>();

    for (const message of cache.listMessages(conversation.id, { includeSystem: true })) {
        if (message.messageType !== "Event/Call") {
            continue;
        }

        const record = parseCallEndedMessage(message);

        if (record) {
            ended.set(record.callId, record);
        }
    }

    const liveLinked = opts.liveEvents
        .filter((e) => e.kind === "thread-link" && e.threadId === conversation.id)
        .map((e) => e.callId);
    let callIds = [...new Set([...ended.keys(), ...cache.callIdsForThread(conversation.id), ...liveLinked])];

    if (opts.callId) {
        callIds = callIds.filter((id) => id === opts.callId?.toLowerCase());
    }

    const stored = cache.listCallLogEvents(callIds);
    const people = peopleIndex(cache, conversation);
    const selfMri = cache.getMeta("me_mri");
    const result = callIds.map((callId) => {
        const events = mergeEvents(
            stored.filter((e) => e.callId === callId),
            opts.liveEvents.filter((e) => e.callId === callId)
        );

        return attendanceForCall({ conversation, callId, ended: ended.get(callId) ?? null, events, people, selfMri });
    });

    log.debug({ conversation: conversation.id, calls: result.length }, "[ms-teams] built meeting attendance");

    return result.sort((a, b) => (b.meeting.endedAt ?? "~").localeCompare(a.meeting.endedAt ?? "~"));
}

function attendanceForCall(args: {
    conversation: ConversationRow;
    callId: string;
    ended: CallEndedRecord | null;
    events: CallLogEvent[];
    people: Map<string, Person>;
    selfMri: string | null;
}): MeetingAttendance {
    const { ended, events, people, selfMri } = args;
    const observer = observerFromEvents(events);
    const names = new Map<string, string>(ended?.participants.map((p) => [p.id, p.name]) ?? []);
    const person = (mri: string) => {
        const known = people.get(mri);
        const name = names.get(mri) ?? (known && known.displayName !== mri ? known.displayName : mri);

        return { name, email: known?.email ?? null, id: mri, self: mri === selfMri };
    };
    const rows: AttendanceRow[] = [];

    const sessions = observerSessions(events);

    for (const session of sessions) {
        if (selfMri && session.joinedAt !== null) {
            rows.push({
                ...person(selfMri),
                joinedAt: formatLocalIso(session.joinedAt),
                leftAt: session.leftAt === null ? null : formatLocalIso(session.leftAt),
                joinedAtExact: true,
                leftAtExact: session.leftAt !== null,
                source: "ms-teams:web-client-log",
            });
        }
    }

    // Remote events count inside the observer session that saw them; a person still listed when the observer left
    // leaves with that session, and is added again by the next one.
    for (const [index, session] of (sessions.length ? sessions : [observer]).entries()) {
        const previousEnd = sessions[index - 1]?.leftAt;
        const sessionEvents = events.filter(
            (event) =>
                (previousEnd == null || event.at > previousEnd) &&
                (session.joinedAt === null || event.at >= session.joinedAt - PRESENT_AT_JOIN_MS) &&
                (session.leftAt === null || event.at <= session.leftAt)
        );

        for (const interval of intervalsFromEvents(sessionEvents, session)) {
            const leftAt = interval.leftAt ?? session.leftAt;
            rows.push({
                ...person(interval.mri),
                joinedAt: formatLocalIso(interval.joinedAt),
                leftAt: leftAt === null ? null : formatLocalIso(leftAt),
                joinedAtExact: interval.joinedAtExact,
                leftAtExact: interval.leftAt !== null,
                source: "ms-teams:web-client-log",
            });
        }
    }

    const seen = new Set(rows.map((r) => r.id));

    for (const participant of ended?.participants ?? []) {
        if (!seen.has(participant.id)) {
            rows.push({
                ...person(participant.id),
                joinedAt: null,
                leftAt: null,
                joinedAtExact: false,
                leftAtExact: false,
                source: "ms-teams:call-ended-message",
            });
        }
    }

    const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : formatLocalIso(ms));

    return {
        provider: "ms-teams",
        meeting: {
            id: args.conversation.id,
            title: args.conversation.title,
            callId: args.callId,
            organizer: ended?.organizer ?? null,
            scheduledStart: iso(ended?.scheduledStart),
            scheduledEnd: iso(ended?.scheduledEnd),
            startedAt: iso(ended?.startedAt),
            endedAt: iso(ended?.endedAt),
        },
        observer: { id: selfMri, joinedAt: iso(observer.joinedAt), leftAt: iso(observer.leftAt) },
        attendance: rows,
    };
}

function mergeEvents(a: CallLogEvent[], b: CallLogEvent[]): CallLogEvent[] {
    const byKey = new Map<string, CallLogEvent>();

    for (const event of [...a, ...b]) {
        byKey.set(callLogEventKey(event), event);
    }

    return [...byKey.values()].sort((x, y) => x.at - y.at);
}

function peopleIndex(cache: TeamsCache, conversation: ConversationRow): Map<string, Person> {
    const index = new Map<string, Person>();

    for (const row of cache.listPeople()) {
        index.set(row.mri, { mri: row.mri, displayName: row.displayName, email: row.email ?? row.upn });
    }

    let members: unknown = [];

    try {
        members = SafeJSON.parse(conversation.membersJson, { strict: true });
    } catch (err) {
        log.debug({ err, conversation: conversation.id }, "[ms-teams] members_json is not JSON");
    }

    for (const raw of Array.isArray(members) ? members : []) {
        const member = asRecord(raw);
        const mri = typeof member?.mri === "string" ? member.mri : null;

        if (!member || !mri) {
            continue;
        }

        const known = index.get(mri);
        const email = typeof member.email === "string" ? member.email : null;
        const displayName = typeof member.displayName === "string" ? member.displayName : mri;
        index.set(mri, {
            mri,
            displayName: known && known.displayName !== known.mri ? known.displayName : displayName,
            email: known?.email ?? email,
        });
    }

    return index;
}

function tag(html: string, name: string): string | null {
    const match = html.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    const value = match ? decodeHtmlEntities(match[1]).trim() : "";

    return value || null;
}
