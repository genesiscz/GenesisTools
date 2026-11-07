import { SafeJSON } from "@genesiscz/utils/json";
import { applyOp, type EditOp, type EditProject } from "./project";

/**
 * "fix": the export will be wrong or something never shows; "check": it works but may not be what was meant; "note"
 * (R6 9): the export already handles it (a hole the redaction joins close by themselves), said so nothing hides it.
 */
export type EditIssueSeverity = "fix" | "check" | "note";

export interface EditIssue {
    severity: EditIssueSeverity;
    // R6 9 grouped issues
    /** What kind of issue it is ("cut-hides-item", "text-overlap", ...): check() groups the issues by it. */
    kind?: string;
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
                kind: "too-short",
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
                kind: "follows-missing-cursor",
                item: `${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.id}`,
                message: `The ${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.label ? `"${part.label}"` : `at ${seconds(part.startUs)} s`} follows the cursor, but the movie has no cursor track, so it stays where it was drawn`,
                at: seconds(part.startUs),
            });
        }
    }

    const texts = [...(project.texts ?? [])].sort((a, b) => a.startUs - b.startUs);
    // R6 9: two texts overlap when their rendered plates do (the renderer's size, wrap and clamp to the canvas), not
    // when their anchors are near: "same place" for texts side by side was most of check()'s noise.
    const canvas = canvasShape(project);

    for (const [index, note] of texts.entries()) {
        const box = textBox(note, canvas);
        const over = texts
            .slice(index + 1)
            .find((other) => other.startUs < note.endUs && boxesOverlap(box, textBox(other, canvas)));

        if (over) {
            issues.push({
                severity: "check",
                kind: "text-overlap",
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
            kind: "music-missing",
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
                kind: "no-transcript",
                item: "captions",
                message: "Captions are on, but the movie has no transcript, so none show",
                fix: "await movie.transcript()",
            });
        }

        if (project.export.subtitles) {
            issues.push({
                severity: "fix",
                kind: "no-transcript",
                item: "subtitles",
                message: `The export asks for a ${project.export.subtitles} subtitle file, but the movie has no transcript, so none is written`,
                fix: "await movie.transcript()",
            });
        }

        const voiceDucks = (project.audio.voiceovers?.length ?? 0) > 0 && project.audio.ducking?.voiceovers !== false;

        if (music && music.duck > 0 && !voiceDucks) {
            issues.push({
                severity: "check",
                kind: "no-transcript",
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
                kind: "voiceover-missing",
                item: name,
                message: `The voiceover file "${clip.file.split(/[/\\]/).pop()}" is gone, so it does not play (it was ${clip.file})`,
                fix: `movie.unvoiceover("${clip.id}") or movie.voiceover({ id: "${clip.id}", file: "<the file>" })`,
                at: tenths(clip.atUs),
                action: { label: "Remove", ops: [{ op: "unvoiceover", id: clip.id }] },
            });
        } else if (keptUs(project, clip.atUs, clip.atUs + 1) === 0) {
            issues.push({
                severity: "fix",
                kind: "voiceover-in-cut",
                item: name,
                message: `The voiceover at ${tenths(clip.atUs)} s starts in a cut part, so it does not play`,
                fix: `movie.voiceover({ id: "${clip.id}", at: <a kept second> })`,
                at: tenths(clip.atUs),
            });
        }
    }

    // R5 5 redaction edges
    issues.push(...redactionEdgeIssues(project));
    // R5 11 clamps: an op time past the end was clamped to it; the edit call said so once, check() keeps saying it.
    for (const note of project.notes?.clamped ?? []) {
        issues.push({
            severity: "check",
            kind: "clamped-time",
            item: note.split(":")[0] ?? "edit",
            message: `${note}; check that the end of the movie is the time you meant`,
            fix: "undo() takes the change back; reset() clears this note with the whole edit",
        });
    }

    const rank = (issue: EditIssue) => SEVERITY_RANK[issue.severity];
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

// R6 9 grouped issues
const SEVERITY_RANK: Record<EditIssueSeverity, number> = { fix: 0, check: 1, note: 2 };

/** One kind of issue with how many there are: the first one's words, every item and time it is about. */
export interface EditIssueGroup {
    kind: string;
    /** The most urgent severity in the group. */
    severity: EditIssueSeverity;
    count: number;
    /** The first issue's message; the others say the same about another item or time. */
    message: string;
    /** The items, in the issues' order (at most 20; `count` says how many there are). */
    items: string[];
    /** Source seconds of the issues that have one, in order (at most 20). */
    at: number[];
    /** The fix of a one-issue group; a larger group's fixes differ per item (each issue has its own). */
    fix?: string;
    /** How many of the group's issues carry an action that fix() applies. */
    fixable: number;
}

const GROUP_LIST_MAX = 20;

/** The kind an issue groups by: its own, else its item's noun without the id ("hidden part r1a2" is "hidden part"). */
function kindOf(issue: EditIssue): string {
    return issue.kind ?? issue.item.replace(/\s+\S+$/, "");
}

