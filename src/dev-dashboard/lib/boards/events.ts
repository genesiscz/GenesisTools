import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface BoardEvent {
    type: string;
    payload: unknown;
}

type Subscriber = (frame: string) => void;

const subscribers = new Map<string, Set<Subscriber>>(); // board slug → sinks

export function subscribeBoard(slug: string, fn: Subscriber): () => void {
    let set = subscribers.get(slug);
    if (!set) {
        set = new Set();
        subscribers.set(slug, set);
    }
    set.add(fn);
    return () => {
        set?.delete(fn);
        if (set && set.size === 0) {
            subscribers.delete(slug);
        }
    };
}

export function publishBoardEvent(slug: string, event: BoardEvent): void {
    const set = subscribers.get(slug);
    if (!set || set.size === 0) {
        return;
    }

    const frame = SafeJSON.stringify(event);
    for (const fn of set) {
        try {
            fn(frame);
        } catch (err) {
            logger.warn({ err, slug }, "boards event sink threw");
        }
    }
}

// ---- work signal: close-and-swap broadcast for /work/wait long-pollers ----
let waiters: Array<() => void> = [];

export function wakeWorkWaiters(): void {
    const current = waiters;
    waiters = [];
    for (const fn of current) {
        fn();
    }
}

/** Resolves "wake" when new work may exist, "timeout" after ms. Always removes itself. */
export function waitForWorkSignal(ms: number): Promise<"wake" | "timeout"> {
    return new Promise((resolve) => {
        const entry = () => {
            clearTimeout(timer);
            resolve("wake");
        };
        const timer = setTimeout(() => {
            waiters = waiters.filter((w) => w !== entry);
            resolve("timeout");
        }, ms);
        waiters.push(entry);
    });
}

/** Test-only. */
export function resetEventHub(): void {
    subscribers.clear();
    waiters = [];
}
