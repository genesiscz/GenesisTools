import { spawnSync } from "node:child_process";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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

/** What opening the window needs from the machine; tests pass fakes, so no app is built or started. */
export interface WindowDeps {
    /** The installed app: whether it is built and the parts it was built with. */
    status(): { built: boolean; parts: string[] };
    /** Builds the app with the installed parts plus meetings. */
    build(onStep?: (line: string) => void): Promise<void>;
    open(args: string[]): { status: number | null; stderr: string };
}

async function defaultWindowDeps(): Promise<WindowDeps> {
    // lazy: the app builder loads only when a window opens
    const { appStatus, buildApp } = await import("@app/macos/lib/permissions/app");

    return {
        status: () => appStatus(),
        build: async (onStep) => {
            await buildApp({ ...(onStep ? { onStep } : {}), parts: { add: ["meetings"] } });
        },
        open: (args) => {
            const result = spawnSync("open", args, { encoding: "utf8" });
            return { status: result.status, stderr: result.stderr || result.error?.message || "" };
        },
    };
}

export const MEETINGS_PART_BUILD = toolCommand("macos", "permissions", "build", "--add-part", "meetings");

/**
 * Opens the Meetings window through Launch Services; a running window takes the request and comes forward. An app
 * built without the Meetings part has no such face and would exit at once, so it is built with the part first, as
 * `tools hub` does for the hub; `build: false` says the command instead.
 */
export async function openMeetingsWindow(
    request: WindowRequest & { build?: boolean; onStep?: (line: string) => void },
    deps?: WindowDeps
): Promise<void> {
    const machine = deps ?? (await defaultWindowDeps());
    const status = machine.status();

    if (!status.built || !status.parts.includes("meetings")) {
        const reason = status.built
            ? "GenesisTools.app was built without the Meetings part"
            : "GenesisTools.app is not built";

        if (request.build === false) {
            throw new Error(`${reason}; run without --no-build, or: ${MEETINGS_PART_BUILD}`);
        }

        request.onStep?.(`${reason}: building it with the part (about a minute)`);
        log.info({ parts: status.parts }, "meetings window: adding the meetings part");
        await machine.build(request.onStep);
    }

    const args = windowOpenArgs(request);
    log.debug({ args }, "meetings: open the window");
    const result = machine.open(args);

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${result.stderr.trim()}`);
    }
}
