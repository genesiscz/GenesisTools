import { SafeJSON } from "@genesiscz/utils/json";
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
    target?: { list: "zooms" | "redactions" | "texts" | "shapes" | "markers"; id: string };
    /** The fix as edit ops, for a window's button: `tools recorder apply <edit> <ops>` does what `fix` does. */
    action?: { label: string; ops: EditOp[] };
}

/** What the check cannot read from the edit itself; the caller looks at the disk. */
export interface EditFacts {
    hasTranscript: boolean;
    hasCursorTrack: boolean;
    musicFileExists: boolean;
    /** The markers set while it recorded (its recording.json), at source milliseconds; the edit does not hold them. */
    recordedMarkers?: ReadonlyArray<{ atMs: number; label: string }>;
}

/** A text that loses less than this to a cut is not worth a word. */
const SHORTENED_US = 100_000;

/** Anything shorter than this flashes past before it can be read. */
const SHORTEST_READABLE_US = 400_000;
const SHORTEST_ZOOM_US = 600_000;

/**
 * What to look at before an export, from the edit alone plus a few facts about files: items whose whole time is cut
 * (they never show), a missing music file, captions, subtitles or ducking without a transcript, a part that follows
 * a cursor the movie does not have, items too short to read, and texts drawn over each other. Pure: it reads nothing.
 */
export function checkProject(project: EditProject, facts: EditFacts): EditIssue[] {
    const issues: EditIssue[] = cutIssues(project, facts.recordedMarkers);
    const seconds = (us: number) => Math.round(us / 100_000) / 10;
    const span = (startUs: number, endUs: number) => `${seconds(startUs)} to ${seconds(endUs)} s`;
    const kept = (startUs: number, endUs: number) => keptUs(project, startUs, endUs) > 0;

    for (const entry of checkedItems(project)) {
        // An item whose whole time is cut is one of cutIssues; too short does not matter for it.
        if (!kept(entry.startUs, entry.endUs)) {
            continue;
        }

        const name = `${entry.kind} ${entry.id}`;
        const target = { list: entry.list, id: entry.id };
        const shortest = entry.kind === "zoom" ? SHORTEST_ZOOM_US : SHORTEST_READABLE_US;

        if (entry.kind !== "hidden part" && entry.endUs - entry.startUs < shortest) {
            const longer = lengthened(entry, shortest, project.source.durationUs);
            issues.push({
                severity: "check",
                item: name,
                message: `The ${entry.said} shows for ${seconds(entry.endUs - entry.startUs)} s, too short to ${entry.kind === "zoom" ? "follow" : "read"}`,
                at: seconds(entry.startUs),
                target,
                // No fix when the movie itself is too short to show it longer.
                ...(longer && {
                    fix: `movie.retime({ id: "${entry.id}", ${Object.entries(longer)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ")} })`,
                    action: { label: "Lengthen", ops: [{ op: "retime", id: entry.id, ...longer }] },
                }),
            });
        }
    }
    for (const part of project.redactions ?? []) {
        if (part.follow && !facts.hasCursorTrack) {
            issues.push({
                severity: "fix",
                item: `${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.id}`,
                message: `The ${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.label ? `"${part.label}"` : `at ${seconds(part.startUs)} s`} follows the cursor, but the movie has no cursor track, so it stays where it was drawn`,
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
            // The name first, so a long path does not hide what is missing; the whole path after it.
            message: `The music file "${music.file.split(/[/\\]/).pop()}" is gone, so the export plays without music (it was ${music.file})`,
            fix: 'movie.music({ file: "<the file>" }) or movie.music({ enabled: false })',
        });
    }

    if (!facts.hasTranscript) {
        if (project.captions?.show) {
            issues.push({
                severity: "fix",
                item: "captions",
                message: "Captions are on, but the movie has no transcript, so none show",
                fix: "await movie.transcript()",
            });
        }

        if (project.export.subtitles) {
            issues.push({
                severity: "fix",
                item: "subtitles",
                message: `The export asks for a ${project.export.subtitles} subtitle file, but the movie has no transcript, so none is written`,
                fix: "await movie.transcript()",
            });
        }

        if (music && music.duck > 0) {
            issues.push({
                severity: "check",
                item: "music",
                message: "The music should drop under speech, but without a transcript nothing ducks",
                fix: "await movie.transcript()",
            });
        }
    }

    const rank = (issue: EditIssue) => (issue.severity === "fix" ? 0 : 1);
    return issues.sort((a, b) => rank(a) - rank(b) || (a.at ?? -1) - (b.at ?? -1));
}
/** Source seconds to a tenth, as the messages say them. */
const tenths = (us: number) => Math.round(us / 100_000) / 10;

/** The kinds the check looks at, each with how to remove it and how to name it for a person. */
/** How long a lengthened item lasts: long enough to read. */
const LENGTHENED_US = 1_500_000;

/**
 * The retime that makes a too-short item 1.5 s long: a later end, or an earlier start when the movie ends first. Times
 * in milliseconds, the end rounded down so it never passes the source's end. Undefined when the movie has no room.
 */
function lengthened(
    item: { startUs: number; endUs: number },
    shortest: number,
    sourceUs: number
): { from?: number; to: number } | undefined {
    const toUs = Math.min(sourceUs, item.startUs + LENGTHENED_US);
    const fromUs = toUs - item.startUs < shortest ? Math.max(0, toUs - LENGTHENED_US) : item.startUs;

    if (toUs - fromUs <= item.endUs - item.startUs) {
        return undefined;
    }

    const to = Math.floor(toUs / 1000) / 1000;
    return fromUs === item.startUs ? { to } : { from: Math.round(fromUs / 1000) / 1000, to };
}

function checkedItems(project: EditProject) {
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
        said: said ? `${kind} "${said}"` : `${kind} at ${tenths(it.startUs)} s`,
        id: it.id,
        startUs: it.startUs,
        endUs: it.endUs,
    });
    return [
        ...project.zooms.map((zoom) => item("zoom", "unzoom", "zooms", zoom)),
        ...(project.redactions ?? []).map((part) =>
            item(part.style === "spotlight" ? "spotlight" : "hidden part", "unredact", "redactions", part, part.label)
        ),
        ...(project.texts ?? []).map((note) => item("text", "untext", "texts", note, note.text)),
        ...(project.shapes ?? []).map((shape) => item(shape.kind, "unshape", "shapes", shape)),
    ];
}

