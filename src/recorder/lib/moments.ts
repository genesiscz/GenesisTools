import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    CLICK_GROUP_GAP_MS,
    type EditProject,
    groupClicks,
    outputTimeOf,
    projectPathFor,
    readCursorTrack,
    readProject,
    transcriptCachePath,
    transcriptLines,
} from "@genesiscz/utils/recording-editor/project";
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

/** The markers set while it recorded, from its manifest (none for a plain movie or a manifest that does not read). */
export function recordedMarkersOf(opened: {
    path: string;
    project: EditProject;
}): Array<{ atMs: number; label: string }> {
    const folder = recordingFolderOf(opened);
    const manifest = folder ? readRecordingManifest(folder) : undefined;
    const parsed = z
        .array(z.object({ atMs: z.number(), label: z.string() }))
        .safeParse(manifest?.settings.markers ?? []);

    if (!parsed.success) {
        log.debug({ issues: parsed.error.issues }, "the manifest's markers do not read");
    }

    return parsed.success ? parsed.data : [];
}

/**
 * The moments marked while it recorded (its manifest) and while it was edited (the edit's `markers`, with their `id`
 * for the `unmarker` op), in time order, with where each plays in the edit (null when cut).
 */
export function markersOf(opened: {
    path: string;
    project: EditProject;
}): Array<{ at: number; plays: number | null; label: string; id?: string }> {
    const { project } = opened;
    const round = (us: number) => Math.round(us / 1000) / 1000;
    const played = (us: number) => {
        const plays = outputTimeOf(project, us);
        return plays === undefined ? null : round(plays);
    };
    const recorded = recordedMarkersOf(opened).map((marker) => ({
        at: marker.atMs / 1000,
        plays: played(marker.atMs * 1000),
        label: marker.label,
    }));
    const edited = (project.markers ?? []).map((marker) => ({
        at: marker.atUs / 1_000_000,
        plays: played(marker.atUs),
        label: marker.label,
        id: marker.id,
    }));
    return [...recorded, ...edited].sort((a, b) => a.at - b.at);
}

/** One group of clicks: source seconds, how many, where it plays (its first and last click not cut) and how many a cut hides. */
export interface ClickGroup {
    from: number;
    to: number;
    count: number;
    /** OUTPUT seconds of its first and last click that still play; null when a cut hides every click of it. */
    plays: { from: number; to: number } | null;
    /** How many of its clicks fall in cut time. */
    cut: number;
}

/**
 * The movie's recorded clicks grouped as autoZoom groups them (a click under `gapSeconds`, default 3, after the one
 * before joins its group), in time order. A movie without a cursor track has no clicks to read: that throws, so it
 * never reads as "no clicks".
 */
export function clickGroupsOf(project: EditProject, options: { gapSeconds?: number } = {}): ClickGroup[] {
    const track = project.source.cursor;

    if (!track || !existsSync(track)) {
        throw new Error("this movie has no cursor track, so there are no clicks to read");
    }

    const round = (us: number) => Math.round(us / 1000) / 1000;
    const gapMs = options.gapSeconds === undefined ? CLICK_GROUP_GAP_MS : options.gapSeconds * 1000;
    return groupClicks(readCursorTrack(track), gapMs).map((group) => {
        const played = group.flatMap((click) => {
            const plays = outputTimeOf(project, Math.round(click.ms * 1000));
            return plays === undefined ? [] : [round(plays)];
        });
        return {
            from: (group[0]?.ms ?? 0) / 1000,
            to: (group.at(-1)?.ms ?? 0) / 1000,
            count: group.length,
            plays: played.length ? { from: played[0] ?? 0, to: played.at(-1) ?? 0 } : null,
            cut: group.length - played.length,
        };
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
    return chapterPoints(markers, options).map((chapter) => `${clock(chapter.at)} ${chapter.label}`);
}

/** The chapters as output seconds and labels, by the rules of chaptersOf. */
export function chapterPoints(
    markers: ReadonlyArray<{ plays: number | null; label: string }>,
    options: { intro?: string; minSeconds?: number } = {}
): Array<{ at: number; label: string }> {
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

    return chapters;
}

/**
 * The chapters of an exported part (output seconds of the whole edit): the chapter the part starts in begins at 0,
 * the ones inside it move with it, and the ones after it go.
 */
export function chaptersOfPart(
    chapters: ReadonlyArray<{ at: number; label: string }>,
    part: { from: number; to: number }
): Array<{ at: number; label: string }> {
    const current = chapters.filter((chapter) => chapter.at <= part.from).at(-1);
    const inside = chapters
        .filter((chapter) => chapter.at > part.from && chapter.at < part.to)
        .map((chapter) => ({ at: chapter.at - part.from, label: chapter.label }));
    return [...(current ? [{ at: 0, label: current.label }] : []), ...inside];
}

/** The ffmpeg metadata file that puts chapters into a movie, each running to the next one or the end. */
export function chapterMetadata(
    chapters: ReadonlyArray<{ at: number; label: string }>,
    durationSeconds: number
): string {
    const escaped = (text: string) => text.replace(/[=;#\\\n]/g, (char) => `\\${char}`);
    const blocks = chapters.map((chapter, index) => {
        const end = chapters[index + 1]?.at ?? durationSeconds;
        return [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            `START=${Math.round(chapter.at * 1000)}`,
            `END=${Math.round(end * 1000)}`,
            `title=${escaped(chapter.label)}`,
        ].join("\n");
    });
    return `;FFMETADATA1\n${blocks.join("\n")}\n`;
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
            // Through the edit when there is one, so a corrected line is found by its fixed words.
            const edit = row.movie ? projectPathFor(row.movie) : undefined;
            const project = edit && existsSync(edit) ? readProject(edit) : undefined;
            const lines = project
                ? transcriptLines(raw, project).map((line) => ({ start: line.from, end: line.to, text: line.text }))
                : z
                      .object({ segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) })
                      .parse(raw).segments;

            for (const segment of lines) {
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

/** `count` moments spread evenly over a range, each at the middle of its share, so none falls on a cut at an end. */
export function spreadTimes({ fromUs, toUs, count }: { fromUs: number; toUs: number; count: number }): number[] {
    const step = Math.max(0, toUs - fromUs) / count;
    return Array.from({ length: count }, (_, index) => Math.round(fromUs + step * (index + 0.5)));
}
