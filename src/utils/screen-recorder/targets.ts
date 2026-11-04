import { type DisplayMode, RPC_ERRORS, RpcError } from "./control";
import { mainDisplay } from "./displays";
import type { CaptureTarget, DisplayInfo } from "./types";

/**
 * Which displays a capture session records. Two rules live here, one per client, because they differ on purpose:
 * `pieceTargets` (the meetings recorder) falls back to the main display and says why, and can follow the focused
 * display; `pickDisplayIds` (the library recording) refuses an unknown id and records every display for follow-focus.
 */

/** One display as a capture target, with the label notes and warnings use. */
export function displayTarget(display: DisplayInfo): PieceTarget {
    return {
        target: { kind: "display", displayId: display.id },
        displayId: display.id,
        label: `${display.name} (${display.id})`,
    };
}

/** A capture that runs this piece: what it records, and the display its frames belong to when the frame says none. */
export interface PieceTarget {
    target: CaptureTarget;
    displayId: number;
    label: string;
}

/**
 * What to record right now: the displays chosen over the socket (`displays.add|remove|switch`) when there are any,
 * else the policy. `fallback` says why the main display stands in for the asked one.
 */
export function pieceTargets(options: {
    policy: DisplayMode;
    displays: DisplayInfo[];
    followFocus: boolean;
    chosen?: number[];
    /** False: the recorder records one display at a time, so only the first (the main one when it is asked) stays. */
    parallel?: boolean;
}): {
    targets: PieceTarget[];
    fallback?: string;
} {
    const picked = pickTargets(options);

    if (options.parallel !== false || picked.targets.length <= 1) {
        return picked;
    }

    const main = picked.targets.find((target) => target.displayId === mainDisplay(options.displays)?.id);
    return {
        targets: [main ?? picked.targets[0]!],
        fallback: "this recorder records one display at a time; only one display was recorded",
    };
}

function pickTargets(options: {
    policy: DisplayMode;
    displays: DisplayInfo[];
    followFocus: boolean;
    chosen?: number[];
}): {
    targets: PieceTarget[];
    fallback?: string;
} {
    const { policy, displays } = options;
    const main = mainDisplay(displays);
    const one = displayTarget;

    if (!main) {
        return { targets: [] };
    }

    if (options.chosen) {
        const chosen = displays.filter((display) => options.chosen?.includes(display.id));
        return chosen.length > 0
            ? { targets: chosen.map(one) }
            : {
                  targets: [one(main)],
                  fallback: `displays ${options.chosen.join(", ")} were not connected; the main display was recorded while they were missing`,
              };
    }

    if (policy === "all") {
        return { targets: displays.map(one) };
    }

    if (policy === "main") {
        return { targets: [one(main)] };
    }

    if (policy === "follow-focus") {
        return options.followFocus
            ? { targets: [{ target: { kind: "follow-focus" }, displayId: main.id, label: "the focused display" }] }
            : {
                  targets: [one(main)],
                  fallback: "this recorder cannot follow the focused display; the main display was recorded",
              };
    }

    const asked = displays.find((display) => display.index === policy);
    return asked
        ? { targets: [one(asked)] }
        : {
              targets: [one(main)],
              fallback: `display ${policy} was not connected; the main display was recorded while it was missing`,
          };
}

/**
 * The library recording's displays for a mode: every display for `all` and for `follow-focus` (it records them all
 * rather than following), the main one, the one at an index (none when nothing is there), or the given ids without
 * repeats. An id that is not connected is refused.
 */
export function pickDisplayIds(mode: DisplayMode | number[], displays: DisplayInfo[]): number[] {
    if (mode === "all" || mode === "follow-focus") {
        return displays.map((display) => display.id);
    }

    if (mode === "main") {
        const main = mainDisplay(displays);
        return main ? [main.id] : [];
    }

    if (typeof mode === "number") {
        const display = displays.find((one) => one.index === mode);
        return display ? [display.id] : [];
    }

    const unknown = mode.filter((id) => !displays.some((display) => display.id === id));

    if (unknown.length > 0) {
        throw new RpcError(RPC_ERRORS.unknownDisplay, `no display ${unknown.join(", ")}`);
    }

    return [...new Set(mode)];
}
