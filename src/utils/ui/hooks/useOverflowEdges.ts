import { type RefObject, useEffect, useState } from "react";

export interface OverflowEdges {
    /** Content is hidden past the left edge. */
    start: boolean;
    /** Content is hidden past the right edge. */
    end: boolean;
}

/** Which ends of a horizontal scroller hide content. Updates on scroll and on resize. */
export function useOverflowEdges(ref: RefObject<HTMLElement | null>): OverflowEdges {
    const [edges, setEdges] = useState<OverflowEdges>({ start: false, end: false });

    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }

        const read = () => {
            const max = el.scrollWidth - el.clientWidth;
            const start = el.scrollLeft > 1;
            const end = el.scrollLeft < max - 1;
            setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
        };

        read();
        el.addEventListener("scroll", read, { passive: true });
        const resize = new ResizeObserver(read);
        resize.observe(el);

        return () => {
            el.removeEventListener("scroll", read);
            resize.disconnect();
        };
    }, [ref]);

    return edges;
}

/** A mask that fades only the edges that hide content; undefined when nothing overflows. */
export function edgeFadeMask({ start, end }: OverflowEdges, size = 32): string | undefined {
    if (!start && !end) {
        return undefined;
    }

    const left = start ? `transparent, #000 ${size}px` : "#000, #000";
    const right = end ? `#000 calc(100% - ${size}px), transparent` : "#000, #000";

    return `linear-gradient(to right, ${left}, ${right})`;
}
