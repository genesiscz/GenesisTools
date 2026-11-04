import type { EditProject } from "./project";

/** "fix": the export will be wrong or something never shows; "check": it works but may not be what was meant. */
export type EditIssueSeverity = "fix" | "check";

export interface EditIssue {
    severity: EditIssueSeverity;
    /** What it is about: "zoom z1a2", "text t3b4", "music", "captions". */
    item: string;
    message: string;
    /** A REPL call that fixes it, when one does. */
    fix?: string;
    /** Source seconds, for sorting and for show({ at }). */
    at?: number;
}

/** What the check cannot read from the edit itself; the caller looks at the disk. */
export interface EditFacts {
    hasTranscript: boolean;
    hasCursorTrack: boolean;
    musicFileExists: boolean;
}

/** Anything shorter than this flashes past before it can be read. */
const SHORTEST_READABLE_US = 400_000;
const SHORTEST_ZOOM_US = 600_000;

/**
 * What to look at before an export, from the edit alone plus a few facts about files: items whose whole time is cut
 * (they never show), a missing music file, captions, subtitles or ducking without a transcript, a part that follows
 * a cursor the movie does not have, items too short to read, and texts drawn over each other. Pure: it reads nothing.
 */
export function checkProject(project: EditProject, facts: EditFacts): EditIssue[] {
    const issues: EditIssue[] = [];
    const seconds = (us: number) => Math.round(us / 100_000) / 10;
    const span = (startUs: number, endUs: number) => `${seconds(startUs)} to ${seconds(endUs)} s`;
    const kept = (startUs: number, endUs: number) =>
        project.clips.some((clip) => clip.fromUs < endUs && clip.toUs > startUs);
    // Only what every kind has, so a shape's own `kind` field is not mixed in.
    const item = (kind: string, remove: string, it: { id: string; startUs: number; endUs: number }) => ({
        kind,
        remove,
        id: it.id,
        startUs: it.startUs,
        endUs: it.endUs,
    });
    const items = [
        ...project.zooms.map((zoom) => item("zoom", "unzoom", zoom)),
        ...(project.redactions ?? []).map((part) =>
            item(part.style === "spotlight" ? "spotlight" : "hidden part", "unredact", part)
        ),
        ...(project.texts ?? []).map((note) => item("text", "untext", note)),
        ...(project.shapes ?? []).map((shape) => item(shape.kind, "unshape", shape)),
    ];

    for (const entry of items) {
        const name = `${entry.kind} ${entry.id}`;

        if (!kept(entry.startUs, entry.endUs)) {
            issues.push({
                severity: "fix",
                item: name,
                message: `${name} (${span(entry.startUs, entry.endUs)}) never shows: that time is cut from the movie`,
                fix: `movie.${entry.remove}("${entry.id}")`,
                at: seconds(entry.startUs),
            });
            continue;
        }

        const shortest = entry.kind === "zoom" ? SHORTEST_ZOOM_US : SHORTEST_READABLE_US;

        if (entry.kind !== "hidden part" && entry.endUs - entry.startUs < shortest) {
            issues.push({
                severity: "check",
                item: name,
                message: `${name} shows for ${seconds(entry.endUs - entry.startUs)} s, too short to ${entry.kind === "zoom" ? "follow" : "read"}`,
                at: seconds(entry.startUs),
            });
        }
    }

    for (const part of project.redactions ?? []) {
        if (part.follow && !facts.hasCursorTrack) {
            issues.push({
                severity: "fix",
                item: `${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.id}`,
                message: "it follows the cursor, but the movie has no cursor track, so it stays where it was drawn",
                at: seconds(part.startUs),
            });
        }
    }

    const texts = [...(project.texts ?? [])].sort((a, b) => a.startUs - b.startUs);

    for (const [index, note] of texts.entries()) {
        const over = texts
            .slice(index + 1)
            .find(
                (other) =>
                    other.startUs < note.endUs && Math.abs(other.y - note.y) < 0.08 && Math.abs(other.x - note.x) < 0.3
            );

        if (over) {
            issues.push({
                severity: "check",
                item: `text ${note.id}`,
                message: `"${note.text}" and "${over.text}" show at the same time in the same place (${span(over.startUs, Math.min(note.endUs, over.endUs))})`,
                at: seconds(over.startUs),
            });
        }
    }

    const music = project.audio.music;

    if (music && !facts.musicFileExists) {
        issues.push({
            severity: "fix",
            item: "music",
            message: `the music file ${music.file} is gone, so the export plays without music`,
            fix: 'movie.music({ file: "<the file>" }) or movie.music({ enabled: false })',
        });
    }

    if (!facts.hasTranscript) {
        if (project.captions?.show) {
            issues.push({
                severity: "fix",
                item: "captions",
                message: "captions are on, but the movie has no transcript, so none show",
                fix: "await movie.transcript()",
            });
        }

        if (project.export.subtitles) {
            issues.push({
                severity: "fix",
                item: "subtitles",
                message: `the export asks for a ${project.export.subtitles} subtitle file, but the movie has no transcript, so none is written`,
                fix: "await movie.transcript()",
            });
        }

        if (music && music.duck > 0) {
            issues.push({
                severity: "check",
                item: "music",
                message: "the music should drop under speech, but without a transcript nothing ducks",
                fix: "await movie.transcript()",
            });
        }
    }

    const rank = (issue: EditIssue) => (issue.severity === "fix" ? 0 : 1);
    return issues.sort((a, b) => rank(a) - rank(b) || (a.at ?? -1) - (b.at ?? -1));
}
