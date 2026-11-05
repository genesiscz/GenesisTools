import { spawnSync } from "node:child_process";
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

/** Opens the Meetings window through Launch Services; a running window takes the request and comes forward. */
export function openMeetingsWindow(request: WindowRequest): void {
    const args = windowOpenArgs(request);
    log.debug({ args }, "meetings: open the window");
    const result = spawnSync("open", args, { encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${(result.stderr || result.error?.message || "").trim()}`);
    }
}
