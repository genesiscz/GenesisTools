import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FileIdentity, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CalendarPerson } from "@genesiscz/utils/meetings/calendar-entry";
import { speakerLabel } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { completeTranscript, type LiveLine, parseLive } from "./live";
import { fillSpeakerMentions, resolveSpeakers, selfName } from "./speakers";
import type { CalendarEvent, Folder, Meeting, MeetingSummary, ScratchpadNote } from "./types";

const { log } = logger.scoped("wisprflow-local");

export const WISPR_DIR = join(homedir(), "Library", "Application Support", "Wispr Flow");
const DB_PATH = join(WISPR_DIR, "flow.sqlite");
const SHARE_BASE = "https://notes.wisprflow.ai/shared/";

export interface ListFilter {
    query?: string;
    since?: string;
    until?: string;
    folder?: string;
    limit?: number;
}

interface MeetingRow {
    id: string;
    title: string;
    createdAt: string;
    modifiedAt: string;
    endedAt: number | null;
    summary: string | null;
    notes: string | null;
    speakerMap: string | null;
    speakerMapPendingPush: number;
    shareSlug: string | null;
    isDeleted: number;
}

interface RefinedLine {
    id?: string;
    timestamp?: string;
    text?: string;
    speaker?: { id?: number };
}

export function localAvailable(): boolean {
    return existsSync(DB_PATH);
}

/** Read-only: the app keeps the database open and writes to it while we read. */
function openDb(): Database {
    log.debug({ path: DB_PATH }, "opening Wispr Flow database read-only");
    return new Database(`file:${DB_PATH}?mode=ro`, { readonly: true });
}

