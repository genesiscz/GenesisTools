import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { type CaptureBlocker, CaptureError, type FrameSource, type UsedFrameSource } from "./types";

const { log } = logger.scoped("screen-recorder-capture-blockers");

/**
 * What a recording does on a display with a never-capture window: `fallback` takes screenshots there and the system
 * sound through the Core Audio tap, `quit` quits the apps of an allow list first (the rest get the fallback), `ignore`
 * streams as before and only names the apps.
 */
export const NEVER_CAPTURE_ACTIONS = ["fallback", "quit", "ignore"] as const;
export type NeverCaptureAction = (typeof NEVER_CAPTURE_ACTIONS)[number];

/** HazeOver from its own site and from Setapp: one invisible 2 x 2 px never-capture window on every display. */
export const DEFAULT_NEVER_CAPTURE_QUIT_APPS = ["com.pointum.hazeover", "com.pointum.hazeover-setapp"] as const;

export const CAPTURE_BLOCKERS_TIMEOUT_MS = 5_000;
const QUIT_APP_TIMEOUT_MS = 5_000;
const LAUNCH_APP_TIMEOUT_MS = 10_000;
/** How often a quit reads the blockers again, and how long it waits for the apps to go. */
const QUIT_POLL_MS = 500;
const QUIT_DEADLINE_MS = 3_000;

export const captureBlockerSchema = z.object({
    pid: z.number().int(),
    name: z.string(),
    bundleId: z.string().optional(),
    path: z.string().optional(),
    processLaunch: z.number().optional(),
    windows: z.number().int().nonnegative().default(0),
    displays: z.array(z.number().int()).default([]),
});

/** The answer of `ax-tool capture-blockers`. */
export const captureBlockersAnswerSchema = z.object({ ok: z.literal(true), apps: z.array(captureBlockerSchema) });

/** One blocker as the recorder hands it on: the optional fields only when they are there. */
export function captureBlockerOf(raw: z.infer<typeof captureBlockerSchema>): CaptureBlocker {
    return {
        pid: raw.pid,
        name: raw.name,
        ...(raw.bundleId ? { bundleId: raw.bundleId } : {}),
        ...(raw.path ? { path: raw.path } : {}),
        ...(raw.processLaunch !== undefined ? { processLaunch: raw.processLaunch } : {}),
        windows: raw.windows,
        displays: raw.displays,
    };
}

/** The apps of a `capture-blockers` answer; throws on an answer of another shape. */
export function parseCaptureBlockers(raw: unknown): CaptureBlocker[] {
    return captureBlockersAnswerSchema.parse(raw).apps.map(captureBlockerOf);
}

/**
 * What a recording reports about never-capture windows (`RecorderStatus.captureBlockers`, the meetings recorder
 * state): the apps left on the displays, the action, the path the frames and the system sound take, and the apps it quit.
 */
/**
 * Why the frames of a recording that may take screenshots (`auto`) stay on the stream: `no-window`, no never-capture
 * window was on screen when the newest capture started (the apps were seen earlier, and each capture looks again);
 * `sound`, the capture records the sound inside the screen pieces, which needs the stream; `other`, ax-tool kept the
 * stream for a reason of its own (its warning names it).
 */
export const STREAM_REASONS = ["no-window", "sound", "other"] as const;
export type StreamReason = (typeof STREAM_REASONS)[number];

export const captureBlockersStatusSchema = z.object({
    apps: z.array(z.object({ name: z.string(), bundleId: z.string().optional(), displays: z.array(z.number()) })),
    action: z.enum(NEVER_CAPTURE_ACTIONS),
    frames: z.enum(["screenshot", "stream"]),
    sound: z.enum(["tap", "stream"]),
    quit: z.array(z.object({ name: z.string(), bundleId: z.string().optional(), path: z.string().optional() })),
    /** Set while the frames are on the stream although the recording may take screenshots. */
    streamReason: z.enum(STREAM_REASONS).optional(),
    /** While slow screenshots stretch the interval (ax-tool `ScreenshotPace`): one every `everySec`, as one takes `screenshotSec`. */
    screenshotPace: z.object({ everySec: z.number(), screenshotSec: z.number() }).optional(),
});
export type CaptureBlockersStatus = z.infer<typeof captureBlockersStatusSchema>;

/** An app to start again: its bundle id, else its `.app` path. */
export interface LaunchTarget {
    name: string;
    bundleId?: string;
    path?: string;
}

export interface LaunchFailure {
    app: LaunchTarget;
    reason: string;
}

/** The apps a quit asked to go: gone from the blockers within the wait, or still there. */
export interface QuitOutcome {
    gone: CaptureBlocker[];
    stayed: CaptureBlocker[];
}

export interface AxCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Runs one `ax-tool` command (the arguments after the binary) with a deadline. */
export type AxCommandRunner = (args: string[], options: { timeoutMs: number }) => Promise<AxCommandResult>;

