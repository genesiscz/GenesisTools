import type { FaceDeps } from "@app/macos/lib/permissions/part-readiness";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";

const { log } = logger.scoped("meetings-window");

export const WINDOW_TABS = ["transcript", "screen", "items", "speakers", "context"] as const;
export type WindowTab = (typeof WINDOW_TABS)[number];

export function isWindowTab(value: string): value is WindowTab {
    return (WINDOW_TABS as readonly string[]).includes(value);
}

export interface WindowRequest {
    /** `needs`, `all`, or a project's name. */
    place?: "needs" | "all" | { project: string };
    meeting?: string;
    tab?: WindowTab;
    focus?: boolean;
}

/** The `open` arguments that start (or bring forward) the Meetings window face of GenesisTools.app. */
export function windowOpenArgs(request: WindowRequest, bundle = genesisAppBundlePath()): string[] {
    const focus = request.focus !== false;
    const place =
        request.place === undefined
            ? []
            : ["--place", typeof request.place === "string" ? request.place : `project:${request.place.project}`];

    return [
        "-n",
        ...(focus ? [] : ["-g"]),
        bundle,
        "--args",
        "--meetings",
        ...place,
        ...(request.meeting ? ["--meeting", request.meeting] : []),
        ...(request.tab ? ["--tab", request.tab] : []),
        ...(focus ? [] : ["--no-focus"]),
    ];
}

/**
 * Opens the Meetings window through Launch Services; a running window takes the request and comes forward. An app
 * built without the Meetings part has no such face and would exit at once, so it is built with the part first, as
 * `tools hub` does for the hub; `build: false` says the command instead.
 */
export async function openMeetingsWindow(
    request: WindowRequest & { build?: boolean; onStep?: (line: string) => void },
    deps?: FaceDeps
): Promise<void> {
    // lazy: the app builder loads only when a window opens
    const { ensureFaceReady, LIVE_FACE_DEPS, openFace } = await import("@app/macos/lib/permissions/part-readiness");
    const machine = deps ?? LIVE_FACE_DEPS;
    const readiness = await ensureFaceReady(
        "--meetings",
        { build: request.build === false ? "refuse" : "allow", stale: "accept", onStep: request.onStep },
        machine
    );

    if (!readiness.ready) {
        throw new Error(`${readiness.sentence} (or run without --no-build)`);
    }

    const args = windowOpenArgs(request);
    log.debug({ args }, "meetings: open the window");
    openFace(args, machine);
}
