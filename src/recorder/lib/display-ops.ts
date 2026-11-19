import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { sourceTimeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { readFrameFolder, type SourceFrame } from "@genesiscz/utils/recording-editor/source";
import { readRecordingManifest, readRecordingManifestSafe } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { openProject } from "./edit";
import { keepingSwitchStep, keptPlan, prepareFramesMovie } from "./frames-movie";
import { recordingFolderOf } from "./moments";
import { type DisplayPlan, type DisplayRange, overrideRanges, readDisplayPlan } from "./proxy";

const { log } = logger.scoped("recorder-display-ops");

/**
 * The ops that change which display a frames recording of several displays shows when. They change the recording's
 * display plan (proxy.json) and make its proxy movie again, so they are not edit ops: `tools recorder apply` runs them
 * before the edit ops of the same call, and each call's display ops are one step that ⌘Z, `undoDisplaySwitch()` and
 * `tools recorder proxy --undo-switch` take back.
 */
export const DISPLAY_OP_NAMES = ["switchDisplay", "hideDisplay", "moveDisplaySwitch"] as const;

const displayId = z.number().int().nonnegative();

export const displayOpSchema = z.discriminatedUnion("op", [
    /** Show `display` from `from` to `to` (source seconds), whatever showed there. */
    z
        .object({ op: z.literal("switchDisplay"), display: displayId, from: sourceTimeSchema, to: sourceTimeSchema })
        .strict(),
    /** Show another display wherever `display` shows between `from` and `to` (the whole recording without them). */
    z
        .object({
            op: z.literal("hideDisplay"),
            display: displayId,
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
        })
        .strict(),
    /** Move the switch between two displays that is at `at` (within half a second) to `to`. */
    z.object({ op: z.literal("moveDisplaySwitch"), at: sourceTimeSchema, to: sourceTimeSchema }).strict(),
]);
export type DisplayOp = z.infer<typeof displayOpSchema>;

/** True for a raw op whose name is a display op, so a caller can split a mixed list before parsing it. */
export function isDisplayOp(raw: unknown): boolean {
    return (
        typeof raw === "object" &&
        raw !== null &&
        "op" in raw &&
        (DISPLAY_OP_NAMES as readonly unknown[]).includes((raw as { op: unknown }).op)
    );
}

/** One display, one segment and the switch points of a display plan, in source seconds (what the ops take). */
export interface DisplayTimeline {
    policy: DisplayPlan["policy"];
    /** Every display the recording has frames of, in the recording's order. */
    displays: Array<{
        id: number;
        name: string;
        /** Its first frame: before it the display has no picture to show. */
        firstSec: number;
        /** How long the movie shows it. */
        shownSec: number;
        /** How many segments show it. */
        segments: number;
    }>;
    /** What the movie shows, from the start to the end, one display per segment. */
    segments: Array<{ from: number; to: number; display: number; name: string }>;
    /** The times where the movie changes from one display to another. */
    switches: number[];
}

const seconds = (us: number) => Math.round(us / 1000) / 1000;

/** The display plan as displays, segments and switch points; names from recording.json, else "Display <id>". */
export function displayTimeline(
    plan: Pick<DisplayPlan, "policy" | "ranges">,
    frames: readonly SourceFrame[],
    names: ReadonlyArray<{ id: number; name: string }> = []
): DisplayTimeline {
    const firstUs = new Map<number, number>();

    for (const frame of frames) {
        if (frame.displayId !== undefined && !firstUs.has(frame.displayId)) {
            firstUs.set(frame.displayId, frame.atUs);
        }
    }

    const order = [
        ...names.map((entry) => entry.id),
        ...firstUs.keys(),
        ...plan.ranges.map((range) => range.displayId),
    ];
    const ids = [...new Set(order)].filter(
        (id) => firstUs.has(id) || plan.ranges.some((range) => range.displayId === id)
    );
    const nameOf = (id: number) => names.find((entry) => entry.id === id)?.name ?? `Display ${id}`;
    const live = plan.ranges.filter((range) => range.toUs > range.fromUs);
    const switches = live
        .slice(1)
        .flatMap((range, index) => (range.displayId !== live[index].displayId ? [range.fromUs] : []));

    return {
        policy: plan.policy,
        displays: ids.map((id) => {
            const own = live.filter((range) => range.displayId === id);
            return {
                id,
                name: nameOf(id),
                firstSec: seconds(firstUs.get(id) ?? own[0]?.fromUs ?? 0),
                shownSec: seconds(own.reduce((total, range) => total + range.toUs - range.fromUs, 0)),
                segments: own.length,
            };
        }),
        segments: live.map((range) => ({
            from: seconds(range.fromUs),
            to: seconds(range.toUs),
            display: range.displayId,
            name: nameOf(range.displayId),
        })),
        switches: switches.map(seconds),
    };
}

const SWITCH_REACH_US = 500_000;

/**
 * The display switches (`overrideRanges` input) that make each op true, in order: each op sees the plan the ops
 * before it made. A display without frames, a range that ends before it starts, a hide that leaves nothing to show
 * and a switch time with no switch near it are refused with the facts to try again.
 */
export function displayOpOverrides(
    ranges: readonly DisplayRange[],
    frames: readonly SourceFrame[],
    ops: readonly DisplayOp[]
): DisplayRange[] {
    const firstUs = new Map<number, number>();

    for (const frame of frames) {
        if (frame.displayId !== undefined && !firstUs.has(frame.displayId)) {
            firstUs.set(frame.displayId, frame.atUs);
        }
    }

    const known = () => [...firstUs.keys()].join(", ") || "none";
    let current = ranges.filter((range) => range.toUs > range.fromUs).map((range) => ({ ...range }));
    const endUs = current.at(-1)?.toUs ?? 0;
    const overrides: DisplayRange[] = [];

    const requireDisplay = (id: number) => {
        if (!firstUs.has(id)) {
            throw new Error(`there are no frames of display ${id}; the displays are ${known()}`);
        }
    };

    for (const op of ops) {
        const next: DisplayRange[] = [];

        if (op.op === "switchDisplay") {
            requireDisplay(op.display);
            const fromUs = Math.max(0, timeToUs(op.from));
            // Not clamped to the plan's end: the last segment runs to the movie's end, so a switch to the end replaces it.
            const toUs = timeToUs(op.to);

            if (fromUs >= endUs) {
                throw new RangeError(
                    `switchDisplay: ${seconds(fromUs)} s is after the last frame (${seconds(endUs)} s)`
                );
            }

            if (toUs <= fromUs) {
                throw new RangeError(
                    `switchDisplay: the range ends (${seconds(toUs)} s) before it starts (${seconds(fromUs)} s)`
                );
            }

            next.push({ fromUs, toUs, displayId: op.display });
        } else if (op.op === "hideDisplay") {
            requireDisplay(op.display);
            const fromUs = op.from === undefined ? 0 : Math.max(0, timeToUs(op.from));
            const toUs = op.to === undefined ? endUs : Math.min(endUs, timeToUs(op.to));

            for (const [index, range] of current.entries()) {
                const pieceFrom = Math.max(fromUs, range.fromUs);
                const pieceTo = Math.min(toUs, range.toUs);

                if (range.displayId !== op.display || pieceTo <= pieceFrom) {
                    continue;
                }

                const before = current[index - 1]?.displayId;
                const after = current[index + 1]?.displayId;
                const other = [...firstUs.entries()].find(([id, first]) => id !== op.display && first < pieceTo)?.[0];
                const replacement = [before, after, other].find((id) => id !== undefined && id !== op.display);

                if (replacement === undefined) {
                    throw new Error(
                        `display ${op.display} is the only display with frames from ${seconds(pieceFrom)} s to ${seconds(pieceTo)} s, so nothing else can show there`
                    );
                }

                next.push({ fromUs: pieceFrom, toUs: pieceTo, displayId: replacement });
            }

            if (next.length === 0) {
                const shown = current.filter((range) => range.displayId === op.display);
                throw new Error(
                    `display ${op.display} does not show from ${seconds(fromUs)} s to ${seconds(toUs)} s; it shows ${
                        shown.map((range) => `${seconds(range.fromUs)}-${seconds(range.toUs)} s`).join(", ") ||
                        "nowhere"
                    }`
                );
            }
        } else {
            const atUs = timeToUs(op.at);
            const toUs = Math.min(endUs, Math.max(0, timeToUs(op.to)));
            const boundaries = current
                .slice(1)
                .map((range, index) => ({ atUs: range.fromUs, left: current[index].displayId, right: range.displayId }))
                .filter((boundary) => boundary.left !== boundary.right);
            const nearest = boundaries
                .filter((boundary) => Math.abs(boundary.atUs - atUs) <= SWITCH_REACH_US)
                .sort((a, b) => Math.abs(a.atUs - atUs) - Math.abs(b.atUs - atUs))[0];

            if (!nearest) {
                throw new Error(
                    `there is no display switch within 0.5 s of ${seconds(atUs)} s; the switches are at ${
                        boundaries.map((boundary) => `${seconds(boundary.atUs)} s`).join(", ") ||
                        "no time (one display shows throughout)"
                    }`
                );
            }

            if (toUs > nearest.atUs) {
                next.push({ fromUs: nearest.atUs, toUs, displayId: nearest.left });
            } else if (toUs < nearest.atUs) {
                next.push({ fromUs: toUs, toUs: nearest.atUs, displayId: nearest.right });
            }
        }

        overrides.push(...next);
        current = overrideRanges(current, next);
    }

    return overrides;
}

/** The display timeline of a frames folder's proxy movie, or undefined when it has no display plan yet. */
export function readDisplayTimeline(folder: string): DisplayTimeline | undefined {
    const plan = readDisplayPlan(folder);

    if (!plan) {
        return undefined;
    }

    return displayTimeline(plan, readFrameFolder(folder), readRecordingManifestSafe(folder)?.manifest?.displays ?? []);
}

/**
 * Runs display ops on a frames folder as ONE display switch step (one undo), and answers the new proxy movie with the
 * timeline it shows now. A call whose ops change nothing is refused, so an agent learns that, not a remade movie.
 */
export async function applyDisplayOps(folder: string, ops: readonly DisplayOp[]) {
    const plan = readDisplayPlan(folder);

    if (!plan) {
        throw new Error(
            `${folder} has no display plan yet (proxy.json); make its movie first: ${toolCommand("recorder proxy")} <recording>`
        );
    }

    const overrides = displayOpOverrides(plan.ranges, readFrameFolder(folder), ops);
    const after = overrideRanges(plan.ranges, overrides);

    if (sameRanges(after, plan.ranges)) {
        throw new Error("these display ops change nothing: the movie already shows that");
    }

    log.info({ folder, ops: ops.map((op) => op.op), overrides: overrides.length }, "display ops");
    const movie = await keepingSwitchStep(folder, () => prepareFramesMovie(folder, keptPlan(folder, overrides)));
    return { ...movie, displays: readDisplayTimeline(folder) };
}

function sameRanges(a: readonly DisplayRange[], b: readonly DisplayRange[]): boolean {
    const live = (list: readonly DisplayRange[]) => list.filter((range) => range.toUs > range.fromUs);
    const left = live(a);
    const right = live(b);
    return (
        left.length === right.length &&
        left.every(
            (range, index) =>
                range.fromUs === right[index].fromUs &&
                range.toUs === right[index].toUs &&
                range.displayId === right[index].displayId
        )
    );
}

/**
 * The frames folder of a recording (a library id, `last`, a folder, a movie or an edit.json), for a display op: a
 * plain movie or a video recording has no display frames, and the refusal says so.
 */
export async function displayFramesFolder(recording: string, doing: string): Promise<string> {
    const opened = await openProject(recording);
    const folder = recordingFolderOf(opened);

    if (!folder) {
        throw new Error(`${opened.project.source.video} is a plain movie: it has no displays, so nothing to ${doing}`);
    }

    // A video recording has a folder but no frames, and the error was "has no frames to make a movie of" (NR35).
    if (readRecordingManifest(folder)?.settings?.kind === "video") {
        throw new Error(
            `this is a video recording: it has no display frames to ${doing}; only a frames recording (a meeting or a library frames recording) has them`
        );
    }

    return folder;
}