/** `ax-tool capture-blockers` through `run`, 5 s at most; throws a CaptureError when it fails. */
export async function readCaptureBlockers(run: AxCommandRunner): Promise<CaptureBlocker[]> {
    const result = await run(["capture-blockers"], { timeoutMs: CAPTURE_BLOCKERS_TIMEOUT_MS });

    if (result.status !== 0) {
        throw new CaptureError(
            "unavailable",
            `ax-tool capture-blockers exited ${result.status}: ${result.stderr.trim().slice(-300) || "no output"}`
        );
    }

    try {
        const apps = parseCaptureBlockers(SafeJSON.parse(result.stdout, { strict: true }));
        log.debug({ apps: apps.map((app) => ({ name: app.name, displays: app.displays })) }, "capture blockers read");
        return apps;
    } catch (error) {
        throw new CaptureError(
            "failed",
            `ax-tool capture-blockers answered something else: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export interface NeverCapturePlan {
    /** The apps to quit before the recording starts. */
    quit: CaptureBlocker[];
    frameSource: FrameSource;
    /** The system sound through the Core Audio tap first. */
    preferTap: boolean;
}

/**
 * What a recording does about the blockers it read. `quit` names the allow-listed apps that can be quit (a pid and a
 * launch time); the caller quits them, reads the blockers again and plans again with what is left.
 */
export function neverCapturePlan(options: {
    blockers: readonly CaptureBlocker[];
    action: NeverCaptureAction;
    quitApps: readonly string[];
}): NeverCapturePlan {
    const { blockers, action, quitApps } = options;

    if (action === "ignore") {
        return { quit: [], frameSource: "stream", preferTap: false };
    }

    const quit =
        action === "quit"
            ? blockers.filter(
                  (app) =>
                      app.bundleId !== undefined && quitApps.includes(app.bundleId) && app.processLaunch !== undefined
              )
            : [];
    return { quit, frameSource: "auto", preferTap: blockers.length > 0 };
}

/**
 * Asks each app to quit (`ax-tool quit-app --pid P --launch L`), then reads the blockers again every 500 ms for at
 * most 3 s until those pids are gone. An app without a launch time is never asked and stays. A failed read keeps the
 * last answer, so an app counts as gone only when a read showed it gone.
 */
export async function quitCaptureBlockers(options: {
    run: AxCommandRunner;
    apps: readonly CaptureBlocker[];
    pollMs?: number;
    deadlineMs?: number;
}): Promise<QuitOutcome> {
    const { run, apps } = options;
    const asked: CaptureBlocker[] = [];
    const unasked: CaptureBlocker[] = [];

    for (const app of apps) {
        if (app.processLaunch === undefined) {
            unasked.push(app);
            continue;
        }

        try {
            const result = await run(["quit-app", "--pid", String(app.pid), "--launch", String(app.processLaunch)], {
                timeoutMs: QUIT_APP_TIMEOUT_MS,
            });
            log.info({ app: app.name, pid: app.pid, status: result.status }, "asked a never-capture app to quit");

            if (result.status !== 0) {
                log.warn({ app: app.name, stderr: result.stderr.trim().slice(-300) }, "quit-app refused");
            }
        } catch (error) {
            // The request may still have reached the app, so the reads below decide whether it went.
            log.warn({ app: app.name, error }, "quit-app failed");
        }

        asked.push(app);
    }

    const deadline = Date.now() + (options.deadlineMs ?? QUIT_DEADLINE_MS);
    const pollMs = options.pollMs ?? QUIT_POLL_MS;
    let left = new Set(asked.map((app) => app.pid));

    while (left.size > 0) {
        try {
            const now = new Set((await readCaptureBlockers(run)).map((app) => app.pid));
            left = new Set([...left].filter((pid) => now.has(pid)));
        } catch (error) {
            log.debug({ error }, "capture blockers read failed while waiting for a quit");
        }

        const remaining = deadline - Date.now();

        if (left.size === 0 || remaining <= 0) {
            break;
        }

        await Bun.sleep(Math.min(pollMs, remaining));
    }

    return {
        gone: asked.filter((app) => !left.has(app.pid)),
        stayed: [...asked.filter((app) => left.has(app.pid)), ...unasked],
    };
}

/** Starts each app again in the background (`ax-tool launch-app`), 10 s each; answers the ones that did not start. */
export async function relaunchApps(options: {
    run: AxCommandRunner;
    apps: readonly LaunchTarget[];
}): Promise<LaunchFailure[]> {
    const failures: LaunchFailure[] = [];

    for (const app of options.apps) {
        const target = app.bundleId ? ["--bundle-id", app.bundleId] : app.path ? ["--path", app.path] : undefined;

        if (!target) {
            failures.push({ app, reason: "it has no bundle id and no path" });
            continue;
        }

        try {
            const result = await options.run(["launch-app", ...target, "--background"], {
                timeoutMs: LAUNCH_APP_TIMEOUT_MS,
            });

            if (result.status !== 0) {
                failures.push({ app, reason: launchError(result) });
                continue;
            }

            log.info({ app: app.name }, "started a never-capture app again");
        } catch (error) {
            failures.push({ app, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    return failures;
}

const launchAnswer = z.object({ error: z.string() });

function launchError(result: AxCommandResult): string {
    try {
        const parsed = launchAnswer.safeParse(SafeJSON.parse(result.stdout, { strict: true }));

        if (parsed.success) {
            return parsed.data.error;
        }
    } catch (error) {
        log.debug({ error }, "launch-app answer is not JSON");
    }

    return `ax-tool launch-app exited ${result.status}: ${result.stderr.trim().slice(-300) || "no output"}`;
}

/** Why a capture that may take screenshots kept the stream: the never-capture apps it saw at its start, its sound. */
export function streamReason(options: { seen: readonly unknown[]; audio: boolean }): StreamReason {
    return options.seen.length === 0 ? "no-window" : options.audio ? "sound" : "other";
}

/** The frame source a recording reports for its displays: screenshots when any display takes them. */
export function usedFrameSource(sources: Iterable<UsedFrameSource>): UsedFrameSource {
    for (const source of sources) {
        if (source === "screenshot") {
            return "screenshot";
        }
    }

    return "stream";
}