function withDb<T>(fn: (db: Database) => T): T {
    const db = openDb();

    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** Sequelize stores `2026-09-30 14:06:54.482 +00:00`; everything else in this tool speaks ISO. */
export function toIso(value: string): string {
    const parsed = new Date(value.replace(" +00:00", "Z").replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function foldersFor(db: Database, meetingId: string): Folder[] {
    return db
        .query<Folder, [string]>(
            "SELECT f.id, f.name FROM FolderMeetings fm JOIN Folders f ON f.id = fm.folderId WHERE fm.meetingId = ? ORDER BY f.name"
        )
        .all(meetingId);
}

function toSummary(db: Database, row: MeetingRow): MeetingSummary {
    return {
        id: row.id,
        title: row.title,
        start: toIso(row.createdAt),
        end: row.endedAt ? new Date(row.endedAt).toISOString() : undefined,
        modifiedAt: toIso(row.modifiedAt),
        hasTranscript: existsSync(join(WISPR_DIR, "meetings", row.id, "refined.ndjson")),
        shareLink: row.shareSlug ? `${SHARE_BASE}${row.shareSlug}` : undefined,
        folders: foldersFor(db, row.id),
        excerpt: row.summary
            ? fillSpeakerMentions(row.summary, resolveSpeakers(row.speakerMap)).slice(0, 280)
            : undefined,
    };
}

export function listLocalMeetings(filter: ListFilter): MeetingSummary[] {
    return withDb((db) => {
        const where = ["isDeleted = 0"];
        const params: string[] = [];

        if (filter.query) {
            where.push("(title LIKE ? OR summary LIKE ? OR notes LIKE ?)");
            const like = `%${filter.query}%`;
            params.push(like, like, like);
        }

        if (filter.since) {
            where.push("createdAt >= ?");
            params.push(sqliteTime(filter.since));
        }

        if (filter.until) {
            where.push("createdAt < ?");
            params.push(sqliteTime(filter.until));
        }

        if (filter.folder) {
            where.push(
                "id IN (SELECT fm.meetingId FROM FolderMeetings fm JOIN Folders f ON f.id = fm.folderId WHERE f.name LIKE ?)"
            );
            params.push(`%${filter.folder}%`);
        }

        const sql = `SELECT * FROM Meetings WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT ?`;
        const rows = db.query<MeetingRow, (string | number)[]>(sql).all(...params, rowLimit(filter.limit));
        log.debug({ count: rows.length, filter }, "listed local meetings");

        return rows.map((row) => toSummary(db, row));
    });
}

/** The database compares times as text in its own format, so a filter must be written the same way. */
function sqliteTime(iso: string): string {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        throw new Error(`not a date: ${iso}`);
    }

    return `${date.toISOString().replace("T", " ").replace("Z", "")} +00:00`;
}

/** "67:12" or "1:07:12" into seconds. */
export function parseTimestamp(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const parts = value.split(":").map(Number);

    if (parts.some((n) => Number.isNaN(n))) {
        return undefined;
    }

    return parts.reduce((total, part) => total * 60 + part, 0);
}

function readRefined(meetingId: string): RefinedLine[] {
    const path = join(WISPR_DIR, "meetings", meetingId, "refined.ndjson");

    if (!existsSync(path)) {
        log.debug({ path }, "no refined transcript on disk");
        return [];
    }

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines.map((line) => SafeJSON.parse(line, { strict: true }) as RefinedLine).filter((line) => line.text);
}

function readLive(meetingId: string): LiveLine[] {
    const path = join(WISPR_DIR, "meetings", meetingId, "live.ndjson");

    if (!existsSync(path)) {
        return [];
    }

    // The live file only completes a refined transcript; a broken one must not hide the whole meeting.
    try {
        return parseLive(readFileSync(path, "utf8"));
    } catch (err) {
        log.warn({ err, path }, "live transcript unreadable, using the refined transcript only");
        return [];
    }
}

/** The user's own edits to transcript lines, by entry id. The newest edit of an entry wins. */
function corrections(db: Database, meetingId: string): Map<string, string> {
    const rows = db
        .query<{ entryId: string; editedText: string }, [string]>(
            "SELECT entryId, editedText FROM TranscriptCorrections WHERE meetingId = ? ORDER BY updatedAt"
        )
        .all(meetingId);

    return new Map(rows.map((row) => [row.entryId, row.editedText]));
}

/** Whether this Mac's Wispr Flow database holds the meeting: one indexed lookup, no transcript read. */
export function hasLocalMeeting(id: string): boolean {
    return (
        withDb((db) => db.query<{ one: number }, [string]>("SELECT 1 AS one FROM Meetings WHERE id = ?").get(id)) !==
        null
    );
}

/**
 * What `getLocalMeeting` reads for one meeting, as a token: the whole row, its folders, the count and newest time of the
 * user's corrections, and the identity of both transcript files. Undefined when the meeting is not on this Mac.
 */
export function localMeetingRevision(id: string): string | undefined {
    return withDb((db) => {
        const row = db.query<MeetingRow, [string]>("SELECT * FROM Meetings WHERE id = ?").get(id);

        if (!row) {
            return undefined;
        }

        const folders = db
            .query<{ folderId: string }, [string]>(
                "SELECT folderId FROM FolderMeetings WHERE meetingId = ? ORDER BY folderId"
            )
            .all(id);
        const edits = db
            .query<{ n: number; last: string | null }, [string]>(
                "SELECT count(*) AS n, max(updatedAt) AS last FROM TranscriptCorrections WHERE meetingId = ?"
            )
            .get(id);
        const files = ["refined.ndjson", "live.ndjson"].map((name) =>
            fileIdentity(join(WISPR_DIR, "meetings", id, name))
        );
        return Bun.hash(SafeJSON.stringify([row, folders, edits, files])).toString(36);
    });
}

export function getLocalMeeting(id: string): Meeting | undefined {
    return withDb((db) => {
        const row = db.query<MeetingRow, [string]>("SELECT * FROM Meetings WHERE id = ?").get(id);

        if (!row) {
            return undefined;
        }

        const participants = resolveSpeakers(row.speakerMap);
        const edits = corrections(db, id);
        const refined: TranscriptEntry[] = readRefined(id).map((line) => ({
            id: line.id,
            startSec: parseTimestamp(line.timestamp),
            speakerId: line.speaker?.id,
            speaker: speakerLabel(participants, line.speaker?.id),
            text: (line.id ? edits.get(line.id) : undefined) ?? line.text!.trim(),
        }));
        const { transcript, gap } = completeTranscript(refined, readLive(id), participants);
        log.debug(
            { id, entries: transcript.length, corrections: edits.size, speakers: participants.length, gap },
            "read local meeting"
        );

        return {
            ...toSummary(db, row),
            summary: fillSpeakerMentions(row.summary ?? "", participants),
            notes: fillSpeakerMentions(row.notes ?? "", participants),
            participants,
            transcript,
            speakerRenamePending: row.speakerMapPendingPush === 1,
            transcriptGap: gap,
        };
    });
}

export function localMeetingIdForShareSlug(slug: string): string | undefined {
    return withDb(
        (db) => db.query<{ id: string }, [string]>("SELECT id FROM Meetings WHERE shareSlug = ?").get(slug)?.id
    );
}

/** Meetings whose speaker rename is only on this Mac. */
export function pendingSpeakerRenames(): Array<{ id: string; title: string }> {
    return withDb((db) =>
        db
            .query<{ id: string; title: string }, []>(
                "SELECT id, title FROM Meetings WHERE speakerMapPendingPush = 1 AND isDeleted = 0"
            )
            .all()
    );
}

/** One row of the app's dictionary. */
export interface DictionaryRow {
    phrase: string;
    replacement?: string;
    uses: number;
    manual: boolean;
    snippet: boolean;
    lastUsed?: string;
}

/** The app's dictionary, most used first. Snippets are text expansions, not spellings; `withSnippets` includes them. */
export function dictionaryRows(options: { withSnippets?: boolean } = {}): DictionaryRow[] {
    return withDb((db) =>
        db
            .query<
                {
                    phrase: string;
                    replacement: string | null;
                    frequencyUsed: number | null;
                    manualEntry: number | null;
                    isSnippet: number | null;
                    lastUsed: string | null;
                },
                []
            >(
                "SELECT phrase, replacement, frequencyUsed, manualEntry, isSnippet, lastUsed FROM Dictionary WHERE isDeleted = 0"
            )
            .all()
            .filter((row) => options.withSnippets || row.isSnippet !== 1)
            .map((row) => ({
                phrase: row.phrase,
                ...(row.replacement ? { replacement: row.replacement } : {}),
                uses: row.frequencyUsed ?? 0,
                manual: row.manualEntry === 1,
                snippet: row.isSnippet === 1,
                ...(row.lastUsed ? { lastUsed: toIso(row.lastUsed) } : {}),
            }))
            .sort((x, y) => y.uses - x.uses)
    );
}

/** The app's dictionary rows, with the replacement when the row has one. */
export function dictionaryCandidates(): Array<{ value: string; replacement?: string }> {
    return dictionaryRows().map((row) => ({
        value: row.phrase,
        ...(row.replacement ? { replacement: row.replacement } : {}),
    }));
}

/** The recording user's name in one meeting's speaker map. */
export function localSelfName(id: string): string | undefined {
    return withDb((db) => {
        const row = db
            .query<{ speakerMap: string | null }, [string]>("SELECT speakerMap FROM Meetings WHERE id = ?")
            .get(id);
        return selfName(row?.speakerMap);
    });
}

/** The newest meeting the app has not ended: the one it is recording now, if any. */
/**
 * The meeting Wispr Flow records now: one it has not ended, or the newest one whose live transcript says it resumed
 * after its end. Wispr writes `endedAt` when a recording stops and keeps it through a resume (2026-11-09: ended 14:45,
 * resumed 14:49, recorded to 16:58 with the old `endedAt` until the final stop), so `endedAt` alone ended the screen
 * recording two hours early.
 */
export function liveLocalMeeting(): { id: string; title: string; start: string } | undefined {
    return withDb((db) => {
        const open = db
            .query<{ id: string; title: string; createdAt: string }, []>(
                "SELECT id, title, createdAt FROM Meetings WHERE endedAt IS NULL AND isDeleted = 0 ORDER BY createdAt DESC LIMIT 1"
            )
            .get();

        if (open) {
            return { id: open.id, title: open.title, start: toIso(open.createdAt) };
        }

        const newest = db
            .query<{ id: string; title: string; createdAt: string; endedAt: number | string | null }, []>(
                "SELECT id, title, createdAt, endedAt FROM Meetings WHERE isDeleted = 0 ORDER BY createdAt DESC LIMIT 1"
            )
            .get();
        const endedMs = newest?.endedAt === null || newest?.endedAt === undefined ? NaN : Number(newest.endedAt);

        if (!newest || !Number.isFinite(endedMs)) {
            return undefined;
        }

        const marker = lastLiveMarker(newest.id);

        if (marker?.marker !== "resumed" || marker.epochMs <= endedMs) {
            return undefined;
        }

        log.debug(
            { meeting: newest.id, endedMs, resumedMs: marker.epochMs },
            "a resumed meeting is live despite its endedAt"
        );
        return { id: newest.id, title: newest.title, start: toIso(newest.createdAt) };
    });
}

interface LiveMarker {
    marker: string;
    epochMs: number;
}

/** A live transcript line as read before its fields are checked. */
interface UncheckedMarkerLine {
    marker?: unknown;
    epochMs?: unknown;
}

/** What the last read of a live transcript left, so the next poll reads only what Wispr Flow appended since. */
interface MarkerScan {
    /** The file as it was read: a poll that finds it the same answers `marker` without a read. */
    identity: FileIdentity;
    /** Where the last complete line read ends (just after its newline). */
    end: number;
    /** The bytes just before `end`, at most `MARKER_TAIL_BYTES`: a file rewritten in place no longer holds them there. */
    tail: Buffer;
    /** The last marker of the complete lines before `end`. */
    complete: LiveMarker | null;
    /** What the poll answered: a marker on the unfinished last line, else `complete`. */
    marker: LiveMarker | null;
}

const markerScans = new Map<string, MarkerScan>();
const MARKER_CHUNK_BYTES = 64 * 1024;
const MARKER_TAIL_BYTES = 64;
const NEWLINE = 0x0a;

function markerOfLine(line: string, path: string): LiveMarker | null {
    if (!line.includes('"marker"')) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(line, { strict: true }) as UncheckedMarkerLine;

        if (typeof parsed.marker === "string" && typeof parsed.epochMs === "number") {
            return { marker: parsed.marker, epochMs: parsed.epochMs };
        }
    } catch (err) {
        log.debug({ err, path }, "a live transcript line with a marker is not JSON");
    }

    return null;
}

/** Bytes `start` to `end` of the open file (fewer when it ends sooner). */
function readRange(fd: number, start: number, end: number): Buffer {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let done = 0;

    while (done < buffer.length) {
        const read = readSync(fd, buffer, done, buffer.length - done, start + done);

        if (read === 0) {
            break;
        }

        done += read;
    }

    return buffer.subarray(0, done);
}

/** Just after the last newline between `from` and `size`, read from the end; `from` when there is none. */
function lastLineEnd(fd: number, from: number, size: number): number {
    for (let position = size; position > from; ) {
        const start = Math.max(from, position - MARKER_CHUNK_BYTES);
        const at = readRange(fd, start, position).lastIndexOf(NEWLINE);

        if (at >= 0) {
            return start + at + 1;
        }

        position = start;
    }

    return from;
}

/**
 * The last marker of the complete lines between `from` (a line start) and `end` (a line end), read backwards in
 * chunks until one turns up, so a marker near the end costs one chunk however long the call ran.
 */
function lastMarkerBetween(fd: number, from: number, end: number, path: string): LiveMarker | null {
    // The start of a line whose beginning lies in an earlier chunk.
    let carry = Buffer.alloc(0);

    for (let position = end; position > from; ) {
        const start = Math.max(from, position - MARKER_CHUNK_BYTES);
        const chunk = Buffer.concat([readRange(fd, start, position), carry]);
        position = start;
        // Above `from` a chunk can start inside a line: the bytes up to its first newline wait for the chunk before.
        const cut = position > from ? chunk.indexOf(NEWLINE) + 1 : 0;

        if (position > from && cut === 0) {
            carry = chunk;
            continue;
        }

        const lines = chunk.subarray(cut).toString("utf8").split("\n");

        for (let index = lines.length - 1; index >= 0; index--) {
            const marker = markerOfLine(lines[index] ?? "", path);

            if (marker) {
                return marker;
            }
        }

        carry = chunk.subarray(0, cut);
    }

    return null;
}

/**
 * Reads what changed since `scan`. An append keeps the inode and the bytes before the last line end, so only the new
 * lines are read; a truncated, replaced or rewritten file is read again from its end backwards.
 */
function rescanMarkers(fd: number, identity: FileIdentity, path: string, scan: MarkerScan | undefined): MarkerScan {
    const kept =
        scan &&
        scan.identity.ino === identity.ino &&
        identity.size >= scan.end &&
        readRange(fd, scan.end - scan.tail.length, scan.end).equals(scan.tail)
            ? scan
            : undefined;
    const from = kept?.end ?? 0;
    const end = lastLineEnd(fd, from, identity.size);
    const complete = lastMarkerBetween(fd, from, end, path) ?? kept?.complete ?? null;
    // The last line can still be unfinished; a whole JSON line without its newline counts, and is read again next time.
    const unfinished = markerOfLine(readRange(fd, end, identity.size).toString("utf8"), path);

    return {
        identity,
        end,
        tail: readRange(fd, Math.max(0, end - MARKER_TAIL_BYTES), end),
        complete,
        marker: unfinished ?? complete,
    };
}

/**
 * The last `paused` / `resumed` marker of a meeting's live transcript. A poll reads nothing when the file did not
 * change, and only the appended lines while Wispr Flow records (`MarkerScan`).
 */
export function lastLiveMarker(meetingId: string, dir = WISPR_DIR): LiveMarker | null {
    const path = join(dir, "meetings", meetingId, "live.ndjson");
    const identity = fileIdentity(path);

    if (!identity) {
        markerScans.delete(path);
        return null;
    }

    const scan = markerScans.get(path);

    if (
        scan &&
        scan.identity.ino === identity.ino &&
        scan.identity.size === identity.size &&
        scan.identity.mtimeMs === identity.mtimeMs
    ) {
        return scan.marker;
    }

    let fd: number | undefined;

    // Wispr Flow writes the file while it records: it can go between the stat and the read. No marker, and nothing
    // kept, so the next poll reads it again.
    try {
        fd = openSync(path, "r");
        const next = rescanMarkers(fd, identity, path, scan);
        markerScans.set(path, next);
        return next.marker;
    } catch (err) {
        markerScans.delete(path);
        log.warn({ err, path }, "the live transcript could not be read; no marker this time");
        return null;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

/** The user's Wispr Flow dictionary: words the app was taught to spell. */
export function dictionaryPhrases(): string[] {
    return withDb((db) =>
        db
            .query<{ phrase: string; replacement: string | null }, []>(
                "SELECT phrase, replacement FROM Dictionary WHERE isDeleted = 0 AND isSnippet = 0"
            )
            .all()
            .map((row) => row.replacement ?? row.phrase)
    );
}

/** A bound row limit: a positive integer, else the default 25 (`--limit abc` must not reach the SQL). */
function rowLimit(limit: number | undefined): number {
    return limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : 25;
}

export function listLocalNotes(query?: string, limit = 25): ScratchpadNote[] {
    return withDb((db) => {
        const like = `%${query ?? ""}%`;
        const rows = db
            .query<{ id: string; title: string; modifiedAt: string; contentPreview: string }, [string, string, number]>(
                "SELECT id, title, modifiedAt, contentPreview FROM Notes WHERE isDeleted = 0 AND (title LIKE ? OR searchableContent LIKE ?) ORDER BY modifiedAt DESC LIMIT ?"
            )
            .all(like, like, rowLimit(limit));

        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            modifiedAt: toIso(row.modifiedAt),
            excerpt: row.contentPreview.slice(0, 200),
        }));
    });
}

