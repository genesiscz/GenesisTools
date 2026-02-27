import { useInput } from "ink";
import { useState } from "react";

interface ScrollOptions {
    totalItems: number;
    pageSize: number;
    enabled: boolean;
}

export function useScroll({ totalItems, pageSize, enabled }: ScrollOptions) {
    const [offset, setOffset] = useState(0);

    useInput(
        (input, key) => {
            if (!enabled) {
                return;
            }

            if (input === "j" || key.downArrow) {
                setOffset((o) => Math.min(o + 1, Math.max(0, totalItems - pageSize)));
            }

            if (input === "k" || key.upArrow) {
                setOffset((o) => Math.max(0, o - 1));
            }

            if (input === "g") {
                setOffset(0);
            }

            if (input === "G") {
                setOffset(Math.max(0, totalItems - pageSize));
            }

            if (key.ctrl && input === "d") {
                setOffset((o) => Math.min(o + pageSize, Math.max(0, totalItems - pageSize)));
            }

            if (key.ctrl && input === "u") {
                setOffset((o) => Math.max(0, o - pageSize));
            }
        },
        { isActive: enabled }
    );

    return { offset, setOffset };
}
