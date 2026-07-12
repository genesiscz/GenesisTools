import { useInput } from "ink";
import { useState } from "react";

interface ScrollOptions {
    totalItems: number;
    pageSize: number;
    enabled: boolean;
    initialOffset?: number;
    /** Bind j/k as line scroll (default). Views that repurpose j/k set false. */
    vimKeys?: boolean;
    /**
     * Override the `totalItems - pageSize` max-offset formula. Views whose
     * rows cost a variable number of lines (group headers, margins) can't
     * express that as a flat `pageSize` — pass the max offset computed by
     * their own greedy-fill logic instead. Falls back to the flat formula
     * when omitted, so existing flat-row consumers are unaffected.
     */
    maxOffsetOverride?: number;
}

export function useScroll({
    totalItems,
    pageSize,
    enabled,
    initialOffset,
    vimKeys = true,
    maxOffsetOverride,
}: ScrollOptions) {
    const [offset, setOffset] = useState(initialOffset ?? 0);
    const maxOffset = maxOffsetOverride ?? Math.max(0, totalItems - pageSize);

    useInput(
        (input, key) => {
            if (!enabled) {
                return;
            }

            if ((vimKeys && input === "j") || key.downArrow) {
                setOffset((o) => Math.min(o + 1, maxOffset));
            }

            if ((vimKeys && input === "k") || key.upArrow) {
                setOffset((o) => Math.max(0, o - 1));
            }

            if (input === "g") {
                setOffset(0);
            }

            if (input === "G") {
                setOffset(maxOffset);
            }

            if (key.ctrl && input === "d") {
                setOffset((o) => Math.min(o + pageSize, maxOffset));
            }

            if (key.ctrl && input === "u") {
                setOffset((o) => Math.max(0, o - pageSize));
            }
        },
        { isActive: enabled }
    );

    return { offset, setOffset };
}
