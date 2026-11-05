import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { meetingEditorSource } from "@app/meetings/lib/editor-project";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { type RecordingStoreId, recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import {
    type DisplayPlan,
    type DisplayRange,
    displayPlanSchema,
    makeProxy,
    type ProxyOptions,
    type ProxyResult,
    readDisplayPlan,
} from "./proxy";

const { log } = logger.scoped("recorder-frames-movie");

type FramesMovie = ProxyResult & { transcript?: string; captions?: number };

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

/** proxy.mp4 for a frames folder, made the way its store makes one; a folder in no store gets the plain proxy. */
export async function prepareFramesMovie(folder: string, options: ProxyOptions): Promise<FramesMovie> {
    const store = recordingStoreOf(folder);
    return store ? FRAMES_MOVIES[store.id](folder, options) : makeProxy(folder, options);
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
