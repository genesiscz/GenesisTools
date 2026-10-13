/**
 * Headed Chrome windows that open on a display the user is not working on, without taking the keyboard.
 *
 * Two separate levers, both macOS only:
 *
 * - **Where.** `idleDisplayWindowArgs` asks macOS (osascript JXA, nothing to install, no Accessibility grant) for the
 *   screens, the frontmost app's top window and the mouse, picks a display that does not hold that window, and turns it
 *   into `--window-position` / `--window-size`. Chrome applies both to every new window, not only the first.
 * - **Focus.** Chrome activates itself when it shows a window as active: a startup window (a URL on argv), and a page
 *   from `Target.createTarget` without `background`. `BACKGROUND_WINDOW_TARGET` makes Chrome show the window inactive
 *   (`kShowWindowInactive` in chrome/browser/devtools/protocol/target_handler.cc), so a launcher passes
 *   `--no-startup-window` and opens its first window over CDP with these params.
 *
 * Every failure falls back to today's behaviour: no flags, a debug line in the log, never an error.
 */
import { execFile, execFileSync } from "node:child_process";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("chrome-devtools:window-placement");

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface WindowSize {
    width: number;
    height: number;
}

/** What the probe reads. `screens` is `NSScreen.screens` in AppKit coordinates: origin at the bottom-left of `screens[0]` (the primary display), y up. */
export interface DisplayLayout {
    screens: Array<{ frame: Rect; visible: Rect }>;
    /** The frontmost app's top on-screen window in CoreGraphics coordinates (top-left of `screens[0]`, y down). */
    focusedWindow: Rect | null;
    /** The mouse pointer in AppKit coordinates. */
    mouse: Point | null;
    frontApp: string | null;
}

/** A new window's bounds in Chrome's screen coordinates (top-left of the primary display, y down), and the displays involved. */
export interface WindowPlacement {
    left: number;
    top: number;
    width: number;
    height: number;
    display: number;
    activeDisplay: number;
}

/**
 * `Target.createTarget` params that open the page in a new window Chrome shows INACTIVE, so Chrome is not activated
 * and the app the user is typing in keeps the keyboard. Without `background`, Chrome shows the window active and
 * activates itself, which is what Playwright's `newPage()` does (microsoft/playwright#41306).
 */
export const BACKGROUND_WINDOW_TARGET = { newWindow: true, background: true } as const;

const PROBE_TIMEOUT_MS = 3_000;

