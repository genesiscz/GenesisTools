import { SafeJSON } from "@genesiscz/utils/json";
import {
    applyOp,
    canvasShape,
    cutEdgesOf,
    type EditOp,
    type EditProject,
    type EditTextNote,
    outputDurationUs,
    outputSpansOf,
    outputTimeOf,
    playedUs,
    sourceAfterPlayed,
    type TEXT_ALIGNS,
    voiceoverExportSpans,
    zoomsLinked,
} from "./project";
import { layoutText } from "./text-metrics";
import { musicDucking } from "./voiceovers";

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
    // R7 10 zoom edge text
    /** The screen text read so far (the OCR cache of findText/hideText, or a frames recording's); absent: not read. */
    screenText?: ReadonlyArray<{
        atUs: number;
        untilUs: number;
        lines: ReadonlyArray<{ text: string; x: number; y: number; width: number; height: number }>;
    }>;
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

        // What the viewer sees is the played time: a sped-up stretch shows an item for less, a slowed one for more.
        const played = playedUs(project, entry.startUs, entry.endUs);

        if (entry.kind !== "hidden part" && played < shortest) {
            const longer = lengthened(project, entry, shortest);
            const sourceUs = keptUs(project, entry.startUs, entry.endUs);
            const speedNote =
                Math.abs(played - sourceUs) >= 50_000
                    ? ` (the movie plays ${played < sourceUs ? "faster" : "slower"} there: ${seconds(sourceUs)} s of the movie)`
                    : "";
            issues.push({
                severity: "check",
                kind: "too-short",
                item: name,
                message: `The ${entry.said} shows for ${seconds(played)} s${speedNote}, too short to ${entry.kind === "zoom" ? "follow" : "read"}`,
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

    // A text's way in runs in played time (the renderer's TextMotion): one still coming in when less than the shortest
    // readable time is left is never read whole. A text too short to read at all is the issue above.
    for (const note of project.texts ?? []) {
        const played = playedUs(project, note.startUs, note.endUs);
        const wayInUs = (note.animate?.ms ?? 0) * 1000;

        if (!note.animate || played < SHORTEST_READABLE_US || wayInUs <= played - SHORTEST_READABLE_US) {
            continue;
        }

        const fitsMs = Math.floor((played - SHORTEST_READABLE_US) / 100_000) * 100;
        const animate = { kind: note.animate.kind, ms: fitsMs };
        issues.push({
            severity: "check",
            kind: "text-animation-too-long",
            item: `text ${note.id}`,
            message: `The text "${note.text}" takes ${seconds(wayInUs)} s to come in (${note.animate.kind}) but plays for ${seconds(played)} s, so the viewer has under ${seconds(SHORTEST_READABLE_US)} s to read it whole`,
            at: seconds(note.startUs),
            target: { list: "texts", id: note.id },
            ...(fitsMs >= 100 && {
                fix: `movie.apply([{ op: "setText", id: "${note.id}", animate: { kind: "${animate.kind}", ms: ${fitsMs} } }])`,
                action: { label: "Come In Faster", ops: [{ op: "setText", id: note.id, animate }] },
            }),
        });
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
    // R6 9: two texts overlap when what they show does (the renderer's font, wrap and clamp to the canvas; a plate
    // text's plate, a plain text's letters), not when their anchors are near: "same place" for texts side by side was
    // most of check()'s noise.
    const canvas = canvasShape(project);
    const shown = texts.flatMap((note) => {
        const box = shownBox(note, canvas);
        return box ? [{ note, box }] : [];
    });

    for (const [index, { note, box }] of shown.entries()) {
        const over = shown
            .slice(index + 1)
            .find((other) => other.note.startUs < note.endUs && boxesOverlap(box, other.box))?.note;

        if (over) {
            // The later one moves to start where the earlier one ends, its length kept. The end to the millisecond,
            // rounded up: a tenth rounded down (5.04 to 5) left the two showing together and the issue open.
            const after = Math.ceil(note.endUs / 1000) / 1000;
            issues.push({
                severity: "check",
                kind: "text-overlap",
                item: `text ${note.id}`,
                message: `"${note.text}" and "${over.text}" show at the same time in the same place (${span(over.startUs, Math.min(note.endUs, over.endUs))})`,
                fix: `movie.retime({ id: "${over.id}", at: ${after} })`,
                at: seconds(over.startUs),
                target: { list: "texts", id: over.id },
                action: { label: "Move After", ops: [{ op: "retime", id: over.id, at: after }] },
            });
        }
    }

    const music = project.audio.music;
    const duck = musicDucking(project);

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

        if (music && duck.drops && duck.underTranscript && !duck.underVoiceovers) {
            issues.push({
                severity: "check",
                kind: "no-transcript",
                item: "music",
                message: "The music should drop under speech, but without a transcript nothing ducks",
                fix: "await movie.transcript()",
            });
        }
    }

    // R4 8 music ducking: off under the transcript, the music drops only under voiceovers; a transcript changes nothing.
    if (music && duck.drops && !duck.underTranscript && !duck.underVoiceovers) {
        issues.push({
            severity: "check",
            kind: "music-ducks-nothing",
            item: "music",
            message:
                "The music should drop under speech, but ducking is off under the transcript and the edit has no voiceover, so nothing ducks",
            ...(facts.hasTranscript ? { fix: "await movie.ducking({ transcript: true })" } : {}),
        });
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
        } else if (clip.card !== undefined) {
            // A card's line plays over its card and may run on into what follows; it needs only the card.
            const card = project.cards?.[clip.card];

            if (!card) {
                issues.push({
                    severity: "fix",
                    kind: "voiceover-card-missing",
                    item: name,
                    message: `The voiceover on the ${clip.card} card does not play: the edit has no ${clip.card} card`,
                    fix: `movie.${clip.card}Card({ ... }) or movie.unvoiceover("${clip.id}")`,
                    action: { label: "Remove", ops: [{ op: "unvoiceover", id: clip.id }] },
                });
            } else if (clip.atUs >= Math.round(card.seconds * 1_000_000)) {
                // A card got shorter under its clip: the export lays it as voiceoverExportSpans says.
                const plays = voiceoverExportSpans(project).some((span) => span.id === clip.id);
                const starts = `The voiceover on the ${clip.card} card starts at ${tenths(clip.atUs)} s, the ${clip.card} card lasts ${card.seconds} s`;
                issues.push({
                    severity: plays ? "check" : "fix",
                    kind: "voiceover-past-card",
                    item: name,
                    message: plays ? `${starts}, so it plays over the movie` : `${starts}, so it does not play`,
                    fix: `movie.voiceover({ id: "${clip.id}", at: <a second under ${card.seconds}> }) or movie.unvoiceover("${clip.id}")`,
                    action: { label: "Remove", ops: [{ op: "unvoiceover", id: clip.id }] },
                });
            }
        } else if (!voiceoverPlays(project, clip.atUs)) {
            issues.push({
                severity: "fix",
                kind: "voiceover-in-cut",
                item: name,
                message: `The voiceover at ${tenths(clip.atUs)} s starts in a cut part or at the movie's end, so it does not play`,
                fix: `movie.voiceover({ id: "${clip.id}", at: <a kept second> })`,
                at: tenths(clip.atUs),
            });
        } else {
            // The renderer mixes a clip into the movie only (Voiceovers.swift): the end card does not carry it, so
            // the words after the movie's last frame are cut off.
            const startUs = outputTimeOf(project, clip.atUs);
            const overUs = startUs === undefined ? 0 : startUs + clip.durationUs - outputDurationUs(project);

            if (overUs > SHORTENED_US) {
                issues.push({
                    severity: "fix",
                    kind: "voiceover-cut-at-end",
                    item: name,
                    message: `The voiceover at ${tenths(clip.atUs)} s runs ${tenths(overUs)} s past the movie's end; the end card does not carry it, so its last ${tenths(overUs)} s are cut off`,
                    fix: `keep ${tenths(overUs)} s more of the movie after it, or movie.voiceover({ id: "${clip.id}", at: <an earlier second> })`,
                    at: tenths(clip.atUs),
                });
            }
        }
    }

    // R5 5 redaction edges
    issues.push(...redactionEdgeIssues(project));
    issues.push(...zoomEaseAtCutIssues(project));
    // R7 10 zoom edge text
    issues.push(...zoomEdgeIssues(project, facts));
    // R6 1 moving text
    issues.push(...uncertainHideIssues(project));
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
 * The retime that makes a too-short item play for 1.5 s: a later end, or an earlier start when the movie ends first.
 * The length is played time, so the clips' speeds set how far in source time the item reaches. Times in seconds to
 * the millisecond, the end rounded down so it never passes the source's end. Undefined when the movie has no room.
 */
function lengthened(
    project: EditProject,
    item: { startUs: number; endUs: number },
    shortest: number
): { from?: number; to: number } | undefined {
    const toUs = sourceAfterPlayed(project, item.startUs, LENGTHENED_US);
    const fromUs =
        playedUs(project, item.startUs, toUs) < shortest
            ? sourceBeforePlayed(project, toUs, LENGTHENED_US)
            : item.startUs;

    if (playedUs(project, fromUs, toUs) <= playedUs(project, item.startUs, item.endUs)) {
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
// canvasShape lives in project.ts, where the camera op reads it too; check.ts callers keep importing it from here.
export { canvasShape };

/**
 * The canvas's short side in pixels that check() lays texts out at, since it does not know the export's size. The size
 * matters little: the font sets a line about 1.5 % wider in em at 31 px than at 54 px, and the same from 78 px up.
 */
const CHECK_SHORT_SIDE_PX = 1080;
/**
 * A plate's left edge before the canvas clamp, from the block's centre and width, the plate's width and `edge`: how far
 * inside the plate the edge that lines up lies. A plate text lines up its plate (`edge` 0), a plain text its letters
 * (`edge` the inset), so a left-aligned one has its letters at the block's left edge and its plate past it.
 */
const PLATE_LEFT: Record<
    (typeof TEXT_ALIGNS)[number],
    (at: { centre: number; block: number; plate: number; edge: number }) => number
> = {
    left: ({ centre, block, edge }) => centre - block / 2 - edge,
    center: ({ centre, plate }) => centre - plate / 2,
    right: ({ centre, block, plate, edge }) => centre + block / 2 - plate + edge,
};

type TextBoxNote = {
    text: string;
    size: number;
    x: number;
    y: number;
    style?: EditTextNote["style"];
    block?: EditTextNote["block"];
};

type CanvasBox = { left: number; top: number; right: number; bottom: number };

/**
 * A text's plate on the canvas (units of the canvas's short side, y from the top), as the renderer draws it
 * (Captions.swift drawText, TextPlates.render and textOrigin) on a canvas whose short side is CHECK_SHORT_SIDE_PX:
 * the font is `size` of the short side in whole pixels, the lines are set with the renderer's font (text-metrics.ts)
 * and wrap at the block's width (0.8 of the canvas) less the plate's inset (0.7 × size each side, 0.38 × size above
 * and below). x, y is the block's centre: a centred text is centred on it, and a left- or right-aligned text lines up
 * at the block's left or right edge what a viewer sees of it, so texts with the same x and block line up. A plate text
 * lines up its plate and keeps it inside the canvas; a plain text draws no plate, so it lines up its letters and keeps
 * them inside the canvas, and its plate (the inset around them) may reach past the block's and the canvas's edge.
 */
export function textBox(note: TextBoxNote, canvas: { width: number; height: number }): CanvasBox {
    return textBoxes(note, canvas).plate;
}

/**
 * The plate (textBox) and its letters: the widest line's letters aligned inside the plate less its inset, over the
 * lines that hold a letter. A blank line can make a plate much wider than its letters (text-metrics.ts layoutText).
 * No letters when the text has none.
 */
export function textBoxes(
    note: TextBoxNote,
    canvas: { width: number; height: number }
): { plate: CanvasBox; letters?: CanvasBox } {
    const unit = CHECK_SHORT_SIDE_PX;
    const font = Math.max(8, Math.round(note.size * unit));
    const insetX = font * 0.7;
    const insetY = font * 0.38;
    const canvasWidth = canvas.width * unit;
    const canvasHeight = canvas.height * unit;
    const block = canvasWidth * Math.min(0.95, Math.max(0.15, note.block?.width ?? 0.8));
    const align = note.block?.align ?? "center";
    const set = layoutText(note.text, font, Math.max(font * 4, block - 2 * insetX), align);
    const width = Math.ceil(set.width + 2 * insetX);
    const height = Math.ceil(set.height + 2 * insetY);
    // The plate's leftmost left edge: a plain text keeps its letters inside the canvas, and its plate may reach past the
    // canvas's edge by the inset, which nobody sees.
    const lowest = note.style === "plain" ? -insetX : 0;
    const start = PLATE_LEFT[align]({ centre: note.x * canvasWidth, block, plate: width, edge: -lowest });
    const left = Math.min(Math.max(lowest, start), Math.max(lowest, canvasWidth - width - lowest));
    const top = Math.min(Math.max(0, note.y * canvasHeight - height / 2), Math.max(0, canvasHeight - height));
    const box = (x0: number, y0: number, x1: number, y1: number) => ({
        left: x0 / unit,
        top: y0 / unit,
        right: x1 / unit,
        bottom: y1 / unit,
    });
    const plate = box(left, top, left + width, top + height);

    if (!set.letters) {
        return { plate };
    }

    // TextPlates draws the lines in the plate less its inset, each one aligned there.
    const lettersLeft = {
        left: left + insetX,
        center: left + (width - set.letters.width) / 2,
        right: left + width - insetX - set.letters.width,
    }[align];
    const lettersTop = top + insetY + set.letters.top;
    return {
        plate,
        letters: box(lettersLeft, lettersTop, lettersLeft + set.letters.width, lettersTop + set.letters.height),
    };
}

/**
 * What a viewer sees of a text: a plate text's plate, a plain text's letters. A plain text draws no plate, so its inset
 * and its blank lines are empty space, and a subtitle may sit inside a title's inset without touching its letters.
 * Nothing for a plain text with no letters.
 */
function shownBox(note: EditTextNote, canvas: { width: number; height: number }): CanvasBox | undefined {
    const boxes = textBoxes(note, canvas);
    return note.style === "plain" ? boxes.letters : boxes.plate;
}

function boxesOverlap(a: CanvasBox, b: CanvasBox): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// R5 5 redaction edges
/** A hiding part that covers less of the export than this may miss the frames it was meant for. */
const SHORT_HIDING_US = 150_000;
/** Holes around hiding parts up to this long are worth a look; longer ones are taken as meant. */
const HIDING_HOLE_US = 1_000_000;

/** The source time from which `playUs` of output plays up to `endUs`, through the clips at their speeds. */
function sourceBeforePlayed(project: EditProject, endUs: number, playUs: number): number {
    let leftUs = playUs;

    for (const clip of [...project.clips].reverse()) {
        const toUs = Math.min(clip.toUs, endUs);
        const speed = clip.speed || 1;
        const availableUs = Math.max(0, toUs - clip.fromUs) / speed;

        if (availableUs >= leftUs) {
            return Math.max(0, Math.round(toUs - leftUs * speed));
        }

        leftUs -= availableUs;
    }

    return 0;
}

/**
 * A zoom that runs into a cut but starts its ease out before it: the frames between the start of the ease out and the
 * cut show the view starting to leave, and the cut then jumps from that half-way view. Ending the zoom one ease out
 * after the cut puts the whole ease out inside the cut. The ease runs on the renderer's zoom clock (ZoomCurve.clockUs
 * in TimelineMap.swift): a kept part as long as it plays, a cut part as long as it was recorded. A zoom linked to the
 * zoom after it has no ease out: the view holds, or glides on across the cut, so nothing jumps there.
 */
function zoomEaseAtCutIssues(project: EditProject): EditIssue[] {
    const issues: EditIssue[] = [];
    const ends = cutEdgesOf(project).ends;
    const seconds = (us: number) => Math.round(us / 1000) / 1000;
    const clockUs = (fromUs: number, toUs: number) =>
        playedUs(project, fromUs, toUs) + (toUs - fromUs) - keptUs(project, fromUs, toUs);
    const linked = zoomsLinkedToNext(project);

    for (const zoom of project.zooms) {
        const easeUs = zoom.easeOutMs * 1000;
        const cut = ends.find((end) => end > zoom.startUs && end < zoom.endUs && clockUs(end, zoom.endUs) < easeUs);

        if (cut === undefined || easeUs <= 0 || linked.has(zoom.id)) {
            continue;
        }

        const to = seconds(cut + easeUs + 50_000);
        issues.push({
            severity: "check",
            kind: "zoom-eases-out-at-cut",
            item: `zoom ${zoom.id}`,
            message: `The zoom at ${tenths(zoom.startUs)} s starts its ease out ${seconds(easeUs - clockUs(cut, zoom.endUs))} s before the cut at ${seconds(cut)} s, so its last frames before the cut start to zoom out and the cut jumps from there`,
            fix: `movie.retime({ id: "${zoom.id}", to: ${to} })`,
            at: tenths(cut),
            target: { list: "zooms", id: zoom.id },
            action: { label: "End in the Cut", ops: [{ op: "retime", id: zoom.id, to }] },
        });
    }

    return issues;
}

/** The ids of the zooms linked to the zoom that plays after them, paired per target in play order as ZoomCurve does. */
function zoomsLinkedToNext(project: EditProject): Set<string> {
    const linked = new Set<string>();

    for (const canvas of [false, true]) {
        const ordered = project.zooms
            .filter((zoom) => (zoom.target === "canvas") === canvas)
            .flatMap((zoom) => {
                const startOut = outputSpansOf(project, zoom.startUs, zoom.endUs)[0]?.fromUs;
                return startOut === undefined ? [] : [{ zoom, startOut }];
            })
            .sort((a, b) => a.startOut - b.startOut || a.zoom.startUs - b.zoom.startUs);

        for (const [index, { zoom }] of ordered.entries()) {
            const next = ordered[index + 1];

            if (next && zoomsLinked(project, zoom, next.zoom)) {
                linked.add(zoom.id);
            }
        }
    }

    return linked;
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

/** Whether a movie voiceover that starts at `atUs` plays: the same test as the export (voiceoverExportSpans). */
function voiceoverPlays(project: EditProject, atUs: number): boolean {
    const outUs = outputTimeOf(project, atUs);
    return outUs !== undefined && outUs < outputDurationUs(project);
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
        } else if (
            entry.kind === "text" &&
            entry.endUs - entry.startUs - kept >= SHORTENED_US &&
            playedUs(project, entry.startUs, entry.endUs) < LENGTHENED_US
        ) {
            // A text that runs on past a cut (a step title from titleMarkers) still plays long enough to read; only
            // one the cut leaves under the lengthened time is worth a word, and the lengthen retime repairs it.
            const longer = lengthened(project, entry, SHORTEST_READABLE_US);
            issues.push({
                severity: "check",
                kind: "cut-shortens-text",
                item: `text ${entry.id}`,
                message: `The ${entry.said} (${span(entry.startUs, entry.endUs)}) loses ${tenths(entry.endUs - entry.startUs - kept)} s of its ${tenths(entry.endUs - entry.startUs)} s to a cut and plays for ${tenths(playedUs(project, entry.startUs, entry.endUs))} s`,
                at: tenths(entry.startUs),
                target,
                ...(longer && {
                    fix: `movie.retime({ id: "${entry.id}", ${Object.entries(longer)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ")} })`,
                    action: { label: "Lengthen", ops: [{ op: "retime", id: entry.id, ...longer }] },
                }),
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

// R6 1 moving text
/**
 * The bands hideText or hidePrivate hid where a moving text could not be followed: private, but a larger box than the
 * text, so look at them (a sheet over their time) and keep them or cut the moment.
 */
function uncertainHideIssues(project: EditProject): EditIssue[] {
    return (project.redactions ?? [])
        .filter((part) => part.hide?.uncertain && keptUs(project, part.startUs, part.endUs) > 0)
        .map((part) => ({
            severity: "check" as const,
            // R7 7: one group line for every band ("check ×12 hidden-band: ..."), apart from other hidden part issues.
            kind: "hidden-band",
            item: `hidden part ${part.id}`,
            message: `${part.hide?.by ?? "hideText"} could not follow a moving text from ${tenths(part.startUs)} to ${tenths(part.endUs)} s, so it hides the band the text may cross there (a larger box than the text)`,
            fix: `movie.sheet({ from: ${tenths(part.startUs)}, to: ${tenths(part.endUs)}, source: true }) shows it; unredact("${part.id}") drops the band`,
            at: tenths(part.startUs),
            target: { list: "redactions" as const, id: part.id },
        }));
}

// R7 10 zoom edge text
/** A line counts as cut when at least this share of its width (or height) is outside the zoom's view. */
const CUT_SHARE = 0.08;

/** A picture zoom's view at full scale, as the renderer clamps it (TimelineMap.swift `shown`): fractions of the picture. */
export function zoomView(zoom: { scale: number; focusX: number; focusY: number }): {
    x: number;
    y: number;
    width: number;
    height: number;
} {
    const side = 1 / Math.max(1, zoom.scale);
    const half = side / 2;
    const centerX = Math.min(Math.max(zoom.focusX, half), 1 - half);
    const centerY = Math.min(Math.max(zoom.focusY, half), 1 - half);
    return { x: centerX - half, y: centerY - half, width: side, height: side };
}

/** A part of the picture: fractions of its width and height, y from the top. */
interface PictureRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The part of the (zoomed) picture the frame keeps in view, and what cropped it ("cover", "layout"); empty: none. */
export interface FrameCrop extends PictureRect {
    by: Array<"cover" | "layout">;
}

type ScreenLine = NonNullable<EditFacts["screenText"]>[number]["lines"][number];

/**
 * What the frame leaves in view of the picture it is given (after the zoom: the zoomed view, scaled back to the whole
 * picture), as Looks.swift `framePlacement` crops it: under `fit: "cover"` the room's shape around `focus` (0..1 of
 * the picture from its top left; the renderer passes the cursor there, else the centre), then, when `layout.scale`
 * grows the picture past the room, the room's part of that around `layout.focus`. No frame: the whole picture.
 * RecorderHuntZoomEdgeFrameCropTests.swift pins the Swift side with the same cases as the TS test.
 */
export function frameCrop(project: EditProject, focus: { x: number; y: number } = { x: 0.5, y: 0.5 }): FrameCrop {
    const frame = project.frame;
    if (!frame) {
        return { x: 0, y: 0, width: 1, height: 1, by: [] };
    }

    // Canvas units with its short side 1; the picture's height is the canvas's short side, as in the export.
    const canvas = canvasShape(project);
    const picture = { width: (project.source.width || 16) / (project.source.height || 9), height: 1 };
    const pixel = 1 / CHECK_SHORT_SIDE_PX;
    const room = {
        width: Math.max(2 * pixel, canvas.width - 2 * frame.padding),
        height: Math.max(2 * pixel, canvas.height - 2 * frame.padding),
    };
    const by: FrameCrop["by"] = [];
    let crop = { x: 0, y: 0, width: picture.width, height: picture.height };

    if (frame.fit === "cover") {
        const aspect = room.width / room.height;
        const width = picture.width / picture.height > aspect ? picture.height * aspect : picture.width;
        const height = picture.width / picture.height > aspect ? picture.height : picture.width / aspect;
        const centerX = Math.min(Math.max(focus.x * picture.width, width / 2), picture.width - width / 2);
        const centerY = Math.min(Math.max(focus.y * picture.height, height / 2), picture.height - height / 2);
        crop = { x: centerX - width / 2, y: centerY - height / 2, width, height };
        by.push("cover");
    }

    const grow = Math.min(3, Math.max(0.5, frame.layout?.scale ?? 1));
    const scale = Math.max(0.05, Math.min(room.width / crop.width, room.height / crop.height)) * grow;

    if (crop.width * scale > room.width + pixel / 2 || crop.height * scale > room.height + pixel / 2) {
        const visible = {
            width: Math.min(crop.width * scale, room.width) / scale,
            height: Math.min(crop.height * scale, room.height) / scale,
        };
        const keep = frame.layout?.focus ?? { x: 0.5, y: 0.5 };
        const centerX = Math.min(
            Math.max(crop.x + keep.x * crop.width, crop.x + visible.width / 2),
            crop.x + crop.width - visible.width / 2
        );
        const centerY = Math.min(
            Math.max(crop.y + keep.y * crop.height, crop.y + visible.height / 2),
            crop.y + crop.height - visible.height / 2
        );
        crop = { x: centerX - visible.width / 2, y: centerY - visible.height / 2, ...visible };
        by.push("layout");
    }

    return {
        x: crop.x / picture.width,
        y: crop.y / picture.height,
        width: crop.width / picture.width,
        height: crop.height / picture.height,
        by,
    };
}

/**
 * What a picture zoom shows once the frame has cropped it (`shown`: the zoom's view, then the frame's crop of it), the
 * frame's crop of the zoomed picture, and what the frame alone shows at the same moment (`alone`). The renderer
 * centres a cover crop on the cursor (EditRenderer.coverFocus), which check() cannot place: with a cursor track it
 * puts the cursor at the zoom's focus; without one the renderer centres it, and so does this.
 */
function shownByZoom(
    project: EditProject,
    zoom: { scale: number; focusX: number; focusY: number },
    followsCursor: boolean
): { shown: PictureRect; crop: FrameCrop; alone: FrameCrop } {
    const view = zoomView(zoom);
    const crop = frameCrop(
        project,
        followsCursor
            ? { x: (zoom.focusX - view.x) / view.width, y: (zoom.focusY - view.y) / view.height }
            : { x: 0.5, y: 0.5 }
    );
    const shown = {
        x: view.x + crop.x * view.width,
        y: view.y + crop.y * view.height,
        width: crop.width * view.width,
        height: crop.height * view.height,
    };
    const alone = frameCrop(project, followsCursor ? { x: zoom.focusX, y: zoom.focusY } : { x: 0.5, y: 0.5 });
    return { shown, crop, alone };
}

/** How much of a line's width and height is outside `rect`, and whether any of it is inside. */
function lineOutside(line: ScreenLine, rect: PictureRect): { outX: number; outY: number; seen: boolean } {
    const insideX = Math.max(0, Math.min(line.x + line.width, rect.x + rect.width) - Math.max(line.x, rect.x));
    const insideY = Math.max(0, Math.min(line.y + line.height, rect.y + rect.height) - Math.max(line.y, rect.y));
    return {
        outX: 1 - insideX / Math.max(1e-6, line.width),
        outY: 1 - insideY / Math.max(1e-6, line.height),
        seen: insideX > 0 && insideY > 0,
    };
}

/** A line partly in view with at least CUT_SHARE of its width or height outside `rect`. */
function cutBy(line: ScreenLine, rect: PictureRect): boolean {
    const { outX, outY, seen } = lineOutside(line, rect);
    return seen && (outX >= CUT_SHARE || outY >= CUT_SHARE);
}

/** The lines the zoom cuts: cut in what it shows with the frame, and not already cut by the frame alone. */
function zoomCutLines(lines: readonly ScreenLine[], at: { shown: PictureRect; alone: PictureRect }): ScreenLine[] {
    return lines.filter((line) => cutBy(line, at.shown) && !cutBy(line, at.alone));
}

/**
 * Picture zooms whose view cuts screen text at its edge (round 7: 1.2x on a phone cut the side labels in half), from
 * the screen text already read (never an OCR here). The view is what the viewer sees: the zoom's view, then the
 * frame's cover or grown-layout crop of it (`shownByZoom`); a line the frame alone cuts is not the zoom's. One issue
 * per zoom, with a setZoom that keeps the cut lines whole when a smaller zoom (1.05x or more) does, checked again
 * through the same view; otherwise the message says so and names the frame's crop. A follow zoom moves with the
 * cursor and a canvas zoom has no picture view: neither is checked.
 */
function zoomEdgeIssues(project: EditProject, facts: EditFacts): EditIssue[] {
    const screenText = facts.screenText ?? [];
    if (screenText.length === 0) {
        return [];
    }

    const issues: EditIssue[] = [];
    const followsCursor = project.frame?.fit === "cover" && facts.hasCursorTrack;

    for (const zoom of project.zooms) {
        if (zoom.mode === "follow" || zoom.target === "canvas" || keptUs(project, zoom.startUs, zoom.endUs) === 0) {
            continue;
        }

        const during = new Map<string, ScreenLine>();

        for (const frame of screenText) {
            if (frame.untilUs <= zoom.startUs || frame.atUs >= zoom.endUs) {
                continue;
            }

            for (const line of frame.lines) {
                during.set(`${line.text}@${Math.round(line.x * 100)},${Math.round(line.y * 100)}`, line);
            }
        }

        const all = [...during.values()];
        const now = shownByZoom(project, zoom, followsCursor);
        const lines = zoomCutLines(all, now);

        if (lines.length === 0) {
            continue;
        }

        const { shown, crop } = now;
        const left = Math.min(shown.x, ...lines.map((line) => line.x));
        const right = Math.max(shown.x + shown.width, ...lines.map((line) => line.x + line.width));
        const top = Math.min(shown.y, ...lines.map((line) => line.y));
        const bottom = Math.max(shown.y + shown.height, ...lines.map((line) => line.y + line.height));
        // The shown part of a zoom at scale s is the crop's size over s: the largest s that holds the lines and what
        // shows now, with the view's centre placed so the crop's part lands on their centre.
        const fitted =
            Math.floor(Math.min(crop.width / (right - left + 0.02), crop.height / (bottom - top + 0.02)) * 100) / 100;
        const focus = {
            x: Math.round(((left + right) / 2 + (0.5 - crop.x - crop.width / 2) / Math.max(1, fitted)) * 1000) / 1000,
            y: Math.round(((top + bottom) / 2 + (0.5 - crop.y - crop.height / 2) / Math.max(1, fitted)) * 1000) / 1000,
        };
        const after =
            fitted >= 1.05 && fitted < zoom.scale
                ? shownByZoom(project, { scale: fitted, focusX: focus.x, focusY: focus.y }, followsCursor)
                : undefined;
        const fits =
            after !== undefined &&
            lines.every((line) => {
                const { outX, outY } = lineOutside(line, after.shown);
                return outX < CUT_SHARE && outY < CUT_SHARE;
            }) &&
            zoomCutLines(all, after).length === 0;
        const cropName = crop.by.length > 0 ? `the frame's ${crop.by.join(" and ")} crop` : undefined;
        const named = lines
            .slice(0, 2)
            .map((line) => `"${line.text.length > 24 ? `${line.text.slice(0, 23)}…` : line.text}"`)
            .join(", ");
        const where = cropName ? `the edge of what ${cropName} leaves in view` : "its edge";
        const remedy = fits
            ? `${fitted}x around them keeps them whole`
            : cropName
              ? `no zoom of 1.05x or more keeps them whole inside ${cropName}, so move its focus, remove it or change the frame`
              : "a smaller zoom or another focus keeps them whole";
        const cursorNote = followsCursor
            ? " (the export moves the cover crop with the cursor; this judges it with the cursor at the zoom's focus)"
            : "";
        issues.push({
            severity: "check",
            kind: "zoom-cuts-text",
            item: `zoom ${zoom.id}`,
            message: `The zoom at ${tenths(zoom.startUs)} s (${zoom.scale}x) cuts ${lines.length} line${lines.length === 1 ? "" : "s"} of screen text at ${where} (${named}${lines.length > 2 ? ", …" : ""}); ${remedy}${cursorNote}`,
            at: tenths(zoom.startUs),
            target: { list: "zooms", id: zoom.id },
            ...(fits
                ? {
                      fix: `movie.apply([{ op: "setZoom", id: "${zoom.id}", scale: ${fitted}, focus: { x: ${focus.x}, y: ${focus.y} } }])`,
                      action: {
                          label: "Fit Text",
                          ops: [{ op: "setZoom" as const, id: zoom.id, scale: fitted, focus }],
                      },
                  }
                : {}),
        });
    }

    return issues;
}
