import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type EditProject, outputTimeOf, transcriptCachePath } from "@genesiscz/utils/recording-editor/project";
import { RECORDING_MANIFEST, readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { listLibrary } from "./library";

const { log } = logger.scoped("recorder-moments");

/**
 * The recording folder an opened edit belongs to: the edit file's own folder when it holds a manifest (a copied
 * recording keeps its edit, whose movie may still point at the original), else the movie's folder; undefined for a
 * plain movie.
 */
export function recordingFolderOf(opened: { path: string; project: EditProject }): string | undefined {
    return [dirname(opened.path), dirname(opened.project.source.video)].find((folder) =>
        existsSync(join(folder, RECORDING_MANIFEST))
    );
}

/** The moments marked while it recorded, from its manifest, with where each plays in the edit (null when cut). */
export function markersOf(opened: {
    path: string;
    project: EditProject;
}): Array<{ at: number; plays: number | null; label: string }> {
    const { project } = opened;
    const folder = recordingFolderOf(opened);
    const manifest = folder ? readRecordingManifest(folder) : undefined;
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

/**
 * The markers as video chapters ("0:00 Intro" lines, the form YouTube and Vimeo read): each kept marker at its output
 * time, a first chapter at 0:00 when no marker sits there, and markers closer than `minSeconds` folded into the first.
 */
export function chaptersOf(
    markers: ReadonlyArray<{ plays: number | null; label: string }>,
    options: { intro?: string; minSeconds?: number } = {}
): string[] {
    const minSeconds = options.minSeconds ?? 10;
    const kept = markers
        .flatMap((marker) => (marker.plays === null ? [] : [{ at: marker.plays, label: marker.label }]))
        .sort((a, b) => a.at - b.at);
    const chapters: Array<{ at: number; label: string }> = [];

    for (const marker of kept) {
        const last = chapters.at(-1);

        if (marker.at < 1 && !last) {
            chapters.push({ at: 0, label: marker.label });
            continue;
        }

        if (!last) {
            chapters.push({ at: 0, label: options.intro ?? "Intro" });
        }

        const previous = chapters.at(-1);

        if (previous && marker.at - previous.at < minSeconds) {
            log.debug({ marker, previous }, "a marker too close to the chapter before it is left out");
            continue;
        }

        chapters.push(marker);
    }

    return chapters.map((chapter) => `${clock(chapter.at)} ${chapter.label}`);
}

/** 75.4 → "1:15", 3725 → "1:02:05". */
function clock(seconds: number): string {
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
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
