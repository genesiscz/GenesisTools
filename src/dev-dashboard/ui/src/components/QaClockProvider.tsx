import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

const TICK_MS = 1_000;

interface QaClock {
    now: () => number;
    subscribe: (onTick: () => void) => () => void;
}

/** One 1 s ticker shared by every label under the provider; it runs only while one is mounted. */
function createQaClock(): QaClock {
    let now = Date.now();
    const listeners = new Set<() => void>();
    let timer: ReturnType<typeof setInterval> | null = null;

    return {
        now: () => now,
        subscribe(onTick) {
            listeners.add(onTick);

            if (timer === null) {
                now = Date.now();
                timer = setInterval(() => {
                    now = Date.now();

                    for (const listener of listeners) {
                        listener();
                    }
                }, TICK_MS);
            }

            return () => {
                listeners.delete(onTick);

                if (listeners.size === 0 && timer !== null) {
                    clearInterval(timer);
                    timer = null;
                }
            };
        },
    };
}

const QaClockContext = createContext<QaClock>(createQaClock());

export function QaClockProvider({ children }: { children: ReactNode }) {
    const [clock] = useState(createQaClock);

    return <QaClockContext.Provider value={clock}>{children}</QaClockContext.Provider>;
}

/**
 * The clock as seen through `select`, which must return a primitive (the label itself).
 * A row re-renders only when its label changes, so "3h ago" stays put while the ticker
 * runs. The context used to carry `now` directly, and every row on the page re-rendered
 * every second: 160 to 250 ms of script per idle 20 s on a 100-row page, now about 10 ms.
 */
function useQaClock<T extends string | number | boolean>(select: (now: number) => T): T {
    const clock = useContext(QaClockContext);

    return useSyncExternalStore(clock.subscribe, () => select(clock.now()));
}

export { useQaClock };
