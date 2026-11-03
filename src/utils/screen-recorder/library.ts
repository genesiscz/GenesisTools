import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
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
            changePercent: z.number().default(0),
            reason: z.string().default("change"),
        })
    ),
    warnings: z.array(z.string()).default([]),
});
export type RecordingManifest = z.infer<typeof recordingManifestSchema>;

/** The manifest of a recording folder, or undefined when the folder holds none. */
export function readRecordingManifest(folder: string): RecordingManifest | undefined {
    const path = join(folder, RECORDING_MANIFEST);

    if (!existsSync(path)) {
        return undefined;
    }

    return recordingManifestSchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
}