export function getLocalNote(id: string): ScratchpadNote | undefined {
    return withDb((db) => {
        const row = db
            .query<{ id: string; title: string; modifiedAt: string; searchableContent: string | null }, [string]>(
                "SELECT id, title, modifiedAt, searchableContent FROM Notes WHERE id = ?"
            )
            .get(id);

        if (!row) {
            return undefined;
        }

        return {
            id: row.id,
            title: row.title,
            modifiedAt: toIso(row.modifiedAt),
            content: row.searchableContent ?? "",
        };
    });
}

export function listLocalCalendar(filter: { since: number; until: number; query?: string }): CalendarEvent[] {
    return withDb((db) => {
        const rows = db
            .query<
                {
                    externalId: string;
                    title: string;
                    startAtUtc: number;
                    endAtUtc: number;
                    conferenceUrl: string | null;
                    participantNames: string | null;
                    participants: string | null;
                },
                [number, number, string]
            >(
                "SELECT externalId, title, startAtUtc, endAtUtc, conferenceUrl, participantNames, participants FROM CalendarEvents WHERE startAtUtc >= ? AND startAtUtc < ? AND title LIKE ? AND status != 'cancelled' ORDER BY startAtUtc"
            )
            .all(filter.since, filter.until, `%${filter.query ?? ""}%`);

        return rows.map((row) => ({
            id: row.externalId,
            title: row.title,
            start: new Date(row.startAtUtc).toISOString(),
            end: new Date(row.endAtUtc).toISOString(),
            conferenceUrl: row.conferenceUrl ?? undefined,
            attendees: row.participantNames ? (SafeJSON.parse(row.participantNames, { strict: true }) as string[]) : [],
            people: calendarPeople(row.participants),
        }));
    });
}

/** The `participants` column: `[{ name, email, isSelf }]`. A row the app wrote in another shape gives no people. */
function calendarPeople(raw: string | null): CalendarPerson[] {
    if (!raw) {
        return [];
    }

    const parsed: unknown = SafeJSON.parse(raw, { strict: true });

    if (!Array.isArray(parsed)) {
        log.debug({ raw: raw.slice(0, 80) }, "calendar participants are not a list");
        return [];
    }

    return parsed.flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string" || !item.name) {
            return [];
        }

        const email = "email" in item && typeof item.email === "string" && item.email ? item.email : undefined;
        const self = "isSelf" in item && item.isSelf === true;
        return [{ name: item.name, ...(email ? { email } : {}), ...(self ? { self: true } : {}) }];
    });
}

/** Every Wispr Flow folder's name, the owner's and the shared ones. */
export function listLocalFolders(): string[] {
    return withDb((db) => db.query<{ name: string }, []>("SELECT name FROM Folders ORDER BY name").all()).map(
        (row) => row.name
    );
}

/** The folders one meeting is in now. */
export function localMeetingFolders(meetingId: string): string[] {
    return withDb((db) => foldersFor(db, meetingId)).map((folder) => folder.name);
}