/** Prints one JSON line. CGWindowList bounds and owner pids need no Screen Recording or Accessibility grant. */
const PROBE_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function rect(r) { return { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height }; }
var screens = [];
var list = $.NSScreen.screens;
for (var i = 0; i < list.count; i++) {
    var s = list.objectAtIndex(i);
    screens.push({ frame: rect(s.frame), visible: rect(s.visibleFrame) });
}
var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
var pid = app.processIdentifier;
var focused = null;
var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
for (var j = 0; j < windows.length; j++) {
    var w = windows[j];
    if (w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 1 && w.kCGWindowBounds.Height > 1) {
        focused = { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height };
        break;
    }
}
var m = $.NSEvent.mouseLocation;
JSON.stringify({ screens: screens, focusedWindow: focused, mouse: { x: m.x, y: m.y }, frontApp: ObjC.unwrap(app.bundleIdentifier) || null });
`;

const OSASCRIPT_ARGS = ["-l", "JavaScript", "-e", PROBE_SCRIPT];

/** Only macOS gets the idle-display placement and the inactive first window; elsewhere every launcher keeps its current behaviour. */
export function backgroundLaunchSupported(platform: NodeJS.Platform = process.platform): boolean {
    return platform === "darwin";
}

/** An AppKit rect (bottom-left origin, y up) in the top-left, y-down space that CoreGraphics and Chrome use. */
export function flipToTopLeft(rect: Rect, primaryHeight: number): Rect {
    return { x: rect.x, y: primaryHeight - rect.y - rect.height, width: rect.width, height: rect.height };
}

function overlapArea(a: Rect, b: Rect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

    return width > 0 && height > 0 ? width * height : 0;
}

function mouseDisplayIndex(layout: DisplayLayout): number | null {
    const mouse = layout.mouse;
    if (!mouse) {
        return null;
    }

    const index = layout.screens.findIndex(
        ({ frame }) =>
            mouse.x >= frame.x &&
            mouse.x < frame.x + frame.width &&
            mouse.y >= frame.y &&
            mouse.y < frame.y + frame.height
    );

    return index >= 0 ? index : null;
}

/** The display holding most of the frontmost app's window; the one under the mouse when that app shows no window. */
export function activeDisplayIndex(layout: DisplayLayout): number | null {
    const primary = layout.screens[0];
    if (!primary) {
        return null;
    }

    const focused = layout.focusedWindow;
    if (focused) {
        let best: number | null = null;
        let bestArea = 0;
        layout.screens.forEach((screen, index) => {
            const area = overlapArea(flipToTopLeft(screen.frame, primary.frame.height), focused);
            if (area > bestArea) {
                best = index;
                bestArea = area;
            }
        });

        if (best !== null) {
            return best;
        }
    }

    return mouseDisplayIndex(layout);
}

/**
 * A display other than the active one, or null when there is none or the active one is unknown. Prefers a display
 * without the mouse pointer, then the largest usable area, then the lower index, so the choice is stable.
 */
export function chooseIdleDisplay(layout: DisplayLayout): number | null {
    if (layout.screens.length < 2) {
        return null;
    }

    const active = activeDisplayIndex(layout);
    if (active === null) {
        return null;
    }

    const mouse = mouseDisplayIndex(layout);
    const area = (index: number) => layout.screens[index].visible.width * layout.screens[index].visible.height;
    const candidates = layout.screens.map((_, index) => index).filter((index) => index !== active);
    candidates.sort((a, b) => Number(a === mouse) - Number(b === mouse) || area(b) - area(a) || a - b);

    return candidates[0] ?? null;
}

/** The window at the top-left of the idle display's usable area, shrunk to fit it; null keeps the caller's default placement. */
export function planWindowPlacement(layout: DisplayLayout, size: WindowSize): WindowPlacement | null {
    const display = chooseIdleDisplay(layout);
    const activeDisplay = activeDisplayIndex(layout);
    if (display === null || activeDisplay === null) {
        return null;
    }

    const visible = flipToTopLeft(layout.screens[display].visible, layout.screens[0].frame.height);

    return {
        left: Math.round(visible.x),
        top: Math.round(visible.y),
        width: Math.round(Math.min(size.width, visible.width)),
        height: Math.round(Math.min(size.height, visible.height)),
        display,
        activeDisplay,
    };
}

export function windowPlacementArgs(placement: WindowPlacement): string[] {
    return [
        `--window-position=${placement.left},${placement.top}`,
        `--window-size=${placement.width},${placement.height}`,
    ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function toRect(value: unknown): Rect | null {
    if (!isRecord(value)) {
        return null;
    }

    const { x, y, width, height } = value;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
        return null;
    }

    return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The probe's JSON line, checked field by field; null when any screen is malformed. */
export function parseDisplayLayout(text: string): DisplayLayout | null {
    let raw: unknown;
    try {
        raw = SafeJSON.parse(text, { strict: true });
    } catch (err) {
        log.debug({ err, text: text.slice(0, 200) }, "display probe printed something that is not JSON");
        return null;
    }

    if (!isRecord(raw) || !Array.isArray(raw.screens)) {
        return null;
    }

    const screens: DisplayLayout["screens"] = [];
    for (const screen of raw.screens) {
        const frame = isRecord(screen) ? toRect(screen.frame) : null;
        const visible = isRecord(screen) ? toRect(screen.visible) : null;
        if (!frame || !visible) {
            return null;
        }

        screens.push({ frame, visible });
    }

    if (screens.length === 0) {
        return null;
    }

    const mouse = raw.mouse;
    return {
        screens,
        focusedWindow: toRect(raw.focusedWindow),
        mouse:
            isRecord(mouse) && typeof mouse.x === "number" && typeof mouse.y === "number"
                ? { x: mouse.x, y: mouse.y }
                : null,
        frontApp: typeof raw.frontApp === "string" ? raw.frontApp : null,
    };
}

/** Screens, frontmost window and mouse from macOS; null off macOS or when osascript fails. */
export async function probeDisplayLayout(): Promise<DisplayLayout | null> {
    if (!backgroundLaunchSupported()) {
        return null;
    }

    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile("osascript", OSASCRIPT_ARGS, { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" }, (error, out) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(out);
            });
        });

        return parseDisplayLayout(stdout);
    } catch (err) {
        log.debug({ err }, "display probe failed; the window keeps its default placement");
        return null;
    }
}

/** `probeDisplayLayout` for a synchronous caller such as a Playwright config module. */
export function probeDisplayLayoutSync(): DisplayLayout | null {
    if (!backgroundLaunchSupported()) {
        return null;
    }

    try {
        const stdout = execFileSync("osascript", OSASCRIPT_ARGS, {
            timeout: PROBE_TIMEOUT_MS,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });

        return parseDisplayLayout(stdout);
    } catch (err) {
        log.debug({ err }, "display probe failed; the window keeps its default placement");
        return null;
    }
}

function placementArgsFor(layout: DisplayLayout | null, size: WindowSize): string[] {
    if (!layout) {
        return [];
    }

    const placement = planWindowPlacement(layout, size);
    log.debug(
        { frontApp: layout.frontApp, screens: layout.screens.length, placement },
        placement
            ? "headed Chrome window goes to an idle display"
            : "no idle display; the window keeps its default placement"
    );

    return placement ? windowPlacementArgs(placement) : [];
}

/**
 * `--window-position` and `--window-size` for a display the user is not working on. Empty with one display, off
 * macOS, or when the probe fails: the caller then launches exactly as before.
 */
export async function idleDisplayWindowArgs(size: WindowSize): Promise<string[]> {
    return placementArgsFor(await probeDisplayLayout(), size);
}

export function idleDisplayWindowArgsSync(size: WindowSize): string[] {
    return placementArgsFor(probeDisplayLayoutSync(), size);
}
