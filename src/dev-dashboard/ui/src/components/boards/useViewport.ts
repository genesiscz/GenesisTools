import { useEffect, useRef, useState } from "react";

export interface Viewport {
    x: number; // screen-px offset of world origin
    y: number;
    scale: number;
}

export const MIN_SCALE = 0.08;
export const MAX_SCALE = 4;

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale };
}

/** Zoom by factor keeping the screen point (sx, sy) fixed. */
export function zoomAt(vp: Viewport, factor: number, sx: number, sy: number): Viewport {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
    const k = scale / vp.scale;
    return { scale, x: sx - (sx - vp.x) * k, y: sy - (sy - vp.y) * k };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
    return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

/** Reset zoom to 1 while keeping the world point currently at the viewport center in place
 *  (vitrinka's ⌘0 semantics) — not a jump to world origin. */
export function resetZoom(vp: Viewport, width: number, height: number): Viewport {
    return zoomAt(vp, 1 / vp.scale, width / 2, height / 2);
}

/** Fit a world bounding box into a screen rect with padding. */
export function fitBounds(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    { width, height, pad = 64 }: { width: number; height: number; pad?: number }
): Viewport {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((width - pad * 2) / w, (height - pad * 2) / h)));
    return {
        scale,
        x: (width - w * scale) / 2 - bounds.minX * scale,
        y: (height - h * scale) / 2 - bounds.minY * scale,
    };
}

/** True when some ancestor between the event target and the canvas root both scrolls and can
 *  still move further in the wheel's dominant direction. */
function scrollableAncestorCanConsume(e: WheelEvent, root: HTMLElement): boolean {
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    let node = e.target instanceof HTMLElement ? e.target : null;

    while (node && node !== root) {
        const style = window.getComputedStyle(node);
        const overflow = vertical ? style.overflowY : style.overflowX;

        if (overflow === "auto" || overflow === "scroll") {
            if (vertical && node.scrollHeight > node.clientHeight) {
                const canDown = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
                const canUp = node.scrollTop > 0;

                if ((e.deltaY > 0 && canDown) || (e.deltaY < 0 && canUp)) {
                    return true;
                }
            }

            if (!vertical && node.scrollWidth > node.clientWidth) {
                const canRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
                const canLeft = node.scrollLeft > 0;

                if ((e.deltaX > 0 && canRight) || (e.deltaX < 0 && canLeft)) {
                    return true;
                }
            }
        }

        node = node.parentElement;
    }

    return false;
}

export function useViewport() {
    const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
    const spaceDown = useRef(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Non-passive native listener: React's synthetic onWheel is passive on some
    // targets, which silently no-ops preventDefault and lets the page scroll/zoom
    // fight our pan/zoom. Attaching directly with { passive: false } is the only
    // reliable way to own wheel input on the canvas.
    useEffect(() => {
        const el = containerRef.current;

        if (!el) {
            return;
        }

        const onWheel = (e: WheelEvent) => {
            // A scrollable element inside a card (viz table, long text) owns the wheel when it
            // can still consume the delta in that direction — otherwise long card content is
            // unreachable because the canvas pans instead.
            if (!e.ctrlKey && !e.metaKey && scrollableAncestorCanConsume(e, el)) {
                return;
            }

            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            if (e.ctrlKey || e.metaKey) {
                setVp((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), sx, sy));
            } else {
                setVp((v) => panBy(v, -e.deltaX, -e.deltaY));
            }
        };

        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);

    return { vp, setVp, containerRef, spaceDown };
}
