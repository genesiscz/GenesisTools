/** Pure placement helpers for the watch-page side panel (testable without a YT page). */

export interface RectLike {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

export function isUsableLiveChatStyle(style: { display: string; visibility: string }, rect: RectLike): boolean {
    if (style.display === "none" || style.visibility === "hidden") {
        return false;
    }

    // Ghost/ended-live frames often stay in the DOM at ~0 height.
    return rect.height >= 80 && rect.width >= 120;
}

export function isInFlowPosition(position: string): boolean {
    return position === "static" || position === "relative";
}

/** True when `a` substantially overlaps `b` (same idea as coversPlayer). */
export function rectsOverlapSubstantially(a: RectLike, b: RectLike, minPx = 40): boolean {
    if (a.width === 0 || b.width === 0) {
        return false;
    }

    const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return horizontal > minPx && vertical > minPx;
}

/**
 * Whether a panel currently on the fixed fallback should re-attempt inline.
 *
 * The fallback used to be terminal — nothing re-measured once we retreated, so
 * a transient bad layout (theater mode, a mid-navigation reflow) left the panel
 * floating over the rail until the next navigation. `attempts` bounds the
 * retry so a slot that keeps failing can't remount the panel forever.
 */
export function shouldRecoverInline({
    placement,
    slotAvailable,
    attempts,
    maxAttempts,
}: {
    placement: "inline" | "fixed";
    slotAvailable: boolean;
    attempts: number;
    maxAttempts: number;
}): boolean {
    if (placement !== "fixed") {
        return false;
    }

    return slotAvailable && attempts < maxAttempts;
}

/** Full-bleed strip: host spans ~player width with nearly aligned left edges. */
export function isFullBleedOverPlayer(host: RectLike, player: RectLike): boolean {
    if (host.width === 0 || player.width === 0) {
        return false;
    }

    const widthRatio = host.width / player.width;
    const leftDelta = Math.abs(host.left - player.left);

    return widthRatio > 0.85 && leftDelta < 48 && rectsOverlapSubstantially(host, player, 20);
}
