import { useEffect, useState } from "react";

/** How often a relative time ("4 min ago") moves on; minutes are its grain. */
const MINUTE_MS = 60_000;

/**
 * Epoch ms that changes once a minute, for lists that print relative times. A `Date.now()` in render changes on
 * every render, so each memoized row and `renderItem` built on it re-renders every time the list does.
 */
export function useMinuteClock(): number {
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
        return () => clearInterval(timer);
    }, []);

    return now;
}