/** How much of `startUs`..`endUs` (source) the edit keeps. */
function keptUs(project: EditProject, startUs: number, endUs: number): number {
    return project.clips.reduce(
        (sum, clip) => sum + Math.max(0, Math.min(clip.toUs, endUs) - Math.max(clip.fromUs, startUs)),
        0
    );
}

/** Whether a moment plays: it sits in a kept clip, its ends included. */
function playsAt(project: EditProject, atUs: number): boolean {
    return project.clips.some((clip) => atUs >= clip.fromUs && atUs <= clip.toUs);
}

/** Why a moment that does not play is gone: a cut, or a time the movie never had (a negative or late marker). */
function whyNotPlayed(project: EditProject, atUs: number): string {
    if (atUs < 0 || atUs > project.source.durationUs) {
        return `that time is outside the ${tenths(project.source.durationUs)} s movie`;
    }

    return "that time is cut";
}

/** The kept moment nearest a cut one (source microseconds): the next clip's start, or the last clip's end before it. */
function nearestKeptUs(project: EditProject, atUs: number): number | undefined {
    const edges = project.clips.flatMap((clip) => [clip.fromUs, clip.toUs]);
    return edges.reduce<number | undefined>(
        (best, edge) =>
            best === undefined ||
            Math.abs(edge - atUs) < Math.abs(best - atUs) ||
            (Math.abs(edge - atUs) === Math.abs(best - atUs) && edge > best)
                ? edge
                : best,
        undefined
    );
}

