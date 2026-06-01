import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

const EDGE_THRESHOLD_PX = 24;

export type AutoScrollEdge = "top" | "bottom";

export interface UseAutoScrollOptions {
    /** When true, follow new content at `edge` (unless user scrolled away). */
    enabled: boolean;
    /** Fired when user scrolls off the edge (false) or returns to it (true). */
    onEnabledChange: (enabled: boolean) => void;
    /** Which scroll edge to pin — bottom = classic log tail, top = newest-first. */
    edge?: AutoScrollEdge;
    /** Content deps that should trigger a snap while pinned (e.g. lines, sortDir). */
    snapDeps: readonly unknown[];
    /** Distance from edge still counts as "at edge". */
    edgeThresholdPx?: number;
}

export interface UseAutoScrollResult {
    ref: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    /** Re-pin to edge and re-enable autoscroll (toolbar button). */
    resume: () => void;
}

function isAtScrollEdge(el: HTMLElement, edge: AutoScrollEdge, thresholdPx: number): boolean {
    if (edge === "top") {
        return el.scrollTop <= thresholdPx;
    }

    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

export function useAutoScroll({
    enabled,
    onEnabledChange,
    edge = "bottom",
    snapDeps,
    edgeThresholdPx = EDGE_THRESHOLD_PX,
}: UseAutoScrollOptions): UseAutoScrollResult {
    const ref = useRef<HTMLDivElement>(null);
    const pinnedToEdgeRef = useRef(true);
    const programmaticRef = useRef(false);

    const snapToEdge = useCallback(() => {
        const el = ref.current;

        if (!el) {
            return;
        }

        programmaticRef.current = true;
        el.scrollTop = edge === "top" ? 0 : Number.MAX_SAFE_INTEGER;
        requestAnimationFrame(() => {
            programmaticRef.current = false;
        });
    }, [edge]);

    const resume = useCallback(() => {
        pinnedToEdgeRef.current = true;
        onEnabledChange(true);
        snapToEdge();
    }, [onEnabledChange, snapToEdge]);

    useLayoutEffect(() => {
        if (enabled && pinnedToEdgeRef.current) {
            snapToEdge();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, snapToEdge, ...snapDeps]);

    const onScroll = useCallback(() => {
        if (programmaticRef.current) {
            return;
        }

        const el = ref.current;

        if (!el) {
            return;
        }

        const atEdge = isAtScrollEdge(el, edge, edgeThresholdPx);

        if (!atEdge && pinnedToEdgeRef.current) {
            pinnedToEdgeRef.current = false;
            onEnabledChange(false);
            return;
        }

        if (atEdge && !pinnedToEdgeRef.current) {
            pinnedToEdgeRef.current = true;
            onEnabledChange(true);
        }
    }, [edge, edgeThresholdPx, onEnabledChange]);

    return { ref, onScroll, resume };
}
