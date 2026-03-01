/**
 * useElapsedTimer — Tracks elapsed milliseconds since mount/activation.
 *
 * Updates every 100ms while active. Cleans up interval on deactivation or unmount.
 *
 * Usage:
 *   const elapsed = useElapsedTimer({ active: true });
 *   <Text>{formatDuration(elapsed)}</Text>
 */

import { useEffect, useRef, useState } from "react";

interface UseElapsedTimerOptions {
    active: boolean;
}

export function useElapsedTimer({ active }: UseElapsedTimerOptions): number {
    const [elapsed, setElapsed] = useState(0);
    const startTimeRef = useRef<number | null>(null);

    useEffect(() => {
        if (!active) {
            startTimeRef.current = null;
            return;
        }

        startTimeRef.current = Date.now();
        setElapsed(0);

        const interval = setInterval(() => {
            if (startTimeRef.current !== null) {
                setElapsed(Date.now() - startTimeRef.current);
            }
        }, 100);

        return () => {
            clearInterval(interval);
        };
    }, [active]);

    return elapsed;
}
