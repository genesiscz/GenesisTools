import type { FaceDeps } from "@app/macos/lib/permissions/part-readiness";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import type { WindowPlayFocus, WindowPlayMode } from "@genesiscz/utils/meetings/config";
import type { MeetingsParams } from "./service/api";

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
    newWindow?: boolean;
    play?: MeetingsParams<"moment.clip">;
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
        ...(request.newWindow ? ["--new-window"] : []),
        ...place,
        ...(request.meeting ? ["--meeting", request.meeting] : []),
        ...(request.tab ? ["--tab", request.tab] : []),
        ...(request.play ? ["--play-request", SafeJSON.stringify(request.play)] : []),
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

/** How a Moment reached the Meetings window: a running one took it, or one opened on the meeting to play it. */
export type WindowPlayRoute = "running" | "opened";

export interface WindowPlayDeps {
    running: () => boolean;
    open: (request: WindowRequest) => Promise<void>;
}

/** True while a Meetings window face of the installed app runs (its face record and its executable). */
async function meetingsWindowRunning(): Promise<boolean> {
    const [{ readFaceRecords }, { readExecutablePath }] = await Promise.all([
        import("@app/macos/lib/permissions/relaunch"),
        import("@genesiscz/utils/process/processes"),
    ]);
    return [...readFaceRecords()].some(
        ([pid, args]) => args[0] === "--meetings" && readExecutablePath(pid)?.endsWith("/Contents/MacOS/GenesisTools")
    );
}

/**
 * Sends a Moment to the Meetings window (`playback.window`): a running window plays it, and with `mode: "open"` a
 * closed one opens on the meeting and plays it there. Undefined: no window plays it (`mode: "running"` and none runs),
 * so the caller plays it in the command player. With `focus: "keep"` the window comes to the front without the
 * keyboard (`open -g`, `--no-focus`): a key typed in the app in use stays there. On 2026-11-25 a handoff that took the
 * keyboard quit the window 0.4 s later, because the ⌘Q meant for the app in front hit "Quit Meetings".
 */
export async function playInWindow(
    params: MeetingsParams<"moment.clip">,
    options: { mode: WindowPlayMode; focus: WindowPlayFocus },
    deps?: WindowPlayDeps
): Promise<WindowPlayRoute | undefined> {
    const running = deps ? deps.running() : await meetingsWindowRunning();

    if (!running && options.mode === "running") {
        return undefined;
    }

    const request: WindowRequest = { meeting: params.meeting, play: params, focus: options.focus === "take" };

    if (deps) {
        await deps.open(request);
    } else {
        await openMeetingsWindow({ ...request, build: false });
    }

    return running ? "running" : "opened";
}
