import { applyOp, type EditOp, type EditProject } from "./project";

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
    /** The item it is about, when it is one item: its id and list, so a window can select or remove it. */
    target?: { list: "zooms" | "redactions" | "texts" | "shapes"; id: string };
    /** The fix as edit ops, for a window's button: `tools recorder apply <edit> <ops>` does what `fix` does. */
    action?: { label: string; ops: EditOp[] };
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
    // `said` names it for a person: a text by its words, a part by its label, else its kind and start.
    const item = (
        kind: string,
        remove: "unzoom" | "unredact" | "untext" | "unshape",
        list: NonNullable<EditIssue["target"]>["list"],
        it: { id: string; startUs: number; endUs: number },
        said?: string
    ) => ({
        kind,
        remove,
        list,
        said: said ? `${kind} "${said}"` : `${kind} at ${seconds(it.startUs)} s`,
        id: it.id,
        startUs: it.startUs,
        endUs: it.endUs,
    });
    const items = [
        ...project.zooms.map((zoom) => item("zoom", "unzoom", "zooms", zoom)),
        ...(project.redactions ?? []).map((part) =>
            item(part.style === "spotlight" ? "spotlight" : "hidden part", "unredact", "redactions", part, part.label)
        ),
        ...(project.texts ?? []).map((note) => item("text", "untext", "texts", note, note.text)),
        ...(project.shapes ?? []).map((shape) => item(shape.kind, "unshape", "shapes", shape)),
    ];

    for (const entry of items) {
        const name = `${entry.kind} ${entry.id}`;
        const target = { list: entry.list, id: entry.id };

        if (!kept(entry.startUs, entry.endUs)) {
            issues.push({
                severity: "fix",
                item: name,
                message: `The ${entry.said} (${span(entry.startUs, entry.endUs)}) never shows: that time is cut from the movie`,
                fix: `movie.${entry.remove}("${entry.id}")`,
                at: seconds(entry.startUs),
                target,
                action: { label: "Remove", ops: [{ op: entry.remove, id: entry.id }] },
            });
            continue;
        }

        const shortest = entry.kind === "zoom" ? SHORTEST_ZOOM_US : SHORTEST_READABLE_US;

        if (entry.kind !== "hidden part" && entry.endUs - entry.startUs < shortest) {
            issues.push({
                severity: "check",
                item: name,
                message: `The ${entry.said} shows for ${seconds(entry.endUs - entry.startUs)} s, too short to ${entry.kind === "zoom" ? "follow" : "read"}`,
                // Long enough to read (1.5 s), unless the movie ends first.
                fix: `movie.retime({ id: "${entry.id}", to: ${seconds(Math.min(project.source.durationUs, entry.startUs + 1_500_000))} })`,
                at: seconds(entry.startUs),
                target,
                action: {
                    label: "Lengthen",
                    ops: [
                        {
                            op: "retime",
                            id: entry.id,
                            to: seconds(Math.min(project.source.durationUs, entry.startUs + 1_500_000)),
                        },
                    ],
                },
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
                // The later one moves to start where the earlier one ends, its length kept.
                fix: `movie.retime({ id: "${over.id}", at: ${seconds(note.endUs)} })`,
                at: seconds(over.startUs),
                target: { list: "texts", id: over.id },
                action: { label: "Move After", ops: [{ op: "retime", id: over.id, at: seconds(note.endUs) }] },
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
/**
 * Every fix the check offers, gathered until none is left: a fix can make a new issue (two lengthened titles meet
 * again), so the check runs again on the fixed edit, at most `passes` times. The ops apply in order to the edit as it
 * is, so one save and one undo step take them all.
 */
export function fixOps(project: EditProject, facts: EditFacts, passes = 4): { ops: EditOp[]; fixed: string[] } {
    const ops: EditOp[] = [];
    const fixed: string[] = [];
    let current = project;

    for (let pass = 0; pass < passes; pass++) {
        const fixable = checkProject(current, facts).filter((issue) => issue.action);

        if (fixable.length === 0) {
            break;
        }

        for (const issue of fixable) {
            for (const op of issue.action?.ops ?? []) {
                current = applyOp(current, op);
                ops.push(op);
            }

            fixed.push(issue.message);
        }
    }

    return { ops, fixed };
}
