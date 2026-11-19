import { logger } from "@genesiscz/utils/logger";
import {
    type ScreenRect,
    type UnrecordableReason,
    unrecordableReason,
} from "@genesiscz/utils/screen-recorder/recordable-window";
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
        /** Follow the pointer and the focus to other displays while recording (the start is the pointer's display). */
        follow: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal("region"),
        /** An area of one display in global screen points, top-left origin (CoreGraphics), as `--region` takes it. */
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
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

const frontRowSchema = z.object({
    pid: z.number().int(),
    app: z.string(),
    windowId: z.number().int().positive(),
    title: z.string().optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    alpha: z.number().optional(),
    sharingState: z.number().int().optional(),
    ownerKind: z.enum(["regular", "accessory", "background", "none"]).optional(),
});

/**
 * `ax-tool front` rows (layer 0, on screen, front to back) as recordable windows: malformed rows, system chrome,
 * strips, unreadable windows and overlays over a whole display are skipped (`unrecordableReason`). `displays` are the
 * displays' frames in global CG points; without them an overlay cannot be told from a window.
 */
export function parseRecordingWindows(raw: unknown, displays: readonly ScreenRect[] = []): RecordingWindow[] {
    const rows = (raw as { windows?: unknown } | null | undefined)?.windows;
    if (!Array.isArray(rows)) {
        return [];
    }

    const windows: RecordingWindow[] = [];
    const skipped: Partial<Record<UnrecordableReason, number>> = {};
    for (const row of rows) {
        const parsed = frontRowSchema.safeParse(row);
        if (!parsed.success) {
            continue;
        }

        const { pid, app, windowId, title, bounds } = parsed.data;
        const reason = unrecordableReason(parsed.data, displays);
        if (reason) {
            skipped[reason] = (skipped[reason] ?? 0) + 1;
            continue;
        }

        windows.push({ id: windowId, pid, app, title: title ?? "", bounds });
    }

    if (Object.keys(skipped).length > 0) {
        log.debug({ skipped }, "windows left out of the recording targets");
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

/** The displays' frames in global CG points, for telling an overlay over a whole display from a window. */
export function displayFrames(raw: unknown): ScreenRect[] {
    return parseScreenList(raw, "cocoa").map((screen) => ({
        x: screen.originCG.x,
        y: screen.originCG.y,
        width: screen.points.width,
        height: screen.points.height,
    }));
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

    const displays = parseRecordingDisplays(screens);
    const windows = parseRecordingWindows(front, displayFrames(screens));
    const frontmost = (front as { frontmostPid?: unknown }).frontmostPid;
    const targets: RecordingTargets = {
        windows,
        apps: groupRecordingApps(windows),
        displays,
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
        case "region":
            return `area ${Math.round(target.width)}×${Math.round(target.height)} at ${Math.round(target.x)},${Math.round(target.y)}`;
    }
}

/** `--region x,y,width,height` in global screen points (top-left origin), as the capture picker's area gives it. */
export function parseRegionTarget(raw: string): RecordingTarget {
    const parts = raw.split(",").map((part) => Number(part.trim()));

    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) {
        throw new Error(`--region takes x,y,width,height in screen points (got "${raw}")`);
    }

    return { kind: "region", x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** `--exclude-window-ids 41,42`: CG window ids, positive integers. */
export function parseWindowIdList(raw: string | undefined, flag: string): number[] | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const ids = raw.split(",").map((part) => Number(part.trim()));

    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error(`${flag} takes CG window ids, comma separated (got "${raw}")`);
    }

    return ids;
}
