import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * The time, advanced once a minute while `active`, for a countdown or an "ago" that must move on its own: a query
 * whose data did not change renders nothing new, so a `Date.now()` read in render froze until something else did.
 * Inactive (a screen not focused), the clock stops; it reads the time again when it starts.
 */
export function useMinuteClock(active: boolean, everyMs = MINUTE_MS): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!active) {
            return;
        }

        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(timer);
    }, [active, everyMs]);

    return now;
}
