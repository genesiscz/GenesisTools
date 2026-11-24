import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, type NeverCaptureSettings } from "@genesiscz/utils/meetings/config";
import {
    type CaptureBlockersStatus,
    type LaunchFailure,
    type NeverCaptureAction,
    neverCapturePlan,
} from "@genesiscz/utils/screen-recorder/capture-blockers";
import type { NeverCaptureSetup } from "@genesiscz/utils/screen-recorder/recording";
import type { CaptureBlocker, FrameRecorder } from "@genesiscz/utils/screen-recorder/types";
import { frameRecorderFor } from "./recorder-shared";

const { log } = logger.scoped("meetings-never-capture");

/** The config key of the never-capture handling, as `tools meetings config set` takes it. */
export const NEVER_CAPTURE_KEY = "global.capture.recorders.native.neverCapture";

/**
 * What the WindowServer round trip measured (median, one Mac, 2026-11-22): the cost of a capture stream on a display
 * with a never-capture window. Re-measure before changing the numbers.
 */
export const NEVER_CAPTURE_COST =
    "With such a window on a display, WindowServer draws every window again for each open capture stream at every screen update. Its median round trip was 2.3 to 2.9 ms on a clean display, 4.8 to 5.6 ms with HazeOver running and no stream, 8.5 to 8.9 ms with one stream, and 13.5 to 18.3 ms while a meeting recorded three displays. A screenshot per second per display and the sound through the audio tap kept it at the base value (measured 2026-11-22 on one Mac).";

