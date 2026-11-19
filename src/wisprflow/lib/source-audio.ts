import { Database } from "bun:sqlite";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type {
    LocalAudioFile,
    LocalAudioMeeting,
    LocalSourceAudio,
    SourceMeeting,
} from "@genesiscz/utils/meetings/sources";
import { importedStoreRoot, readImportedExport } from "./imported";
import { toIso, WISPR_DIR } from "./local";

const { log } = logger.scoped("wisprflow-source-audio");

interface AudioMetadataRow {
    id: string;
    title: string;
    createdAt: string;
    endedAt: number | null;
}

function missing(error: unknown): boolean {
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * A folder name that is not a valid escape (`source%old`) is skipped alone, so it cannot stop the whole scan. The
 * caller logs the skip; decodeURIComponent throws nothing but a URIError.
 */
function decodedName(name: string): string | undefined {
    try {
        return decodeURIComponent(name);
    } catch {
        return undefined;
    }
}

/** Directory inventory includes audio whose metadata has gone; those entries are reported as unmatched. */
export async function audioFilesIn(folder: string): Promise<LocalAudioFile[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
        if (missing(error)) {
            return [];
        }
        throw error;
    }
    const result: LocalAudioFile[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const path = join(folder, entry.name, "upload.ogg");
        const sourceMeetingId = decodedName(entry.name);
        if (sourceMeetingId === undefined) {
            log.warn({ folder, name: entry.name }, "audio folder name is not a valid escape; skipped");
            continue;
        }
        try {
            const file = await lstat(path);
            if (file.isFile() && file.size > 0) {
                result.push({ sourceMeetingId, path });
            }
        } catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }
    }
    return result.sort((a, b) => a.sourceMeetingId.localeCompare(b.sourceMeetingId));
}

function readMetadata<T>(dir: string, read: (db: Database) => T): T {
    const databasePath = join(dir, "flow.sqlite");
    let db: Database;
    try {
        // A plain path with `readonly`: a `file:…?mode=ro` URI is a literal file name to the SQLite Bun bundles on Linux
        // (src/utils/database/attach.ts), and `readonly` refuses a missing file just as `mode=ro` does.
        db = new Database(databasePath, { readonly: true });
    } catch (error) {
        // An absent provider is normal on machines where Wispr was never installed.
        log.debug({ error, path: databasePath }, "local audio metadata unavailable");
        throw error;
    }
    try {
        return read(db);
    } finally {
        db.close();
    }
}

function audioMeeting(row: AudioMetadataRow): LocalAudioMeeting {
    return {
        sourceMeetingId: row.id,
        title: row.title,
        start: toIso(row.createdAt),
        end: row.endedAt ? new Date(row.endedAt).toISOString() : undefined,
    };
}

/** One meeting's metadata by its id: a single-row read, so linking N recordings reads N rows, not N catalogs. */
export function localAudioMeeting(dir: string, id: string): LocalAudioMeeting | undefined {
    return readMetadata(dir, (db) => {
        const row = db
            .query<AudioMetadataRow, [string]>(
                "SELECT id, title, createdAt, endedAt FROM Meetings WHERE isDeleted = 0 AND id = ? LIMIT 1"
            )
            .get(id);
        return row ? audioMeeting(row) : undefined;
    });
}

function metadataOnly(meeting: LocalAudioMeeting): SourceMeeting {
    return { ...meeting, participants: [], speakers: [], transcript: [], folders: [] };
}

/** One meeting's metadata from this Mac's Wispr database; null when the app is absent or does not know the id. */
async function appMeeting(dir: string, id: string): Promise<SourceMeeting | null> {
    try {
        await lstat(join(dir, "flow.sqlite"));
    } catch (error) {
        // No Wispr on this machine (its audio folder can outlive the app): the file's meeting is unknown.
        if (missing(error)) {
            return null;
        }
        throw error;
    }
    const meeting = localAudioMeeting(dir, id);
    return meeting ? metadataOnly(meeting) : null;
}

/** One meeting's metadata from its imported export's meeting.json, never from flow.sqlite. */
function importedMeeting(id: string): SourceMeeting | null {
    const meeting = readImportedExport(id)?.meeting;
    return meeting
        ? metadataOnly({ sourceMeetingId: meeting.id, title: meeting.title, start: meeting.start, end: meeting.end })
        : null;
}

/**
 * The Wispr recordings on this Mac: the app's own meeting folders, and the exports imported with
 * `tools wisprflow meetings import` (laid out the same way, one folder per meeting). A meeting in both is the app's.
 */
export function wisprAudioAccess(options: { dir: string; importedRoot?: () => string }): LocalSourceAudio {
    const { dir, importedRoot = importedStoreRoot } = options;
    return {
        id: "wisprflow",
        files: async () => {
            const own = await audioFilesIn(join(dir, "meetings"));
            const ids = new Set(own.map((file) => file.sourceMeetingId));
            const imported = (await audioFilesIn(importedRoot())).filter((file) => !ids.has(file.sourceMeetingId));
            return [...own, ...imported].sort((a, b) => a.sourceMeetingId.localeCompare(b.sourceMeetingId));
        },
        legacyFiles: (meetingsRoot) => audioFilesIn(join(dirname(meetingsRoot), "meetings-audio-archive")),
        load: async (id) => (await appMeeting(dir, id)) ?? importedMeeting(id),
    };
}

export const wisprLocalAudio = wisprAudioAccess({ dir: WISPR_DIR });
