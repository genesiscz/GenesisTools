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
        try {
            const file = await lstat(path);
            if (file.isFile() && file.size > 0) {
                result.push({ sourceMeetingId: decodeURIComponent(entry.name), path });
            }
        } catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }
    }
    return result.sort((a, b) => a.sourceMeetingId.localeCompare(b.sourceMeetingId));
}

/** No list cap and no transcript/evidence read. SQLite is opened read-only, including during watcher discovery. */
export function localAudioCatalog(dir: string): LocalAudioMeeting[] {
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
        return db
            .query<AudioMetadataRow, []>(
                "SELECT id, title, createdAt, endedAt FROM Meetings WHERE isDeleted = 0 ORDER BY createdAt DESC"
            )
            .all()
            .map((row) => ({
                sourceMeetingId: row.id,
                title: row.title,
                start: toIso(row.createdAt),
                end: row.endedAt ? new Date(row.endedAt).toISOString() : undefined,
            }));
    } finally {
        db.close();
    }
}

export function wisprAudioAccess(dir: string): LocalSourceAudio {
    return {
        id: "wisprflow",
        files: () => audioFilesIn(join(dir, "meetings")),
        legacyFiles: (meetingsRoot) => audioFilesIn(join(dirname(meetingsRoot), "meetings-audio-archive")),
        catalog: async () => {
            try {
                await lstat(join(dir, "flow.sqlite"));
            } catch (error) {
                if (missing(error)) {
                    return [];
                }
                throw error;
            }
            return localAudioCatalog(dir);
        },
        load: async (id) => {
            const meeting = localAudioCatalog(dir).find((candidate) => candidate.sourceMeetingId === id);
            return meeting ? { ...meeting, participants: [], speakers: [], transcript: [], folders: [] } : null;
        },
    };
}

export const wisprLocalAudio = wisprAudioAccess(WISPR_DIR);
