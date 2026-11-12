import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

/** The recordings `startRecording` keeps: `<genesis-tools root>/recordings/library/<id>/`, beside `live/`. */
export function recordingsLibraryDir(...segments: string[]): string {
    return genesisToolsDir("recordings", "library", ...segments);
}

export const RECORDING_MANIFEST = "recording.json";

export const recordingManifestSchema = z.object({
    version: z.literal(1),
    id: z.string(),
    title: z.string(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    displays: z.array(z.object({ id: z.number(), name: z.string() })),
    settings: z.record(z.string(), z.unknown()).default({}),
    /** Each kept frame, in time order; `file` is relative to the recording's folder. */
    frames: z.array(
        z.object({
            file: z.string(),
            atMs: z.number().nonnegative(),
            displayId: z.number().optional(),
            focusedDisplayId: z.number().optional(),
            changePercent: z.number().default(0),
            reason: z.string().default("change"),
        })
    ),
    warnings: z.array(z.string()).default([]),
});
export type RecordingManifest = z.infer<typeof recordingManifestSchema>;

/**
 * One kept segment of a movie recording on the wall clock (`settings.video.spans` in recording.json): the movie's
 * `sourceStartMs` to `sourceStartMs + lengthMs` was captured from `firstFrameEpochMs` (epoch ms) on. What lies between
 * two spans (a pause, a rollover's re-arm, a retune, a switch) is in no movie, so a clock that kept running, the
 * camera's, lines up with the screen only through them. A manifest written before 2026-11-09 has none.
 */
export interface RecordingSpan {
    sourceStartMs: number;
    firstFrameEpochMs: number;
    lengthMs: number;
}

/**
 * A new movie recording's library id, `video-<local date>_<time>-<uuid>`: the library sorts its folders by the time in
 * the name, and `shortRecordingId` shortens it to the part before the uuid's second group.
 */
export function newVideoRecordingId(now = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `video-${stamp}-${randomUUID()}`;
}

/** Writes a recording's manifest whole: a `.partial` file renamed over it, so a reader never sees half of one. */
export async function writeRecordingManifest(folder: string, manifest: RecordingManifest): Promise<void> {
    const path = join(folder, RECORDING_MANIFEST);
    const partial = `${path}.partial`;
    await writeFile(partial, `${SafeJSON.stringify(manifest, null, 2)}\n`);
    await rename(partial, path);
}

/** The manifest of a recording folder, or undefined when the folder holds none. */
export function readRecordingManifest(folder: string): RecordingManifest | undefined {
    const path = join(folder, RECORDING_MANIFEST);

    if (!existsSync(path)) {
        return undefined;
    }

    return recordingManifestSchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
}

/**
 * The manifest of a recording folder without throwing, for readers of many folders (the library list, its search):
 * undefined when the folder holds none or the file is not a JSON object; `manifest` is missing when the schema
 * refuses the object (the app's own shape, an older or newer version), and `raw` then still carries its keys.
 */
export function readRecordingManifestSafe(
    folder: string
): { manifest?: RecordingManifest; raw: Record<string, unknown>; problem?: string } | undefined {
    const path = join(folder, RECORDING_MANIFEST);

    if (!existsSync(path)) {
        return undefined;
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    } catch {
        return undefined;
    }

    const object = z.record(z.string(), z.unknown()).safeParse(raw);

    if (!object.success) {
        return undefined;
    }

    const record = object.data;
    const parsed = recordingManifestSchema.safeParse(record);
    return parsed.success
        ? { manifest: parsed.data, raw: record }
        : {
              raw: record,
              problem: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          };
}

/**
 * Gives a recording a new title (what the library, the editor's window and `movies.list()` show). Only the title
 * changes: every other key of the manifest is written back as it was read.
 */
export function renameRecording(folder: string, title: string): RecordingManifest {
    const name = title.trim();

    if (!name || name.length > 120) {
        throw new RangeError("a title is 1 to 120 characters");
    }

    const path = join(folder, RECORDING_MANIFEST);

    if (!existsSync(path)) {
        throw new Error(`${folder} is not a recording: it has no ${RECORDING_MANIFEST}`);
    }

    const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    recordingManifestSchema.parse(raw);

    if (typeof raw !== "object" || raw === null) {
        throw new Error(`${path} does not hold a manifest object`);
    }

    const next = { ...raw, title: name };
    atomicWriteFileSync(path, SafeJSON.stringify(next, null, 2));
    return recordingManifestSchema.parse(next);
}