/** "1", "1 and 2", "1, 2 and 4". */
export function joinAnd(items: readonly string[]): string {
    if (items.length <= 1) {
        return items[0] ?? "";
    }

    return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Dimmer on displays 1, 2 and 4, Shade on display 3". */
export function appsOnDisplays(apps: ReadonlyArray<{ name: string; displays: readonly number[] }>): string {
    return apps
        .map((app) => {
            const ids = [...app.displays].sort((a, b) => a - b).map(String);

            if (ids.length === 0) {
                return app.name;
            }

            return `${app.name} on display${ids.length === 1 ? "" : "s"} ${joinAnd(ids)}`;
        })
        .join(", ");
}

function statusApp(app: CaptureBlocker): CaptureBlockersStatus["apps"][number] {
    return { name: app.name, ...(app.bundleId ? { bundleId: app.bundleId } : {}), displays: app.displays };
}

export interface NeverCaptureStart {
    setup: NeverCaptureSetup;
    /** The apps that went after the quit; the recording starts them again at its end. */
    quit: CaptureBlocker[];
    /** A warning for the recording (only with `ignore` and apps there). */
    note?: string;
}

/**
 * A recording's start on displays with never-capture windows: read the blockers once; with `quit` quit the planned
 * apps (`onQuit` hears of them at once, so a later failure still starts them again), and read the blockers again;
 * then plan. Undefined when the recorder cannot list blockers or the listing failed: the recording streams as before.
 * It never throws.
 */
export async function startNeverCapture(options: {
    recorder: FrameRecorder;
    settings: NeverCaptureSettings;
    /** The recording has a continuous sound session with the system sound (the tap is possible). */
    soundSession: boolean;
    onQuit?: (apps: CaptureBlocker[]) => void;
}): Promise<NeverCaptureStart | undefined> {
    const { recorder, settings } = options;

    try {
        const ready = await recorder.available();

        if (!ready.ok || !recorder.supports.captureBlockers) {
            log.debug({ recorder: recorder.id }, "the recorder cannot list never-capture windows");
            return undefined;
        }

        let blockers = await recorder.captureBlockers();

        if (!blockers) {
            return undefined;
        }

        let quit: CaptureBlocker[] = [];

        if (settings.action === "quit") {
            const planned = neverCapturePlan({ blockers, action: "quit", quitApps: settings.quitApps }).quit;

            if (planned.length > 0) {
                try {
                    quit = (await recorder.quitApps(planned)).gone;
                } catch (error) {
                    // Whether they went is unknown; starting a running app again does no harm.
                    log.warn({ error }, "quitting the never-capture apps failed");
                    quit = planned;
                }

                options.onQuit?.(quit);
                const gone = new Set(quit.map((app) => app.pid));

                try {
                    blockers = (await recorder.captureBlockers()) ?? blockers.filter((app) => !gone.has(app.pid));
                } catch (error) {
                    log.warn({ error }, "the never-capture windows could not be read again after the quit");
                    blockers = blockers.filter((app) => !gone.has(app.pid));
                }
            }
        }

        const plan = neverCapturePlan({ blockers, action: settings.action, quitApps: settings.quitApps });
        const status: CaptureBlockersStatus | undefined =
            blockers.length > 0 || quit.length > 0
                ? {
                      apps: blockers.map(statusApp),
                      action: settings.action,
                      frames: plan.frameSource === "auto" && blockers.length > 0 ? "screenshot" : "stream",
                      sound: plan.preferTap && options.soundSession ? "tap" : "stream",
                      quit: quit.map((app) => ({
                          name: app.name,
                          ...(app.bundleId ? { bundleId: app.bundleId } : {}),
                          ...(app.path ? { path: app.path } : {}),
                      })),
                  }
                : undefined;
        log.info(
            { action: settings.action, apps: blockers.length, quit: quit.length, frameSource: plan.frameSource },
            "never-capture plan"
        );
        return {
            setup: {
                action: settings.action,
                frameSource: plan.frameSource,
                preferTap: plan.preferTap,
                ...(status ? { status } : {}),
            },
            quit,
            ...(settings.action === "ignore" && blockers.length > 0 ? { note: ignoreNote(blockers) } : {}),
        };
    } catch (error) {
        log.warn({ error }, "the never-capture windows could not be read; the recording streams");
        return undefined;
    }
}

function ignoreNote(blockers: readonly CaptureBlocker[]): string {
    const displays = [...new Set(blockers.flatMap((app) => app.displays))].sort((a, b) => a - b).map(String);
    return `Never-capture windows: ${appsOnDisplays(blockers)}. Every capture stream on display${displays.length === 1 ? "" : "s"} ${joinAnd(displays)} slows the whole screen; set ${NEVER_CAPTURE_KEY}.action to fallback (screenshots there) or quit`;
}

/** Starts the apps a recording quit again; answers a note per app that did not start. Never throws. */
export async function relaunchQuitApps(options: {
    recorder: FrameRecorder;
    apps: readonly CaptureBlocker[];
}): Promise<string[]> {
    if (options.apps.length === 0) {
        return [];
    }

    let failures: LaunchFailure[];

    try {
        failures = await options.recorder.launchApps(
            options.apps.map((app) => ({
                name: app.name,
                ...(app.bundleId ? { bundleId: app.bundleId } : {}),
                ...(app.path ? { path: app.path } : {}),
            }))
        );
    } catch (error) {
        failures = options.apps.map((app) => ({
            app: { name: app.name },
            reason: error instanceof Error ? error.message : String(error),
        }));
    }

    return failures.map((failure) => `${failure.app.name} did not start again after the recording: ${failure.reason}`);
}

/** The `record status` lines of a recording's never-capture status. */
export function captureBlockersStatusLines(status: CaptureBlockersStatus, relaunch: boolean): string[] {
    const frames = status.frames === "screenshot" ? "Frames come by screenshot" : "Frames come from the capture stream";
    const sound =
        status.sound === "tap"
            ? "the system sound through the audio tap"
            : "the system sound through the display stream";
    const apps = status.apps.length > 0 ? appsOnDisplays(status.apps) : "none left on the displays";
    // The apps are every one seen since the start; the newest capture found none of them on screen.
    const lines = [
        status.frames === "stream" && status.streamReason === "no-window"
            ? `Never-capture windows seen in this recording: ${apps}. None was on screen when the newest capture started, so frames come from the capture stream, ${sound}.`
            : `Never-capture windows: ${apps}. ${frames}, ${sound}.`,
    ];

    if (status.screenshotPace) {
        const { everySec, screenshotSec } = status.screenshotPace;
        lines.push(
            `A screenshot takes ${screenshotSec.toFixed(1)} s here, so the recorder takes one every ${everySec} s and leaves the capture service free for other apps.`
        );
    }

    if (status.quit.length > 0) {
        const names = joinAnd(status.quit.map((app) => app.name));
        const verb = status.quit.length === 1 ? "was" : "were";
        lines.push(
            relaunch
                ? `${names} ${verb} quit for this recording and ${status.quit.length === 1 ? "starts" : "start"} again when it ends.`
                : `${names} ${verb} quit for this recording.`
        );
    }

    return lines;
}

export interface CaptureBlockersView {
    /** False when the recorder cannot list never-capture windows (peekaboo, an older ax-tool); `apps` is then absent. */
    listed: boolean;
    /** Why they could not be listed. */
    reason?: string;
    apps?: Array<{
        pid: number;
        name: string;
        bundleId?: string;
        windows: number;
        displays: number[];
        /** Its bundle id is in `quitApps`, so `quit` and `record blockers --quit` may quit it. */
        allowListed: boolean;
    }>;
    action: NeverCaptureAction;
    quitApps: string[];
    relaunch: boolean;
}

async function neverCaptureContext(options: { recorder?: FrameRecorder; config?: MeetingsConfig }) {
    const config = options.config ?? (await new MeetingsConfigStore().read());
    const capture = config.global.capture;
    return {
        recorder: options.recorder ?? frameRecorderFor(capture),
        settings: capture.recorders.native.neverCapture,
    };
}

async function listBlockers(
    recorder: FrameRecorder
): Promise<{ apps: CaptureBlocker[] } | { apps: undefined; reason: string }> {
    try {
        const apps = await recorder.captureBlockers();
        return apps
            ? { apps }
            : { apps: undefined, reason: `the ${recorder.id} recorder has no capture-blockers (rebuild ax-tool)` };
    } catch (error) {
        log.warn({ error }, "capture blockers read failed");
        return { apps: undefined, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** `meetings record blockers` and the REPL's `captureBlockers()`: a fresh read, no recording needed. Reads only. */
export async function captureBlockersRead(
    options: { recorder?: FrameRecorder; config?: MeetingsConfig } = {}
): Promise<CaptureBlockersView> {
    const { recorder, settings } = await neverCaptureContext(options);
    const read = await listBlockers(recorder);
    const base = { action: settings.action, quitApps: settings.quitApps, relaunch: settings.relaunch };

    if (!read.apps) {
        return { listed: false, reason: read.reason, ...base };
    }

    return {
        listed: true,
        apps: read.apps.map((app) => ({
            pid: app.pid,
            name: app.name,
            ...(app.bundleId ? { bundleId: app.bundleId } : {}),
            windows: app.windows,
            displays: app.displays,
            allowListed: app.bundleId !== undefined && settings.quitApps.includes(app.bundleId),
        })),
        ...base,
    };
}

export interface QuitBlockersResult {
    listed: boolean;
    reason?: string;
    /** Quit and gone from the displays. */
    quit: Array<{ name: string; bundleId?: string; displays: number[] }>;
    /** Asked, or allow-listed but without a launch time, and still there. */
    stayed: Array<{ name: string; bundleId?: string; displays: number[] }>;
    /** Not in `quitApps`: never quit. */
    outside: Array<{ name: string; bundleId?: string; displays: number[] }>;
    /** The config key whose `quitApps` list adds an app. */
    configKey: string;
}

/**
 * `meetings record blockers --quit` and the REPL's `quitCaptureBlockers()`: quits the allow-listed apps now. An app
 * outside `quitApps` is never quit.
 */
export async function quitCaptureBlockersNow(
    options: { recorder?: FrameRecorder; config?: MeetingsConfig } = {}
): Promise<QuitBlockersResult> {
    const { recorder, settings } = await neverCaptureContext(options);
    const configKey = `${NEVER_CAPTURE_KEY}.quitApps`;
    const read = await listBlockers(recorder);

    if (!read.apps) {
        return { listed: false, reason: read.reason, quit: [], stayed: [], outside: [], configKey };
    }

    const row = (app: CaptureBlocker) => ({
        name: app.name,
        ...(app.bundleId ? { bundleId: app.bundleId } : {}),
        displays: app.displays,
    });
    const listed = (app: CaptureBlocker) => app.bundleId !== undefined && settings.quitApps.includes(app.bundleId);
    const planned = neverCapturePlan({ blockers: read.apps, action: "quit", quitApps: settings.quitApps }).quit;
    const planPids = new Set(planned.map((app) => app.pid));
    const outcome = planned.length > 0 ? await recorder.quitApps(planned) : { gone: [], stayed: [] };
    return {
        listed: true,
        quit: outcome.gone.map(row),
        stayed: [...outcome.stayed, ...read.apps.filter((app) => listed(app) && !planPids.has(app.pid))].map(row),
        outside: read.apps.filter((app) => !listed(app)).map(row),
        configKey,
    };
}

/** The `record cost` block about never-capture windows: the apps, what they cost, and what the setting does now. */
export function neverCaptureCostLines(view: CaptureBlockersView): string[] {
    if (!view.listed || !view.apps) {
        return [`Never-capture windows: the recorder cannot list them (${view.reason ?? "unknown reason"}).`];
    }

    if (view.apps.length === 0) {
        return ["Never-capture windows: none."];
    }

    const lines = ["Never-capture windows:"];

    for (const app of view.apps) {
        lines.push(
            `  ${appsOnDisplays([{ name: app.bundleId ? `${app.name} (${app.bundleId})` : app.name, displays: app.displays }])}`
        );
    }

    lines.push(`  ${NEVER_CAPTURE_COST}`);
    lines.push(`  Now (${NEVER_CAPTURE_KEY}.action is ${view.action}): ${actionText(view)}`);
    return lines;
}

function actionText(view: CaptureBlockersView): string {
    const fallback =
        "on those displays the frames come by screenshot (2 fps at most) and the system sound through the audio tap; other displays keep the stream.";

    if (view.action === "fallback") {
        return fallback;
    }

    if (view.action === "ignore") {
        return "the recording streams as before and only names the apps. Set the action to fallback or quit to avoid the cost.";
    }

    const quits = (view.apps ?? []).filter((app) => app.allowListed).map((app) => app.name);
    const who = quits.length > 0 ? joinAnd(quits) : "no app here (none is in quitApps)";
    return `the recording quits ${who} at its start${view.relaunch ? " and starts it again at its end" : ""}; for the rest ${fallback}`;
}
