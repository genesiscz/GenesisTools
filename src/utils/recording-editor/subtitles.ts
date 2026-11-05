import { type EditProject, outputDurationUs, outputTimeOf, type TranscriptLine } from "./project";

export const SUBTITLE_FORMATS = ["srt", "vtt"] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

/** One subtitle in OUTPUT microseconds. */
export interface SubtitleCue {
    fromUs: number;
    toUs: number;
    text: string;
}

/**
 * The transcript lines that play in the edit as cues in output time: a line cut away is left out, a line sped up
 * shows for its shorter time, and none runs into the next. `part` keeps the cues inside an exported part (output
 * microseconds) and moves them to start at 0.
 */
export function subtitleCues(
    lines: readonly TranscriptLine[],
    project: EditProject,
    part?: { fromUs: number; toUs: number }
): SubtitleCue[] {
    const lengthUs = outputDurationUs(project);
    const placed = lines
        .filter((line) => line.plays !== null)
        .map((line) => {
            const fromUs = Math.round((line.plays ?? 0) * 1_000_000);
            const endUs = outputTimeOf(project, Math.round(line.to * 1_000_000));
            // An end that was cut: the line keeps its spoken length, at most to the next line.
            const toUs =
                endUs !== undefined && endUs > fromUs ? endUs : fromUs + Math.round((line.to - line.from) * 1_000_000);
            return { fromUs, toUs: Math.min(toUs, lengthUs), text: line.text };
        })
        .sort((a, b) => a.fromUs - b.fromUs);
    const cues = placed.map((cue, index) => {
        const next = placed[index + 1];
        return next && next.fromUs < cue.toUs ? { ...cue, toUs: next.fromUs } : cue;
    });

    if (!part) {
        return cues.filter((cue) => cue.toUs > cue.fromUs);
    }

    return cues
        .filter((cue) => cue.toUs > part.fromUs && cue.fromUs < part.toUs)
        .map((cue) => ({
            fromUs: Math.max(cue.fromUs, part.fromUs) - part.fromUs,
            toUs: Math.min(cue.toUs, part.toUs) - part.fromUs,
            text: cue.text,
        }))
        .filter((cue) => cue.toUs > cue.fromUs);
}

/** `00:01:02,345` (SubRip) or `00:01:02.345` (WebVTT). */
function stamp(us: number, separator: "," | "."): string {
    const ms = Math.max(0, Math.round(us / 1000));
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(ms % 1000, 3)}`;
}

/** The cues as a SubRip (`.srt`) or WebVTT (`.vtt`) file. */
export function formatSubtitles(cues: readonly SubtitleCue[], format: SubtitleFormat): string {
    const separator = format === "srt" ? "," : ".";
    const blocks = cues.map((cue, index) => {
        const timing = `${stamp(cue.fromUs, separator)} --> ${stamp(cue.toUs, separator)}`;
        return format === "srt" ? `${index + 1}\n${timing}\n${cue.text}` : `${timing}\n${cue.text}`;
    });
    const body = blocks.join("\n\n");
    return format === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}