/**
 * The issues grouped per kind, the most urgent group first, then the largest: 40 "starts 0.3 s after a cut" lines
 * of one tracked hiding are one group with count 40.
 */
export function groupIssues(issues: readonly EditIssue[]): EditIssueGroup[] {
    const groups = new Map<string, EditIssue[]>();

    for (const issue of issues) {
        const key = `${kindOf(issue)}\n${issue.severity}`;
        groups.set(key, [...(groups.get(key) ?? []), issue]);
    }

    return [...groups.values()]
        .map((members): EditIssueGroup => {
            const first = members[0] as EditIssue;
            return {
                kind: kindOf(first),
                severity: first.severity,
                count: members.length,
                message: first.message,
                items: members.slice(0, GROUP_LIST_MAX).map((issue) => issue.item),
                at: members.flatMap((issue) => (issue.at === undefined ? [] : [issue.at])).slice(0, GROUP_LIST_MAX),
                ...(members.length === 1 && first.fix ? { fix: first.fix } : {}),
                fixable: members.filter((issue) => issue.action).length,
            };
        })
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
}

/** Counts per severity and one line per group: what a person reads first. */
export function issueSummary(issues: readonly EditIssue[]): {
    counts: Record<EditIssueSeverity, number>;
    lines: string[];
} {
    const counts: Record<EditIssueSeverity, number> = { fix: 0, check: 0, note: 0 };

    for (const issue of issues) {
        counts[issue.severity]++;
    }

    const lines = groupIssues(issues).map(
        (group) =>
            `${group.severity.padEnd(5)} ${group.count > 1 ? `×${group.count} ${group.kind}: ` : ""}${group.message}${group.count > 1 ? ` (and ${group.count - 1} more like it)` : ""}${group.fix ? `  (${group.fix})` : ""}`
    );
    return { counts, lines };
}

// R6 9 rendered text boxes
/** The canvas's width and height with the short side 1: the frame's aspect, else the movie's. */
export function canvasShape(project: EditProject): { width: number; height: number } {
    const aspect = project.frame?.aspect;
    const [w, h] =
        aspect && aspect !== "source"
            ? aspect.split(":").map(Number)
            : [project.source.width || 16, project.source.height || 9];
    const ratio = (w ?? 16) / (h ?? 9);
    return ratio >= 1 ? { width: ratio, height: 1 } : { width: 1, height: 1 / ratio };
}

/** Average advance of a semibold system font, as a share of its size (measured on mixed text: 0.55 to 0.6). */
const CHAR_WIDTH = 0.58;
/** One line's height as a share of the font size. */
const LINE_HEIGHT = 1.2;

/**
 * A text's plate on the canvas (units of the canvas's short side, y from the top), as the renderer draws it
 * (Captions.swift drawText): the font size is `size` of the short side, lines wrap at the block's width (0.8 of the
 * canvas) less the plate's inset (0.7 × size each side, 0.38 × size above and below), and the plate is centred on
 * x, y and kept inside the canvas. The widths are estimated from the characters, so they are close, not exact.
 */
export function textBox(
    note: { text: string; size: number; x: number; y: number; block?: { width?: number } },
    canvas: { width: number; height: number }
): { left: number; top: number; right: number; bottom: number } {
    const font = note.size;
    const insetX = font * 0.7;
    const insetY = font * 0.38;
    const wrap = Math.max(
        font * 4,
        canvas.width * Math.min(0.95, Math.max(0.15, note.block?.width ?? 0.8)) - 2 * insetX
    );
    let lines = 0;
    let widest = 0;

    for (const line of note.text.split("\n")) {
        const width = Math.max(1, line.length) * CHAR_WIDTH * font;
        lines += Math.max(1, Math.ceil(width / wrap));
        widest = Math.max(widest, Math.min(width, wrap));
    }

    const width = widest + 2 * insetX;
    const height = lines * LINE_HEIGHT * font + 2 * insetY;
    const left = Math.min(Math.max(0, note.x * canvas.width - width / 2), Math.max(0, canvas.width - width));
    const top = Math.min(Math.max(0, note.y * canvas.height - height / 2), Math.max(0, canvas.height - height));
    return { left, top, right: left + width, bottom: top + height };
}

function boxesOverlap(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number }
): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
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
    // R6 9: a hole the export closes by itself is a note, not something to check.
    const holeSeverity = (holeUs: number): EditIssueSeverity => (holeUs <= snapUs ? "note" : "check");
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
                kind: "hiding-too-short",
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
                kind: "pixelate-cell-small",
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
                severity: holeSeverity(cut - part.endUs),
                kind: "hiding-ends-before-cut",
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
                severity: holeSeverity(part.startUs - opened),
                kind: "hiding-starts-after-cut",
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
                severity: holeSeverity(next.startUs - part.endUs),
                kind: "hiding-gap",
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
                kind: "cut-hides-item",
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
                kind: "cut-shortens-text",
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
            kind: "marker-in-cut",
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
            kind: "marker-in-cut",
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
