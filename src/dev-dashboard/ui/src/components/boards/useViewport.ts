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

/** Fit a world bounding box into a screen rect with padding. */
export function fitBounds(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    width: number,
    height: number,
    pad = 64
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
