/**
 * Which on-screen windows a recording picker offers. One rule for every list a person picks from: the CLI's
 * `tools control capture targets`, the recorder's start checks and, mirrored in GenesisKit
 * (`RecordableWindow.reason`), the click-to-pick picker and its hover outline. Both implementations pass the cases in
 * `src/macos/GenesisKit/Sources/GenesisKitFixtures/Recording/contract-recordable-windows.json`.
 *
 * Evidence (2026-11-19, the owner's Mac): a dimming app (HazeOver) keeps one window per display at the normal level
 * (layer 0), each the display's whole frame, alpha 0.63, untitled, owned by a menu bar app; every other recorder
 * checked (Snapzy, better-shot, Screendrop, VoiceInk, Recordly) filters only by level, size and alpha > 0, which lets
 * such an overlay through. Its own settings window (titled, opaque, 632 x 412) is a real window and stays.
 */

/** A rectangle in global CoreGraphics points (top-left origin of the primary display). */
export interface ScreenRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * How the window's app runs: a Dock app (`regular`), a menu bar or helper app (`accessory`), a background-only
 * process (`background`), or no app at all (`none`, the WindowServer's own windows). Absent when the lister is older.
 */
export type WindowOwnerKind = "regular" | "accessory" | "background" | "none";

/** What the WindowServer says about one window (`ax-tool front` rows, `CGWindowListCopyWindowInfo`). */
export interface WindowFacts {
    /** The owning app's name (`kCGWindowOwnerName`). */
    app: string;
    title?: string;
    bounds: ScreenRect;
    /** `kCGWindowLayer`; absent is the normal level (0). */
    layer?: number;
    /** `kCGWindowAlpha`; absent is opaque (1). */
    alpha?: number;
    /** `kCGWindowSharingState`: 0 means no capture can read it; absent is readable. */
    sharingState?: number;
    ownerKind?: WindowOwnerKind;
}

/** Why a window is left out of the pickers. */
export type UnrecordableReason =
    /** Above or below the normal level: the menu bar, its extras, the Dock, floating palettes, shields. */
    | "level"
    /** Fully or almost fully transparent. */
    | "invisible"
    /** Marked unreadable by screen capture (the recorder's own panels, protected windows). */
    | "not-shareable"
    /** System chrome a person does not record (the Dock, Control Center, the wallpaper). */
    | "system"
    /** No app owns it, or a background-only process does. */
    | "no-app"
    /** A strip, a badge or a helper window. */
    | "tiny"
    /** Laid over a whole display: a dimmer, a tint or an annotation layer, not an app window. */
    | "overlay";

/**
 * Window owners that are system chrome rather than something a person records. GenesisTools stays listed: the hub
 * and the review window are worth recording, and a host filters its own panels out by pid.
 */
export const RECORDING_SYSTEM_OWNERS: ReadonlySet<string> = new Set([
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
export const MIN_RECORDABLE_SIDE = 60;

/** Below this alpha a window cannot be seen. */
const MIN_VISIBLE_ALPHA = 0.1;

/**
 * A window covering this share of a display's whole frame lies over it. The menu bar keeps a zoomed window at about
 * 97 %, so only a window over the menu bar too (an overlay, or an app in native full screen) reaches it.
 */
const OVERLAY_COVERAGE = 0.99;

function overlapArea(a: ScreenRect, b: ScreenRect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

function coversDisplay(bounds: ScreenRect, displays: readonly ScreenRect[]): boolean {
    return displays.some(
        (display) =>
            display.width > 0 &&
            display.height > 0 &&
            overlapArea(bounds, display) >= OVERLAY_COVERAGE * display.width * display.height
    );
}

/**
 * Why `window` is not offered as a recording target, or `undefined` when it is a real app window. `displays` are the
 * connected displays' frames; without them no window can be told apart as an overlay.
 *
 * An overlay covers a whole display and is either see-through (alpha below 1) or untitled and owned by an app that
 * is not a Dock app. A Dock app's window in native full screen covers its display too and stays.
 */
export function unrecordableReason(
    window: WindowFacts,
    displays: readonly ScreenRect[] = []
): UnrecordableReason | undefined {
    if ((window.layer ?? 0) !== 0) {
        return "level";
    }

    const alpha = window.alpha ?? 1;
    if (alpha < MIN_VISIBLE_ALPHA) {
        return "invisible";
    }

    if (window.sharingState === 0) {
        return "not-shareable";
    }

    if (window.app.length === 0 || RECORDING_SYSTEM_OWNERS.has(window.app)) {
        return "system";
    }

    if (window.ownerKind === "none" || window.ownerKind === "background") {
        return "no-app";
    }

    if (window.bounds.width < MIN_RECORDABLE_SIDE || window.bounds.height < MIN_RECORDABLE_SIDE) {
        return "tiny";
    }

    if (coversDisplay(window.bounds, displays)) {
        const untitled = (window.title ?? "").trim().length === 0;
        const dockApp = window.ownerKind === undefined || window.ownerKind === "regular";

        if (alpha < 1 || (untitled && !dockApp)) {
            return "overlay";
        }
    }

    return undefined;
}
