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
    // R4 voiceover clips
    /** The ids of the voiceover clips whose file is gone; absent is none checked. */
    missingVoiceovers?: readonly string[];
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
        const over = texts.slice(index + 1).find(
            (other) =>
                other.startUs < note.endUs &&
                // R5 10: half of each text's height apart at least; a text of n lines is about n × 1.4 × its size
                // tall (plus its plate), so two-line texts 0.1 apart overlap where one-liners did not.
                Math.abs(other.y - note.y) < Math.max(0.08, halfHeight(note) + halfHeight(other)) &&
                Math.abs(other.x - note.x) < 0.3
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

        const voiceDucks = (project.audio.voiceovers?.length ?? 0) > 0 && project.audio.ducking?.voiceovers !== false;

        if (music && music.duck > 0 && !voiceDucks) {
            issues.push({
                severity: "check",
                item: "music",
                message: "The music should drop under speech, but without a transcript nothing ducks",
                fix: "await movie.transcript()",
            });
        }
    }

    // R4 voiceover clips: a gone file plays nothing; a clip whose start is cut is not mixed at all.
    for (const clip of project.audio.voiceovers ?? []) {
        const name = clip.label ? `voiceover ${clip.id} ("${clip.label}")` : `voiceover ${clip.id}`;

        if (facts.missingVoiceovers?.includes(clip.id)) {
            issues.push({
                severity: "fix",
                item: name,
                message: `The voiceover file "${clip.file.split(/[/\\]/).pop()}" is gone, so it does not play (it was ${clip.file})`,
                fix: `movie.unvoiceover("${clip.id}") or movie.voiceover({ id: "${clip.id}", file: "<the file>" })`,
                at: tenths(clip.atUs),
                action: { label: "Remove", ops: [{ op: "unvoiceover", id: clip.id }] },
            });
        } else if (keptUs(project, clip.atUs, clip.atUs + 1) === 0) {
            issues.push({
                severity: "fix",
                item: name,
                message: `The voiceover at ${tenths(clip.atUs)} s starts in a cut part, so it does not play`,
                fix: `movie.voiceover({ id: "${clip.id}", at: <a kept second> })`,
                at: tenths(clip.atUs),
            });
        }
    }

    // R5 5 redaction edges
    issues.push(...redactionEdgeIssues(project));

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

// R5 10 multi-line texts
/** Half a text's height as a share of the canvas's short side: its lines at 1.4 × size, plus the plate's margin. */
function halfHeight(note: { text: string; size: number }): number {
    return (note.text.split("\n").length * note.size * 1.4 + note.size * 0.8) / 2;
}

// R5 5 redaction edges
/** A hiding part that covers less of the export than this may miss the frames it was meant for. */
const SHORT_HIDING_US = 150_000;
/** Holes around hiding parts up to this long are worth a look; longer ones are taken as meant. */
const HIDING_HOLE_US = 1_000_000;

/** The output length of `startUs`..`endUs` (source): each kept piece at its clip's speed. */
function playedUs(project: EditProject, startUs: number, endUs: number): number {
    return project.clips.reduce(
        (sum, clip) =>
            sum + Math.max(0, Math.min(clip.toUs, endUs) - Math.max(clip.fromUs, startUs)) / (clip.speed || 1),
        0
    );
}

/** The source times where a kept clip ends before a cut (or the movie's end), and where one starts after a cut. */
function cutEdgesOf(project: EditProject): { ends: number[]; starts: number[] } {
    const clips = project.clips.filter((clip) => clip.toUs > clip.fromUs);
    const ends = clips.filter((clip, index) => clips[index + 1]?.fromUs !== clip.toUs).map((clip) => clip.toUs);
    const starts = clips
        .filter((clip, index) => clip.fromUs > 0 && clips[index - 1]?.toUs !== clip.fromUs)
        .map((clip) => clip.fromUs);
    return { ends, starts };
}

/**
 * The holes a hiding part (blur, pixelate, black) can leave, which the export cannot see in the picture: a part that
 * covers under 0.15 s of the export, one that ends or starts a little short of a cut, and a short gap between two parts
 * near each other (text that scrolled from one box into the next). Holes up to `redactionJoins.snapMs` (250 ms) the
 * export closes by itself; the message says so, and the action writes the same times into the edit.
 */
