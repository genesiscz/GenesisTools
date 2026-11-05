import { basename } from "node:path";
import { meetingEditorSource } from "@app/meetings/lib/editor-project";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { type RecordingStoreId, recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import {
    type DisplayPlan,
    type DisplayRange,
    makeProxy,
    type ProxyOptions,
    type ProxyResult,
    readDisplayPlan,
} from "./proxy";

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

    return prepareFramesMovie(folder, keptPlan(folder, [range]));
}

/**
 * Makes the proxy again with exactly `plan` (an earlier proxy.json), which puts a display switch back: the editor's
 * undo of a switch, and `tools recorder proxy --plan <file>`.
 */
export async function restoreDisplayPlan(folder: string, plan: Pick<DisplayPlan, "policy" | "windowSec" | "ranges">) {
    return prepareFramesMovie(folder, { plan });
}
