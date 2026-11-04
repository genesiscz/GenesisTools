import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type EditProject, outputTimeOf, transcriptCachePath } from "@genesiscz/utils/recording-editor/project";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { listLibrary } from "./library";

const { log } = logger.scoped("recorder-moments");

/** The moments marked while it recorded, from its manifest, with where each plays in the edit (null when cut). */
export function markersOf(project: EditProject): Array<{ at: number; plays: number | null; label: string }> {
    const manifest = readRecordingManifest(dirname(project.source.video));
    const parsed = z
        .array(z.object({ atMs: z.number(), label: z.string() }))
        .safeParse(manifest?.settings.markers ?? []);

    if (!parsed.success) {
        log.debug({ issues: parsed.error.issues }, "the manifest's markers do not read");
        return [];
    }

    const round = (us: number) => Math.round(us / 1000) / 1000;
    return parsed.data.map((marker) => {
        const plays = outputTimeOf(project, marker.atMs * 1000);
        return { at: marker.atMs / 1000, plays: plays === undefined ? null : round(plays), label: marker.label };
    });
}

/** Case and accents ignored, as find() does. */
function folded(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

/** A moment across the library: titles, marker labels and the lines of transcripts already cached. */
export function searchLibrary(text: string) {
    const query = folded(text);
    const hits: Array<{
        recording: string;
        title: string;
        folder: string;
        kind: "title" | "marker" | "line";
        at: number;
        to?: number;
        text: string;
    }> = [];

    for (const row of listLibrary()) {
        const base = { recording: row.id, title: row.title, folder: row.folder };

        if (folded(row.title).includes(query)) {
            hits.push({ ...base, kind: "title", at: 0, text: row.title });
        }

        const markers = z
            .array(z.object({ atMs: z.number(), label: z.string() }))
            .safeParse(readRecordingManifest(row.folder)?.settings.markers ?? []);

        for (const marker of markers.success ? markers.data : []) {
            if (folded(marker.label).includes(query)) {
                hits.push({ ...base, kind: "marker", at: marker.atMs / 1000, text: marker.label });
            }
        }

        const cache = row.movie ? transcriptCachePath(row.movie) : undefined;

        if (!cache || !existsSync(cache)) {
            continue;
        }

        try {
            const raw = SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true });
            const segments = z
                .object({ segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) })
                .safeParse(raw);

            for (const segment of segments.success ? segments.data.segments : []) {
                if (folded(segment.text).includes(query)) {
                    hits.push({ ...base, kind: "line", at: segment.start, to: segment.end, text: segment.text.trim() });
                }
            }
        } catch (error) {
            log.debug({ error, cache }, "a cached transcript does not read; search skips it");
        }
    }

    log.debug({ text, hits: hits.length }, "library searched");
    return hits;
}
