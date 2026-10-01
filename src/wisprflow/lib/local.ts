import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fillSpeakerMentions, resolveSpeakers, speakerLabel } from "./speakers";
import type { CalendarEvent, Folder, Meeting, MeetingSummary, ScratchpadNote, TranscriptEntry } from "./types";

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
function toIso(value: string): string {
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

/** The user's own edits to transcript lines, by entry id. The newest edit of an entry wins. */
function corrections(db: Database, meetingId: string): Map<string, string> {
    const rows = db
        .query<{ entryId: string; editedText: string }, [string]>(
            "SELECT entryId, editedText FROM TranscriptCorrections WHERE meetingId = ? ORDER BY updatedAt"
        )
        .all(meetingId);

    return new Map(rows.map((row) => [row.entryId, row.editedText]));
}

export function getLocalMeeting(id: string): Meeting | undefined {
    return withDb((db) => {
        const row = db.query<MeetingRow, [string]>("SELECT * FROM Meetings WHERE id = ?").get(id);

        if (!row) {
            return undefined;
        }

        const participants = resolveSpeakers(row.speakerMap);
        const edits = corrections(db, id);
        const transcript: TranscriptEntry[] = readRefined(id).map((line) => ({
            id: line.id,
            startSec: parseTimestamp(line.timestamp),
            speakerId: line.speaker?.id,
            speaker: speakerLabel(participants, line.speaker?.id),
            text: (line.id ? edits.get(line.id) : undefined) ?? line.text!.trim(),
        }));
        log.debug(
            { id, entries: transcript.length, corrections: edits.size, speakers: participants.length },
            "read local meeting"
        );

        return {
            ...toSummary(db, row),
            summary: fillSpeakerMentions(row.summary ?? "", participants),
            notes: fillSpeakerMentions(row.notes ?? "", participants),
            participants,
            transcript,
            speakerRenamePending: row.speakerMapPendingPush === 1,
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
                },
                [number, number, string]
            >(
                "SELECT externalId, title, startAtUtc, endAtUtc, conferenceUrl, participantNames FROM CalendarEvents WHERE startAtUtc >= ? AND startAtUtc < ? AND title LIKE ? AND status != 'cancelled' ORDER BY startAtUtc"
            )
            .all(filter.since, filter.until, `%${filter.query ?? ""}%`);

        return rows.map((row) => ({
            id: row.externalId,
            title: row.title,
            start: new Date(row.startAtUtc).toISOString(),
            end: new Date(row.endAtUtc).toISOString(),
            conferenceUrl: row.conferenceUrl ?? undefined,
            attendees: row.participantNames ? (SafeJSON.parse(row.participantNames, { strict: true }) as string[]) : [],
        }));
    });
}
