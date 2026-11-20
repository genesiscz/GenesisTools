import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";

const { log } = logger.scoped("recording-exports");

/**
 * Which edit each whole export of a recording shows. Every route that writes a whole export records it here, beside
 * the recording's edit.json: `exportAs` in src/recorder/lib/edit.ts (the CLI, the REPL, the service, Copy Movie and
 * Copy as GIF, the window's GIF, WebM and cleaned-sound MP4) and the window's own MP4 export (EditorModel, through
 * ExportLedger in RecordingMovie.swift). A part of the edit is never recorded, so it is never handed out as the movie.
 */
export const EXPORT_LEDGER_FILE = "exports.json";

const ledgerSchema = z.object({
    version: z.literal(1),
    /** Keyed by the export's path: its file name inside the recording folder, else absolute. */
    files: z.record(
        z.string(),
        z.object({
            /** edit.json's revision the export rendered; null when the recording had no edit.json. */
            revision: z.number().int().nonnegative().nullable(),
            writtenAt: z.string(),
        })
    ),
});

export type ExportLedger = z.infer<typeof ledgerSchema>;

const EMPTY: ExportLedger = { version: 1, files: {} };

/** The ledger of a recording folder; empty when it has none or it cannot be read. */
export function readExportLedger(folder: string): ExportLedger {
    const path = join(folder, EXPORT_LEDGER_FILE);

    if (!existsSync(path)) {
        return EMPTY;
    }

    try {
        const parsed = ledgerSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));

        if (parsed.success) {
            return parsed.data;
        }

        log.warn({ path, issues: parsed.error.issues.length }, "the export ledger has an unknown shape; read as empty");
    } catch (error) {
        log.warn({ error, path }, "the export ledger could not be read; read as empty");
    }

    return EMPTY;
}

/** edit.json's revision in a recording folder; null when the recording has no edit. Reads only that field. */
export function editRevisionOf(folder: string): number | null {
    const path = join(folder, "edit.json");

    if (!existsSync(path)) {
        return null;
    }

    try {
        const value: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        const revision = z.object({ revision: z.number().int().nonnegative().default(0) }).safeParse(value);
        return revision.success ? revision.data.revision : 0;
    } catch (error) {
        log.warn({ error, path }, "edit.json could not be read for its revision");
        return 0;
    }
}

function ledgerKey(folder: string, file: string): string {
    const absolute = resolve(folder, file);
    return dirname(absolute) === resolve(folder) ? basename(absolute) : absolute;
}

/**
 * Records that `file` is a whole export of the edit at `revision`. Entries whose file is gone are dropped on the way,
 * so the ledger never grows past the exports that exist.
 */
export function recordExport({
    folder,
    file,
    revision,
    now = new Date(),
}: {
    folder: string;
    file: string;
    revision: number | null;
    now?: Date;
}): void {
    const ledger = readExportLedger(folder);
    const files: ExportLedger["files"] = {};

    for (const [key, entry] of Object.entries(ledger.files)) {
        if (existsSync(isAbsolute(key) ? key : join(folder, key))) {
            files[key] = entry;
        }
    }

    files[ledgerKey(folder, file)] = { revision, writtenAt: now.toISOString() };
    atomicWriteFileSync(join(folder, EXPORT_LEDGER_FILE), `${SafeJSON.stringify({ version: 1, files }, null, 2)}\n`);
    log.debug({ folder, file, revision }, "recorded an export");
}

/** What Copy Movie and a drag hand out for a recording folder. */
export type ShareableMovie =
    /** The newest export of the current edit, or the recording's own movie when it has no edit. */
    | { kind: "file"; path: string }
    /** The recording has an edit and no export shows it: export first. */
    | { kind: "stale"; revision: number; reason: string }
    /** No movie at all (a frames recording before its proxy). */
    | { kind: "none" };

/**
 * The one rule for the file a recording shares (Swift: RecordingMovie.shareable). The newest export whose recorded
 * revision equals edit.json's revision now; with no edit, the newest export of the unedited recording, else its own
 * movie. An edited recording without such an export is `stale`: handing out an older export or the unedited movie
 * would show parts the edit hides.
 */
export function shareableMovieOf({
    folder,
    ownMovie,
}: {
    folder: string;
    ownMovie: string | undefined;
}): ShareableMovie {
    const revision = editRevisionOf(folder);
    const current = Object.entries(readExportLedger(folder).files)
        .filter(([key, entry]) => entry.revision === revision && !key.includes(".partial."))
        .map(([key]) => (isAbsolute(key) ? key : join(folder, key)))
        .filter((path) => existsSync(path))
        .map((path) => ({ path, modified: statSync(path).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);

    if (current[0]) {
        return { kind: "file", path: current[0].path };
    }

    if (revision !== null) {
        return {
            kind: "stale",
            revision,
            reason: `the edit changed after its last export (no export shows revision ${revision})`,
        };
    }

    return ownMovie ? { kind: "file", path: ownMovie } : { kind: "none" };
}
