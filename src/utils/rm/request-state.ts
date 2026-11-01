import { lstatSync } from "node:fs";
import type { RmRequest, RmRequestTarget } from "./requests";

/** What is on disk for one request path right now. */
export type RmTargetLiveState = "aside" | "in-place" | "came-back" | "copy-lost" | "gone";

/** The request's state for the listing: the worst target state, or gone when nothing is left. */
export type RmRequestLiveState = "waiting" | "came-back" | "copy-lost" | "gone";

export interface RmRequestLive {
    state: RmRequestLiveState;
    /** One state per entry of `request.targets`, in order. */
    targets: RmTargetLiveState[];
    aside: number;
    inPlace: number;
    gone: number;
}

/**
 * A path lstat sees; a dangling symlink counts, because it still holds the name. A parent that became a file (ENOTDIR)
 * means the path is gone too; any other error (a folder it may not read) still throws, so nothing reads as gone.
 */
export function pathPresent(path: string): boolean {
    try {
        return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
            return false;
        }

        throw error;
    }
}

export function targetLiveState(
    target: RmRequestTarget,
    present: (path: string) => boolean = pathPresent
): RmTargetLiveState {
    const original = present(target.path);

    if (target.stored === undefined) {
        return original ? "in-place" : "gone";
    }

    if (!present(target.stored)) {
        return "copy-lost";
    }

    return original ? "came-back" : "aside";
}

export function requestLive(request: RmRequest, present: (path: string) => boolean = pathPresent): RmRequestLive {
    const targets = request.targets.map((target) => targetLiveState(target, present));
    const count = (state: RmTargetLiveState) => targets.filter((s) => s === state).length;
    let state: RmRequestLiveState = "waiting";

    if (targets.includes("copy-lost")) {
        state = "copy-lost";
    } else if (targets.includes("came-back")) {
        state = "came-back";
    } else if (targets.every((s) => s === "gone")) {
        // An empty target list is gone too: nothing is left to decide.
        state = "gone";
    }

    return { state, targets, aside: count("aside"), inPlace: count("in-place"), gone: count("gone") };
}
