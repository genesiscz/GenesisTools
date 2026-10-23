import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { parseScreenList } from "./native-record";
import { type AxResult, runAxAsync } from "./runner";

const { log } = logger.scoped("control-recording-targets");

/** One thing a recording session can record: exact windows, every visible window of an app, or a whole display. */
export const recordingTargetSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("window"),
        windowIds: z.array(z.number().int().positive().max(0xffffffff)).min(1).max(16),
        app: z.string().optional(),
        title: z.string().optional(),
        pid: z.number().int().positive().optional(),
    }),
    z.object({
        kind: z.literal("app"),
        /** A pid, an app name or a bundle id, as `--include-app` takes it. */
        app: z.string().trim().min(1),
        name: z.string().optional(),
    }),
    z.object({
        kind: z.literal("display"),
        /** NSScreen order, as `ax-tool screens` lists it. */
        screenIndex: z.number().int().nonnegative(),
        name: z.string().optional(),
    }),
]);

export type RecordingTarget = z.infer<typeof recordingTargetSchema>;

export interface RecordingWindow {
    id: number;
    pid: number;
    app: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface RecordingApp {
    pid: number;
    name: string;
    windowCount: number;
}

export interface RecordingDisplay {
    index: number;
    name: string;
    isPrimary: boolean;
    width: number;
    height: number;
    scaleFactor: number;
}

export interface RecordingTargets {
    /** On-screen windows, front to back. */
    windows: RecordingWindow[];
    /** Apps with at least one listed window, in the order their front window appears. */
    apps: RecordingApp[];
    displays: RecordingDisplay[];
    /** The WindowServer's frontmost application, when it reported one. */
    frontmostPid?: number;
}

/**
 * Window owners that are system chrome rather than something a person records. GenesisTools stays listed: the hub
 * and the review window are worth recording, and a host filters its own panels out by pid.
 */
const SYSTEM_OWNERS = new Set([
    "Dock",
    "WindowServer",
    "Window Server",
    "Control Center",
    "Notification Center",
    "NotificationCenter",
    "Spotlight",
    "SystemUIServer",
    "loginwindow",
    "Screenshot",
    "TextInputMenuAgent",
    "Wallpaper",
]);

/** Smaller than this on either side is a strip, a badge or an invisible helper window, not a recording target. */
const MIN_WINDOW_SIDE = 60;

const frontRowSchema = z.object({
    pid: z.number().int(),
    app: z.string(),
    windowId: z.number().int().positive(),
    title: z.string().optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

/** `ax-tool front` rows (layer 0, on screen, front to back) as recordable windows. Malformed rows are skipped. */
export function parseRecordingWindows(raw: unknown): RecordingWindow[] {
    const rows = (raw as { windows?: unknown } | null | undefined)?.windows;
    if (!Array.isArray(rows)) {
        return [];
    }

    const windows: RecordingWindow[] = [];
    for (const row of rows) {
        const parsed = frontRowSchema.safeParse(row);
        if (!parsed.success) {
            continue;
        }

        const { pid, app, windowId, title, bounds } = parsed.data;
        if (SYSTEM_OWNERS.has(app) || app.length === 0) {
            continue;
        }

        if (bounds.width < MIN_WINDOW_SIDE || bounds.height < MIN_WINDOW_SIDE) {
            continue;
        }

        windows.push({ id: windowId, pid, app, title: title ?? "", bounds });
    }

    return windows;
}

/** One row per app, in the order its front window appears. */
export function groupRecordingApps(windows: RecordingWindow[]): RecordingApp[] {
    const apps = new Map<number, RecordingApp>();
    for (const window of windows) {
        const app = apps.get(window.pid);
        if (app) {
            app.windowCount += 1;
        } else {
            apps.set(window.pid, { pid: window.pid, name: window.app, windowCount: 1 });
        }
    }

    return [...apps.values()];
}

export function parseRecordingDisplays(raw: unknown): RecordingDisplay[] {
    return parseScreenList(raw, "cocoa").map((screen) => ({
        index: screen.index,
        name: screen.name,
        isPrimary: screen.isPrimary,
        width: screen.points.width,
        height: screen.points.height,
        scaleFactor: screen.scaleFactor,
    }));
}

/** Everything a picker offers, from one `ax-tool front` and one `ax-tool screens`. Reads only. */
export async function listRecordingTargets(
    options: { run?: (request: { args: string[]; timeoutMs: number }) => Promise<AxResult> } = {}
): Promise<RecordingTargets> {
    const run = options.run ?? runAxAsync;
    const [front, screens] = await Promise.all([
        run({ args: ["front"], timeoutMs: 5000 }),
        run({ args: ["screens"], timeoutMs: 5000 }),
    ]);
    if (!front.ok) {
        throw new Error(`Cannot list windows: ${front.error ?? "ax-tool front failed"}`);
    }

    if (!screens.ok) {
        throw new Error(`Cannot list displays: ${screens.error ?? "ax-tool screens failed"}`);
    }

    const windows = parseRecordingWindows(front);
    const frontmost = (front as { frontmostPid?: unknown }).frontmostPid;
    const targets: RecordingTargets = {
        windows,
        apps: groupRecordingApps(windows),
        displays: parseRecordingDisplays(screens),
        ...(typeof frontmost === "number" ? { frontmostPid: frontmost } : {}),
    };
    log.debug(
        { windows: targets.windows.length, apps: targets.apps.length, displays: targets.displays.length },
        "recording targets listed"
    );
    return targets;
}

/** The front window of the app the person was in: the frontmost app unless it is in `excludePids` (a terminal). */
export function defaultRecordingTarget(targets: RecordingTargets, excludePids: Set<number>): RecordingTarget | null {
    const usable = targets.windows.filter((window) => !excludePids.has(window.pid));
    const front =
        (targets.frontmostPid !== undefined && usable.find((window) => window.pid === targets.frontmostPid)) ||
        usable[0];
    if (front) {
        return { kind: "window", windowIds: [front.id], app: front.app, title: front.title, pid: front.pid };
    }

    const display = targets.displays.find((entry) => entry.isPrimary) ?? targets.displays[0];
    return display ? { kind: "display", screenIndex: display.index, name: display.name } : null;
}

/** A short human name for a target, for logs and the CLI. */
export function describeRecordingTarget(target: RecordingTarget): string {
    switch (target.kind) {
        case "window":
            return [target.app, target.title].filter(Boolean).join(" · ") || `window ${target.windowIds.join(",")}`;
        case "app":
            return target.name ?? target.app;
        case "display":
            return target.name ?? `display ${target.screenIndex}`;
    }
}
