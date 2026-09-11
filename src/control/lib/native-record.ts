import type { CaptureSpec } from "./capture-plan";

/**
 * argv for `ax-tool capture`, the ScreenCaptureKit recorder. The runner prepends the binary
 * path. Duration is seconds, as the plan declares it; Peekaboo 4 wants a suffix for that.
 */
export function nativeCaptureArgv(cap: CaptureSpec, outDir: string): string[] {
    const argv = ["capture", "--mode", cap.mode, "--duration", String(cap.duration), "--out", outDir];

    if (cap.mode === "screen" && cap.screenIndex !== undefined) {
        argv.push("--screen-index", String(cap.screenIndex));
    }

    if (cap.mode === "window") {
        if (cap.app) {
            argv.push("--app", cap.app);
        }

        if (cap.windowTitle) {
            argv.push("--window-title", cap.windowTitle);
        }

        if (cap.windowIndex !== undefined) {
            argv.push("--window-index", String(cap.windowIndex));
        }
    }

    if (cap.mode === "region" && cap.region) {
        argv.push("--region", cap.region);
    }

    if (cap.activeFps !== undefined) {
        argv.push("--active-fps", String(cap.activeFps));
    }

    if (cap.idleFps !== undefined) {
        argv.push("--idle-fps", String(cap.idleFps));
    }

    if (cap.threshold !== undefined) {
        argv.push("--threshold", String(cap.threshold));
    }

    if (cap.videoOut) {
        argv.push("--video-out", cap.videoOut);
    }

    return argv;
}

interface RawScreen {
    index: number;
    name: string;
    isPrimary: boolean;
    scaleFactor: number;
    position: { x: number; y: number };
    resolution: { width: number; height: number };
}

export interface ScreenInfo {
    index: number;
    name: string;
    isPrimary: boolean;
    points: { width: number; height: number };
    scaleFactor: number;
    framePixels: { width: number; height: number };
    // top-left origin of this screen in GLOBAL CG points — the space click
    // coords and window bounds live in (`screens` positions are Cocoa-flipped,
    // like Peekaboo's were; converted here so agents never have to)
    originCG: { x: number; y: number };
}

/** Both `ax-tool screens` and Peekaboo's `screen list` report this shape; the conversion is shared. */
export function parseScreenList(data: unknown): ScreenInfo[] {
    const screens = (data as { screens?: RawScreen[] } | undefined)?.screens ?? [];
    const primary = screens.find((s) => s.isPrimary) ?? screens[0];
    const primaryH = primary?.resolution.height ?? 0;

    return screens.map((s) => ({
        index: s.index,
        name: s.name,
        isPrimary: s.isPrimary,
        points: { width: s.resolution.width, height: s.resolution.height },
        scaleFactor: s.scaleFactor,
        framePixels: { width: s.resolution.width * s.scaleFactor, height: s.resolution.height * s.scaleFactor },
        originCG: { x: s.position.x, y: primaryH - (s.position.y + s.resolution.height) },
    }));
}

export interface WindowBounds {
    title: string;
    index: number;
    /** CG window id when the source reports it */
    id?: number;
    isMainWindow: boolean;
    // CG points
    x: number;
    y: number;
    w: number;
    h: number;
}

interface NativeWindow {
    title?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    minimized?: boolean;
    main?: boolean;
}

/** `ax-tool window --app X` reports AX geometry per window; minimized windows are dropped. */
export function parseNativeWindowList(data: unknown): WindowBounds[] {
    const windows = (data as { windows?: NativeWindow[] } | undefined)?.windows ?? [];
    const bounds: WindowBounds[] = [];

    windows.forEach((w, index) => {
        if (w.minimized || w.width === undefined || w.height === undefined) {
            return;
        }

        bounds.push({
            title: w.title ?? "",
            index,
            isMainWindow: w.main === true,
            x: w.x ?? 0,
            y: w.y ?? 0,
            w: w.width,
            h: w.height,
        });
    });

    return bounds;
}