/**
 * What the cuts of this edit cost: an item whose whole time is cut (it never shows), a text that loses part of its
 * time, and a marker (the edit's, or one set while it recorded) that sits in cut time, so it is no chapter. An edit
 * marker's fix moves it to the nearest kept moment; a recorded marker cannot move, so an edit marker of its name stands
 * in for it. The edit path compares these before and after each change and warns about the new ones.
 */
export function cutIssues(
    project: EditProject,
    recordedMarkers: ReadonlyArray<{ atMs: number; label: string }> = []
): EditIssue[] {
    const issues: EditIssue[] = [];
    const span = (startUs: number, endUs: number) => `${tenths(startUs)} to ${tenths(endUs)} s`;

    for (const entry of checkedItems(project)) {
        const kept = keptUs(project, entry.startUs, entry.endUs);
        const target = { list: entry.list, id: entry.id };

        if (kept === 0) {
            issues.push({
                severity: "fix",
                item: `${entry.kind} ${entry.id}`,
                message: `The ${entry.said} (${span(entry.startUs, entry.endUs)}) never shows: that time is cut from the movie`,
                fix: `movie.${entry.remove}("${entry.id}")`,
                at: tenths(entry.startUs),
                target,
                action: { label: "Remove", ops: [{ op: entry.remove, id: entry.id }] },
            });
        } else if (entry.kind === "text" && entry.endUs - entry.startUs - kept >= SHORTENED_US) {
            issues.push({
                severity: "check",
                item: `text ${entry.id}`,
                message: `The ${entry.said} (${span(entry.startUs, entry.endUs)}) loses ${tenths(entry.endUs - entry.startUs - kept)} s of its ${tenths(entry.endUs - entry.startUs)} s to a cut`,
                at: tenths(entry.startUs),
                target,
            });
        }
    }

    for (const marker of project.markers ?? []) {
        const nearest = playsAt(project, marker.atUs) ? undefined : nearestKeptUs(project, marker.atUs);

        if (nearest === undefined) {
            continue;
        }

        const ops: EditOp[] = [
            { op: "unmarker", id: marker.id },
            { op: "marker", at: nearest / 1_000_000, label: marker.label },
        ];
        issues.push({
            severity: "fix",
            item: `marker ${marker.id}`,
            message: `The marker "${marker.label}" at ${tenths(marker.atUs)} s never plays: ${whyNotPlayed(project, marker.atUs)}, so it is no chapter`,
            fix: `movie.apply(${SafeJSON.stringify(ops)})`,
            at: tenths(marker.atUs),
            target: { list: "markers", id: marker.id },
            action: { label: "Move", ops },
        });
    }

    const named = new Set((project.markers ?? []).map((marker) => marker.label));

    for (const marker of recordedMarkers) {
        const atUs = marker.atMs * 1000;
        const nearest = playsAt(project, atUs) || named.has(marker.label) ? undefined : nearestKeptUs(project, atUs);

        if (nearest === undefined) {
            continue;
        }

        issues.push({
            severity: "check",
            item: `recorded marker "${marker.label}"`,
            message: `The recorded marker "${marker.label}" at ${tenths(atUs)} s never plays: ${whyNotPlayed(project, atUs)}, so it is no chapter`,
            fix: `movie.marker(${nearest / 1_000_000}, ${SafeJSON.stringify(marker.label)})`,
            at: tenths(atUs),
        });
    }

    return issues;
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

        let changed = false;

        for (const issue of fixable) {
            const issueOps = issue.action?.ops ?? [];
            const next = issueOps.reduce((edit, op) => applyOp(edit, op), current);

            // An op that changes nothing fixes nothing: it is neither saved nor counted.
            if (SafeJSON.stringify(next) === SafeJSON.stringify(current)) {
                continue;
            }

            current = next;
            ops.push(...issueOps);
            fixed.push(issue.message);
            changed = true;
        }

        if (!changed) {
            break;
        }
    }

    return { ops, fixed };
}