function redactionEdgeIssues(project: EditProject): EditIssue[] {
    const issues: EditIssue[] = [];
    const snapUs = (project.redactionJoins?.snapMs ?? 250) * 1000;
    const seconds = (us: number) => Math.round(us / 1000) / 1000;
    const hiding = (project.redactions ?? []).filter(
        (part) => part.style !== "spotlight" && keptUs(project, part.startUs, part.endUs) > 0
    );
    const edges = cutEdgesOf(project);
    const said = (part: (typeof hiding)[number]) =>
        `hidden part ${part.label ? `"${part.label}"` : `at ${tenths(part.startUs)} s`}`;
    const closed = (holeUs: number) =>
        holeUs <= snapUs
            ? `the export covers the ${seconds(holeUs)} s between by itself (redactionJoins snapMs ${snapUs / 1000})`
            : `the ${seconds(holeUs)} s between show the picture unhidden`;

    for (const part of hiding) {
        const item = `hidden part ${part.id}`;
        const target = { list: "redactions" as const, id: part.id };
        const played = playedUs(project, part.startUs, part.endUs);

        if (played < SHORT_HIDING_US) {
            issues.push({
                severity: "check",
                item,
                message: `The ${said(part)} covers only ${Math.round(played / 1000)} ms of the export (about ${Math.max(1, Math.round(played / 33_333))} frame${played < 50_000 ? "" : "s"} at 30 fps); check that it spans every frame the hidden thing shows`,
                fix: `movie.retime({ id: "${part.id}", from: ${seconds(Math.max(0, part.startUs - 100_000))}, to: ${seconds(Math.min(project.source.durationUs, part.endUs + 100_000))} })`,
                at: tenths(part.startUs),
                target,
            });
        }

        // A pixelate block smaller than the default can leave the text under it readable (6 px over a 48 px heading).
        const defaultCell = Math.max(8, project.source.height * 0.018);

        if (part.style === "pixelate" && part.cell !== undefined && part.cell < defaultCell) {
            issues.push({
                severity: "check",
                item,
                message: `The ${said(part)} pixelates in ${part.cell} px blocks, smaller than the default ${Math.round(defaultCell)} px; text under it may stay readable`,
                fix: `movie.apply([{ op: "setRedaction", id: "${part.id}", cell: 0 }])`,
                at: tenths(part.startUs),
                target,
            });
        }

        const cut = edges.ends.find((end) => end > part.endUs && end - part.endUs <= HIDING_HOLE_US);

        if (cut !== undefined && keptUs(project, part.endUs, cut) > 0) {
            issues.push({
                severity: "check",
                item,
                message: `The ${said(part)} ends ${seconds(cut - part.endUs)} s before ${cut === edges.ends.at(-1) ? "the movie's end" : `the cut at ${seconds(cut)} s`}; ${closed(cut - part.endUs)}`,
                fix: `movie.retime({ id: "${part.id}", to: ${seconds(cut)} })`,
                at: tenths(part.endUs),
                target,
                action: { label: "Extend to Cut", ops: [{ op: "retime", id: part.id, to: seconds(cut) }] },
            });
        }

        const opened = [...edges.starts]
            .reverse()
            .find((start) => start < part.startUs && part.startUs - start <= HIDING_HOLE_US);

        if (opened !== undefined && keptUs(project, opened, part.startUs) > 0) {
            issues.push({
                severity: "check",
                item,
                message: `The ${said(part)} starts ${seconds(part.startUs - opened)} s after the cut at ${seconds(opened)} s; ${closed(part.startUs - opened)}`,
                fix: `movie.retime({ id: "${part.id}", from: ${seconds(opened)} })`,
                at: tenths(opened),
                target,
                action: { label: "Start at Cut", ops: [{ op: "retime", id: part.id, from: seconds(opened) }] },
            });
        }

        // The next part that starts after this one ends, near it on the picture (centres at most 0.3 apart).
        const next = hiding
            .filter((other) => other.id !== part.id && other.startUs > part.endUs)
            .filter(
                (other) =>
                    Math.abs(other.x + other.width / 2 - (part.x + part.width / 2)) <= 0.3 &&
                    Math.abs(other.y + other.height / 2 - (part.y + part.height / 2)) <= 0.3
            )
            .sort((a, b) => a.startUs - b.startUs)[0];

        if (next && next.startUs - part.endUs <= HIDING_HOLE_US && keptUs(project, part.endUs, next.startUs) > 0) {
            issues.push({
                severity: "check",
                item,
                message: `The ${said(part)} ends ${seconds(next.startUs - part.endUs)} s before the ${said(next)} starts; ${closed(next.startUs - part.endUs)}`,
                fix: `movie.retime({ id: "${part.id}", to: ${seconds(next.startUs)} })`,
                at: tenths(part.endUs),
                target,
                action: { label: "Join", ops: [{ op: "retime", id: part.id, to: seconds(next.startUs) }] },
            });
        }
    }

    return issues;
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
