import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { meetingEditorSource } from "@app/meetings/lib/editor-project";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import {
    cutRange,
    type EditProject,
    editProjectSchema,
    projectPathFor,
    readProject,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import { type RecordingStoreId, recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { z } from "zod";
import { EDITOR_VIDEO_LIMITS, inItsFolder, pushUndo } from "./edit";
import {
    boxInFrame,
    boxInProxy,
    type DisplayPlan,
    type DisplayRange,
    displayPlanSchema,
    frameSizesOf,
    makeProxy,
    PROXY_FILE,
    type ProxyOptions,
    type ProxyResult,
    proxyCanvas,
    readDisplayPlan,
} from "./proxy";

const { log } = logger.scoped("recorder-frames-movie");

/** What fitting the edit beside a remade proxy did (fitEditToProxy). */
export interface FittedEdit {
    path: string;
    /** Hidden parts, shapes, picture zooms, lenses and a layout focus moved onto the new picture. */
    moved: number;
    /** Items left where they were: the old picture showed several sizes and its plan was gone. */
    unplaced: number;
    source: { width: number; height: number; durationUs: number };
}

type FramesMovie = ProxyResult & {
    transcript?: string;
    captions?: number;
    /** The edit beside the proxy, moved onto its picture and its length; absent when nothing about them changed. */
    fittedEdit?: FittedEdit;
    /** Why the edit could not be fitted to the new proxy; the proxy itself was made. */
    fitError?: string;
};

/** A meeting's folder also gets its recording.json and the transcript as captions with the speakers' names. */
async function meetingFramesMovie(folder: string, options: ProxyOptions): Promise<FramesMovie> {
    const store = new MeetingStore();
    const record = store.read(basename(folder));

    if (!record) {
        return makeProxy(folder, options);
    }

    const prepared = await meetingEditorSource({ store, record, ...options });
    return {
        ...prepared.proxy,
        ...(prepared.transcript ? { transcript: prepared.transcript } : {}),
        captions: prepared.captions,
    };
}

/** How each recording store makes the movie of a frames folder. */
const FRAMES_MOVIES: Record<RecordingStoreId, (folder: string, options: ProxyOptions) => Promise<FramesMovie>> = {
    recordings: makeProxy,
    meetings: meetingFramesMovie,
};

/**
 * proxy.mp4 for a frames folder, made the way its store makes one; a folder in no store gets the plain proxy. An edit
 * beside it is then fitted to the new movie (fitEditToProxy), so its hidden parts stay over the text they hide.
 */
export async function prepareFramesMovie(folder: string, options: ProxyOptions): Promise<FramesMovie> {
    const store = recordingStoreOf(folder);
    const before = await editBeforeRemake(folder);
    const movie = await (store ? FRAMES_MOVIES[store.id](folder, options) : makeProxy(folder, options));

    if (!before) {
        return movie;
    }

    try {
        const fitted = await fitEditToProxy(folder, before);
        return fitted ? { ...movie, fittedEdit: fitted } : movie;
    } catch (error) {
        log.warn({ error, folder, edit: before.path }, "the proxy was made, but its edit was not fitted to it");
        return { ...movie, fitError: error instanceof Error ? error.message : String(error) };
    }
}

type Size = { width: number; height: number };
type Box = { x: number; y: number; width: number; height: number };

type MovieFacts = { width: number; height: number; durationUs: number };

/** A movie's picture and length as openProject reads them for a new edit; undefined when it does not probe. */
async function movieFacts(movie: string): Promise<MovieFacts | undefined> {
    if (!existsSync(movie)) {
        return undefined;
    }

    try {
        const info = await probeVideo({ input: movie, limits: EDITOR_VIDEO_LIMITS });
        return {
            width: info.displayWidth || info.width,
            height: info.displayHeight || info.height,
            durationUs: info.durationUs,
        };
    } catch (error) {
        log.debug({ error, movie }, "the proxy movie does not probe");
        return undefined;
    }
}

/** The edit beside a frames folder's proxy as the proxy is about to be made again: its file, the picture, the plan. */
interface EditBeforeRemake {
    path: string;
    /**
     * The picture the edit's fractions were made over: its own source size, which is the proxy it was made on. A switch
     * before the fixed picture changed the movie and left this size, and the items made before it, as they were.
     */
    picture: Size;
    /** The proxy on disk as ffprobe reads it; absent when there was none or it did not probe. */
    movie?: MovieFacts;
    plan?: DisplayPlan;
}

async function editBeforeRemake(folder: string): Promise<EditBeforeRemake | undefined> {
    const movie = join(folder, PROXY_FILE);
    const path = projectPathFor(movie);

    if (!existsSync(path)) {
        return undefined;
    }

    let project: EditProject;

    try {
        project = readProject(path);
    } catch (error) {
        log.debug({ error, path }, "the edit beside the proxy does not read; it is not fitted to the new proxy");
        return undefined;
    }

    if (basename(project.source.video) !== PROXY_FILE) {
        return undefined;
    }

    const facts = await movieFacts(movie);
    return {
        path,
        picture: { width: project.source.width, height: project.source.height },
        ...(facts ? { movie: facts } : {}),
        plan: readDisplayPlan(folder),
    };
}

/** The display a plan shows at a recording time; its last range runs on, as framesForPlan reads it. */
function displayOfPlanAt(plan: DisplayPlan | undefined, us: number): number | undefined {
    const live = plan?.ranges.filter((range) => range.toUs > range.fromUs) ?? [];
    const range = live.find((one, index) => us >= one.fromUs && (us < one.toUs || index === live.length - 1));
    return (range ?? live[0])?.displayId;
}

/** What moves an edit made over one proxy picture onto another. */
export interface PictureFit {
    /** The picture the edit's fractions were made over (the old proxy's size). */
    from: Size;
    /** The proxy's picture now. */
    to: ReturnType<typeof proxyCanvas>;
    /** Each display's frame size. */
    sizes: ReadonlyMap<number | undefined, Size>;
    /** The display the old picture showed at a recording time (its plan); needed when it showed several sizes. */
    displayAt: (us: number) => number | undefined;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** A fraction to six places, so a moved item reads the same in JSON on every run. */
const micro = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const boxOf = (box: Box): Box => ({ x: box.x, y: box.y, width: box.width, height: box.height });

/**
 * The edit with its items in SOURCE-picture fractions (hidden parts with their keys and visible areas, shapes, picture
 * zooms' focus, lenses, the layout's focus) moved from the old picture to the new one: each through the frame of the
 * display the old picture showed at its start (boxInFrame), into the new picture (boxInProxy). Texts and canvas
 * zooms are in the canvas and stay. An item whose display is unknown stays, and is counted as unplaced.
 */
export function fitEditToPicture(
    project: EditProject,
    fit: PictureFit
): { project: EditProject; moved: number; unplaced: number } {
    // An odd frame size is one pixel smaller in a movie of one size (even sides): the same picture.
    if (Math.abs(fit.from.width - fit.to.width) <= 1 && Math.abs(fit.from.height - fit.to.height) <= 1) {
        return { project, moved: 0, unplaced: 0 };
    }

    // One frame size filled the old picture (its plan showed displays of one size): every item was over that size.
    const filling = [...fit.sizes.values()].find(
        (size) => Math.abs(size.width - fit.from.width) <= 1 && Math.abs(size.height - fit.from.height) <= 1
    );
    const place = (box: Box, us: number): Box | undefined => {
        const frame = filling ?? fit.sizes.get(fit.displayAt(us));

        if (!frame) {
            return undefined;
        }

        const inFrame = boxInFrame(box, frame, { ...fit.from, letterboxed: filling === undefined });
        const x = clamp01(inFrame.x);
        const y = clamp01(inFrame.y);
        const placed = boxInProxy(
            { x, y, width: clamp01(inFrame.x + inFrame.width) - x, height: clamp01(inFrame.y + inFrame.height) - y },
            frame,
            fit.to
        );
        return { x: micro(placed.x), y: micro(placed.y), width: micro(placed.width), height: micro(placed.height) };
    };
    const point = (at: { x: number; y: number }, us: number) => {
        const placed = place({ ...at, width: 0, height: 0 }, us);
        return placed ? { x: placed.x, y: placed.y } : undefined;
    };
    let moved = 0;
    let unplaced = 0;
    const count = <T>(item: T | undefined): item is T => {
        if (item === undefined) {
            unplaced++;
            return false;
        }

        moved++;
        return true;
    };

    const redactions = project.redactions?.map((part) => {
        const rect = place(boxOf(part), part.startUs);

        if (!count(rect)) {
            return part;
        }

        return {
            ...part,
            ...rect,
            width: Math.max(0.005, rect.width),
            height: Math.max(0.005, rect.height),
            ...(part.track
                ? { track: part.track.map((key) => ({ ...key, ...(place(boxOf(key), key.atUs) ?? boxOf(key)) })) }
                : {}),
            ...(part.exclude ? { exclude: part.exclude.map((area) => place(boxOf(area), part.startUs) ?? area) } : {}),
        };
    });
    const shapes = project.shapes?.map((shape) => {
        const from = point({ x: shape.x1, y: shape.y1 }, shape.startUs);
        const to = point({ x: shape.x2, y: shape.y2 }, shape.startUs);
        const ends = from && to ? { from, to } : undefined;
        return count(ends) ? { ...shape, x1: ends.from.x, y1: ends.from.y, x2: ends.to.x, y2: ends.to.y } : shape;
    });
    const zooms = project.zooms.map((zoom) => {
        if (zoom.target === "canvas") {
            return zoom;
        }

        const focus = point({ x: zoom.focusX, y: zoom.focusY }, zoom.startUs);
        return count(focus) ? { ...zoom, focusX: focus.x, focusY: focus.y } : zoom;
    });
    const lens = project.lens && {
        ...project.lens,
        items: project.lens.items.map((item) => {
            const at = point(item, item.startUs);
            return count(at) ? { ...item, ...at } : item;
        }),
    };
    const layout = project.frame?.layout;
    const focus = layout?.focus && point(layout.focus, project.clips[0]?.fromUs ?? 0);
    const frame =
        project.frame && layout?.focus && count(focus)
            ? { ...project.frame, layout: { ...layout, focus } }
            : project.frame;

    return {
        project: {
            ...project,
            zooms,
            ...(redactions ? { redactions } : {}),
            ...(shapes ? { shapes } : {}),
            ...(lens ? { lens } : {}),
            ...(frame ? { frame } : {}),
        },
        moved,
        unplaced,
    };
}

/** The undo step's name for fitting an edit to a remade proxy, and who saved that change. */
const FIT_OP = "fitToProxy";
const FIT_BY = "proxy movie";

/** Saves the fitted edit and its undo step while the file is still the one it was fitted from. */
function saveFittedEdit(path: string, read: EditProject, next: EditProject): "saved" | "moved" | "busy" {
    try {
        return withPathArbitrationSync(path, () => {
            if (readProject(path).revision !== read.revision) {
                return "moved";
            }

            const written = writeProject(path, next, FIT_BY);
            pushUndo({ editPath: path, before: read, afterRevision: written.revision, ops: [FIT_OP] });
            return "saved";
        });
    } catch (error) {
        if (isArbitrationBusy(error)) {
            log.debug({ error, path }, "another process saves the edit now; the fit tries again");
            return "busy";
        }

        throw error;
    }
}

/**
 * The edit's source facts for the remade movie: its width and height, and its length moved by as much as the movie's
 * changed (the edit keeps its own measure, AVFoundation's or ffprobe's, which can differ by the sound's tail). A
 * shorter movie (a proxy made long by an empty range past the last frame) cuts the clips past its end.
 */
function withMovieFacts(project: EditProject, before: MovieFacts | undefined, after: MovieFacts): EditProject {
    const grownUs = before ? after.durationUs - before.durationUs : 0;
    const durationUs = Math.abs(grownUs) > 1000 ? project.source.durationUs + grownUs : project.source.durationUs;
    const cut =
        durationUs < project.source.durationUs && project.clips.some((clip) => clip.toUs > durationUs)
            ? cutRange(project, durationUs, project.source.durationUs)
            : project;
    return { ...cut, source: { ...cut.source, width: after.width, height: after.height, durationUs } };
}

/**
 * Fits the edit beside a frames folder's remade proxy to it: its picture items move from the picture they were made
 * over to the new one (fitEditToPicture), and its source width, height and length follow the new movie's. One edit
 * change with one undo step; nothing is saved when nothing changed (the picture is the same for every plan since
 * makeProxy keeps every display's frames in it, so only an edit made on an older proxy changes, once).
 */
async function fitEditToProxy(folder: string, before: EditBeforeRemake): Promise<FittedEdit | undefined> {
    const facts = await movieFacts(join(folder, PROXY_FILE));

    if (!facts) {
        return undefined;
    }

    const sizes = frameSizesOf(readFrameFolder(folder));
    const fit: PictureFit = {
        from: before.picture,
        to: proxyCanvas([...sizes.values()]),
        sizes,
        displayAt: (us) => displayOfPlanAt(before.plan, us),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
        // A copied recording folder's edit names the original folder's movie; it is saved with its own, as edits are.
        const project = inItsFolder(before.path, readProject(before.path));
        const fitted = fitEditToPicture(project, fit);
        const next = withMovieFacts(fitted.project, before.movie, facts);

        if (SafeJSON.stringify(next) === SafeJSON.stringify(project)) {
            return undefined;
        }

        const valid = editProjectSchema.safeParse(next);

        if (!valid.success) {
            throw new Error(`the fitted edit does not read: ${valid.error.issues[0]?.message ?? "invalid"}`);
        }

        const outcome = saveFittedEdit(before.path, project, valid.data);

        if (outcome === "saved") {
            const { width, height, durationUs } = valid.data.source;
            log.info(
                { folder, edit: before.path, from: before.picture, to: facts, moved: fitted.moved },
                "the edit was fitted to the remade proxy"
            );
            return {
                path: before.path,
                moved: fitted.moved,
                unplaced: fitted.unplaced,
                source: { width, height, durationUs },
            };
        }

        if (outcome === "busy") {
            await Bun.sleep(25);
        }
    }

    throw new Error("the edit kept changing on disk while it was fitted to the new proxy");
}

/**
 * The proxy options that keep the saved plan (proxy.json) and lay `switches` over it: a new switch from the editor or
 * the CLI keeps every earlier one, because the plan already holds them. Without a plan, the switches alone.
 */
export function keptPlan(
    folder: string,
    switches: readonly DisplayRange[]
): { windowSec?: number; overrides: DisplayRange[] } {
    const plan = readDisplayPlan(folder);

    if (!plan) {
        return { overrides: [...switches] };
    }

    return { windowSec: plan.windowSec, overrides: [...plan.ranges, ...switches] };
}

/** Shows `displayId` from `fromUs` to `toUs` (recording time) and makes the proxy again with the rest of the plan kept. */
export async function switchDisplay(folder: string, range: DisplayRange) {
    if (range.toUs <= range.fromUs) {
        throw new RangeError(`the range ends (${range.toUs / 1e6} s) before it starts (${range.fromUs / 1e6} s)`);
    }

    return keepingSwitchStep(folder, () => prepareFramesMovie(folder, keptPlan(folder, [range])));
}

/** At most this many display switches are kept to undo, and to redo. */
export const SWITCH_STEPS = 30;

/**
 * `proxy.undo.json` beside proxy.json: each display switch as the plans before and after it, newest last, so the CLI
 * (`tools recorder proxy --undo-switch`), the REPL (`undoDisplaySwitch()`) and the editor window take back the same
 * switch, and a redo makes it again. A proxy without a plan before the switch has `before: null`.
 */
export const SWITCH_JOURNAL_FILE = "proxy.undo.json";

const switchStepSchema = z.object({ before: displayPlanSchema.nullable(), after: displayPlanSchema });
const switchJournalSchema = z.object({
    undo: z.array(switchStepSchema).default([]),
    redo: z.array(switchStepSchema).default([]),
});
type SwitchJournal = z.infer<typeof switchJournalSchema>;

function readSwitchJournal(folder: string): SwitchJournal {
    const path = join(folder, SWITCH_JOURNAL_FILE);

    if (!existsSync(path)) {
        return { undo: [], redo: [] };
    }

    const parsed = switchJournalSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        log.debug(
            { path, error: parsed.error.message },
            "the display switch journal does not read; it starts again empty"
        );
        return { undo: [], redo: [] };
    }

    return parsed.data;
}

function writeSwitchJournal(folder: string, journal: SwitchJournal): void {
    const steps = { undo: journal.undo.slice(-SWITCH_STEPS), redo: journal.redo.slice(-SWITCH_STEPS) };
    atomicWriteFileSync(join(folder, SWITCH_JOURNAL_FILE), SafeJSON.stringify(steps, null, 2));
}

function samePlan(a: DisplayPlan | null | undefined, b: DisplayPlan | null | undefined): boolean {
    return SafeJSON.stringify(a ?? null) === SafeJSON.stringify(b ?? null);
}

/** Runs `make` (a proxy with switches) and keeps the plan before and after it as one display switch to undo. */
export async function keepingSwitchStep<T>(folder: string, make: () => Promise<T>): Promise<T> {
    const before = readDisplayPlan(folder) ?? null;
    const result = await make();
    const after = readDisplayPlan(folder);

    if (after && !samePlan(before, after)) {
        const journal = readSwitchJournal(folder);
        writeSwitchJournal(folder, { undo: [...journal.undo, { before, after }], redo: [] });
        log.debug({ folder, steps: journal.undo.length + 1 }, "display switch kept to undo");
    }

    return result;
}

/** How many display switches a frames folder has to undo and to redo. */
export function displaySwitchDepth(folder: string): { undo: number; redo: number } {
    const journal = readSwitchJournal(folder);
    return { undo: journal.undo.length, redo: journal.redo.length };
}

/**
 * Takes the last display switch back (`undo`: the proxy is made again with the plan from before it) or makes the last
 * undone one again (`redo`). Refused when proxy.json changed since in another way (a proxy made with another plan),
 * so an undo never throws away a newer switch.
 */
export async function stepDisplaySwitch(
    folder: string,
    direction: "undo" | "redo",
    make: (options: ProxyOptions) => Promise<FramesMovie> = (options) => prepareFramesMovie(folder, options)
): Promise<FramesMovie> {
    const journal = readSwitchJournal(folder);
    const step = direction === "undo" ? journal.undo.at(-1) : journal.redo.at(-1);

    if (!step) {
        throw new Error(`no display switch to ${direction} in ${folder}`);
    }

    const expected = direction === "undo" ? step.after : step.before;
    const target = direction === "undo" ? step.before : step.after;

    if (!samePlan(readDisplayPlan(folder), expected)) {
        throw new Error(
            `the display plan (proxy.json) changed since that switch, so it was not ${direction === "undo" ? "undone" : "made again"}; switch the display again instead`
        );
    }

    const result = await make(target ? { plan: target } : {});
    if (direction === "undo") {
        step.before = readDisplayPlan(folder) ?? null;
    }

    writeSwitchJournal(
        folder,
        direction === "undo"
            ? { undo: journal.undo.slice(0, -1), redo: [...journal.redo, step] }
            : { undo: [...journal.undo, step], redo: journal.redo.slice(0, -1) }
    );
    log.debug({ folder, direction }, "display switch stepped");
    return result;
}

/**
 * Makes the proxy again with exactly `plan` (an earlier proxy.json), which puts a display switch back: the editor's
 * undo of a switch, and `tools recorder proxy --plan <file>`.
 */
export async function restoreDisplayPlan(folder: string, plan: Pick<DisplayPlan, "policy" | "windowSec" | "ranges">) {
    return prepareFramesMovie(folder, { plan });
}
