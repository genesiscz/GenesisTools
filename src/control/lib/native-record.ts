import type { Command } from "commander";
import type { CaptureSpec } from "./capture-plan";

/**
 * argv for `ax-tool capture`, the ScreenCaptureKit recorder. The runner prepends the binary
 * path. Duration is seconds, as the plan declares it; Peekaboo 4 wants a suffix for that.
 */
export function nativeCaptureArgv(cap: CaptureSpec, outDir: string): string[] {
    const argv = ["capture", "--mode", cap.mode, "--duration", String(cap.duration), "--out", outDir];

    validateCaptureOptions(cap);

    if ((cap.mode === "screen" || cap.mode === "isolated") && cap.screenIndex !== undefined) {
        argv.push("--screen-index", String(cap.screenIndex));
    }

    if (cap.mode === "window") {
        // A CG window id is the only selector both sides agree on. `--window-index` counts the
        // recorder's OWN on-screen CGWindowList, which is filtered by pid, layer and height and
        // so can differ in order and length from the AX list `window`/`preflight` enumerated —
        // the same ordinal can name a different window. When the plan carries an id, use it
        // alone: mixing it with the app-side filters would only re-open that gap.
        if (cap.windowId !== undefined) {
            argv.push("--window-id", String(cap.windowId));
        } else {
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
    }

    if (cap.mode === "region" && cap.region) {
        argv.push("--region", cap.region);
    }

    if (cap.mode === "isolated") {
        if (cap.windowIds?.length) {
            argv.push("--window-ids", cap.windowIds.join(","));
        }

        for (const app of cap.apps ?? []) {
            argv.push("--include-app", app);
        }

        if (cap.canvas) {
            argv.push("--canvas", cap.canvas);
        }
    }

    if (cap.outputSize) {
        argv.push("--output-size", `${cap.outputSize.width}x${cap.outputSize.height}`);
    }

    if (cap.outputScale !== undefined) {
        argv.push("--output-scale", String(cap.outputScale));
    }

    if (cap.transparent) {
        argv.push("--transparent");
    }

    if (cap.codec) {
        argv.push("--codec", cap.codec);
    }

    if (cap.indicator === false) {
        argv.push("--no-indicator");
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

/** Reject unsupported combinations before focus, actions, or recorder startup. */
export function validateCaptureOptions(cap: CaptureSpec): void {
    if (!["screen", "window", "region", "isolated"].includes(cap.mode)) {
        throw new Error("capture.mode must be screen, window, region or isolated");
    }

    const numbers: [string, number | undefined, number, number][] = [
        ["duration", cap.duration, 0.1, 180],
        ["activeFps", cap.activeFps, 0.5, 30],
        ["idleFps", cap.idleFps, 0.1, 5],
        ["threshold", cap.threshold, 0, 100],
    ];
    for (const [name, value, min, max] of numbers) {
        if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
            throw new Error(`${name} must be between ${min} and ${max}`);
        }
    }

    if (cap.screenIndex !== undefined && (!Number.isInteger(cap.screenIndex) || cap.screenIndex < 0)) {
        throw new Error("screenIndex must be a non-negative integer from preflight");
    }

    const extended = [
        cap.windowIds,
        cap.apps,
        cap.canvas,
        cap.outputSize,
        cap.outputScale,
        cap.transparent,
        cap.codec,
        cap.indicator,
    ];
    if (cap.backend === "peekaboo" && (cap.mode === "isolated" || extended.some((value) => value !== undefined))) {
        throw new Error(
            "Isolated selection, output geometry, codec, transparency and indicator options require backend native"
        );
    }

    if (cap.mode === "isolated") {
        if (!(cap.windowIds?.length || cap.apps?.length)) {
            throw new Error("isolated capture needs windowIds or apps");
        }

        if (
            cap.app !== undefined ||
            cap.windowId !== undefined ||
            cap.windowTitle !== undefined ||
            cap.windowIndex !== undefined ||
            cap.region !== undefined
        ) {
            throw new Error("isolated capture uses windowIds/apps and canvas, not singular window selectors or region");
        }
    } else if (cap.windowIds !== undefined || cap.apps !== undefined || cap.canvas !== undefined) {
        throw new Error("windowIds, apps and canvas require mode isolated");
    }

    if (
        cap.windowIds !== undefined &&
        (!Array.isArray(cap.windowIds) ||
            cap.windowIds.some((id) => !Number.isInteger(id) || id <= 0 || id > 0xffffffff))
    ) {
        throw new Error("windowIds must contain positive CG window IDs");
    }

    if (
        cap.apps !== undefined &&
        (!Array.isArray(cap.apps) || cap.apps.some((app) => typeof app !== "string" || !app.trim()))
    ) {
        throw new Error("apps must contain app names, bundle IDs or exact process IDs");
    }

    if (cap.canvas !== undefined && !["crop", "display"].includes(cap.canvas)) {
        throw new Error("canvas must be crop or display");
    }

    if (
        cap.outputSize !== undefined &&
        (cap.outputScale !== undefined ||
            ![cap.outputSize?.width, cap.outputSize?.height].every(
                (value) => Number.isInteger(value) && value >= 2 && value <= 16384
            ))
    ) {
        throw new Error(
            "outputSize needs integer width/height from 2 to 16384 and cannot be combined with outputScale"
        );
    }

    if (
        cap.outputScale !== undefined &&
        (!Number.isFinite(cap.outputScale) || cap.outputScale <= 0 || cap.outputScale > 8)
    ) {
        throw new Error("outputScale must be greater than 0 and at most 8 pixels per logical point");
    }

    if (cap.codec !== undefined && !["h264", "prores4444"].includes(cap.codec)) {
        throw new Error("codec must be h264 or prores4444");
    }

    for (const value of [cap.indicator, cap.transparent]) {
        if (value !== undefined && typeof value !== "boolean") {
            throw new Error("indicator and transparent must be booleans");
        }
    }

    if (cap.transparent && cap.mode !== "isolated" && cap.mode !== "window") {
        throw new Error("transparent capture requires isolated or window mode");
    }

    if (cap.videoOut && cap.transparent && cap.codec !== "prores4444") {
        throw new Error("Transparent video requires codec prores4444 and a .mov videoOut; H.264/MP4 has no alpha");
    }

    if (cap.videoOut && cap.codec === "prores4444" && !cap.videoOut.toLowerCase().endsWith(".mov")) {
        throw new Error("ProRes 4444 requires a .mov videoOut");
    }

    if (
        cap.videoOut &&
        (cap.codec ?? "h264") === "h264" &&
        cap.outputSize &&
        (cap.outputSize.width % 2 || cap.outputSize.height % 2)
    ) {
        throw new Error("H.264 outputSize dimensions must be even; use ProRes 4444 MOV for odd dimensions");
    }
}

export interface CaptureFlags {
    windowIds?: string;
    includeApp?: string[];
    canvas?: string;
    screenIndex?: string;
    outputSize?: string;
    outputScale?: string;
    transparent?: boolean;
    codec?: string;
    indicator?: boolean;
    duration?: string;
    videoOut?: string;
    activeFps?: string;
    idleFps?: string;
    threshold?: string;
}

/** Direct recording and plan generation share this contract. */
export function addCaptureFlags(command: Command): Command {
    return command
        .option("--window-ids <ids>", "Exact CG window IDs, comma separated, from a fresh observation")
        .option(
            "--include-app <name-or-pid>",
            "Include current visible windows of this app; repeat for several apps",
            (value: string, previous: string[]) => [...previous, value],
            []
        )
        .option("--canvas [crop|display]", "Follow selected bounds or use one full display", "crop")
        .option("--screen-index <n>", "Display canvas in NSScreen order; default 0")
        .option("--output-size <WxH>", "Exact output pixels, e.g. 200x800; exclusive with --output-scale")
        .option("--output-scale <n>", "Output pixels per logical point; default native backing scale")
        .option("--transparent", "Transparent PNG background; video also needs prores4444 and .mov")
        .option("--codec [h264|prores4444]", "H.264 MP4 or ProRes 4444 MOV", "h264")
        .option("--no-indicator", "Disable the visible recording border; otherwise shown and excluded from capture")
        .option("--video-out <path>", "Optional movie path")
        .option("--active-fps <n>", "Maximum active frame rate (0.5–30)", "8")
        .option("--idle-fps <n>", "Idle frame rate (0.1–5)", "2")
        .option("--threshold <percent>", "PNG change threshold (0–100)", "2.5");
}

export function captureFromFlags(flags: CaptureFlags): CaptureSpec {
    const dimensions = flags.outputSize?.split("x").map(Number);
    const cap: CaptureSpec = {
        mode: "isolated",
        backend: "native",
        duration: flags.duration === undefined ? 3 : Number(flags.duration),
        windowIds: flags.windowIds?.split(",").map(Number),
        apps: flags.includeApp,
        canvas: flags.canvas as CaptureSpec["canvas"],
        screenIndex: flags.screenIndex === undefined ? undefined : Number(flags.screenIndex),
        outputSize: dimensions
            ? { width: dimensions[0], height: dimensions.length === 2 ? dimensions[1] : Number.NaN }
            : undefined,
        outputScale: flags.outputScale === undefined ? undefined : Number(flags.outputScale),
        transparent: flags.transparent,
        codec: flags.codec as CaptureSpec["codec"],
        indicator: flags.indicator,
        videoOut: flags.videoOut,
        activeFps: flags.activeFps === undefined ? undefined : Number(flags.activeFps),
        idleFps: flags.idleFps === undefined ? undefined : Number(flags.idleFps),
        threshold: flags.threshold === undefined ? undefined : Number(flags.threshold),
    };
    validateCaptureOptions(cap);
    return cap;
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
    // top-left origin of this screen in GLOBAL CG points — the space click coords and
    // window bounds live in. `ax-tool screens` reports Cocoa and is flipped here;
    // Peekaboo reports CG already and is passed through. See ScreenOriginConvention.
    originCG: { x: number; y: number };
}

/**
 * Which space a source's `position` is already in.
 *
 * 🛑 The two sources DISAGREE, and the shape of the JSON does not say which is which:
 *
 * - `ax-tool screens` emits `NSScreen.frame.origin`, which is **Cocoa** (origin at the
 *   bottom-left of the primary display). It needs the flip.
 * - Peekaboo's `screen list` emits **CoreGraphics** already. Measured 2026-09-12: screen 1
 *   reports `position x=-1488 y=-1440` for a 2560x1440 display, and the maximized window on
 *   it reports CG `x=-1488 y=-1410` — the x values agree exactly and y differs by the 30-point
 *   title strip. Cocoa origins could not produce that agreement. Flipping it anyway moved the
 *   origin by 2769 points, which puts an external-display crop entirely off the image.
 */
export type ScreenOriginConvention = "cocoa" | "coregraphics";

/** Both sources report the same FIELDS; `convention` says what `position` means. */
export function parseScreenList(data: unknown, convention: ScreenOriginConvention): ScreenInfo[] {
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
        originCG: {
            x: s.position.x,
            y: convention === "cocoa" ? primaryH - (s.position.y + s.resolution.height) : s.position.y,
        },
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
