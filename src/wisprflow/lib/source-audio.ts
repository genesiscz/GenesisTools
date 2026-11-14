import { Database } from "bun:sqlite";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { LocalAudioFile, LocalAudioMeeting, LocalSourceAudio } from "@genesiscz/utils/meetings/sources";
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

/** A folder name that is not a valid escape (`source%old`) is skipped alone, so it cannot stop the whole scan. */
function decodedName(name: string): string | undefined {
    try {
        return decodeURIComponent(name);
    } catch (error) {
        if (error instanceof URIError) {
            return undefined;
        }
        throw error;
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
        db = new Database(`file:${databasePath}?mode=ro`, { readonly: true });
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

export function wisprAudioAccess(dir: string): LocalSourceAudio {
    return {
        id: "wisprflow",
        files: () => audioFilesIn(join(dir, "meetings")),
        legacyFiles: (meetingsRoot) => audioFilesIn(join(dirname(meetingsRoot), "meetings-audio-archive")),
        load: async (id) => {
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
            return meeting ? { ...meeting, participants: [], speakers: [], transcript: [], folders: [] } : null;
        },
    };
}

export const wisprLocalAudio = wisprAudioAccess(WISPR_DIR);
