import { resolve } from "node:path";
import type { AsyncSubscription, Event } from "@parcel/watcher";

export interface WatcherEvent {
    type: "create" | "update" | "delete";
    path: string;
}

export interface WatcherOptions {
    /** Debounce interval -- collect changes for N ms, fire once. Default: 2000 */
    debounceMs?: number;
    /** Glob patterns for directories to ignore at the OS level (e.g. "node_modules"). Default: common ignores */
    ignorePatterns?: string[];
    /** Maximum consecutive errors before circuit breaker trips. Default: 10 */
    maxErrors?: number;
    /** Custom filter -- return false to ignore an event. Applied after OS-level ignores. */
    filter?: (event: WatcherEvent) => boolean;
    /** Pause duration for transient infrastructure errors (ms). Default: 30000 */
    transientBackoffMs?: number;
    /** Callback when a transient error causes back-off */
    onTransientError?: (err: Error, backoffMs: number) => void;
}

export interface WatcherSubscription {
    /** Stop watching and release native resources */
    unsubscribe(): Promise<void>;
    /** Whether the watcher is still active */
    readonly active: boolean;
    /** Number of consecutive errors (resets on successful event) */
    readonly errorCount: number;
}

export type WatcherCallback = (events: WatcherEvent[]) => void | Promise<void>;

export const DEFAULT_IGNORE_PATTERNS: string[] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    "__pycache__",
    ".venv",
    "coverage",
    ".cache",
    ".turbo",
    "vendor",
];

function mapEventType(type: Event["type"]): WatcherEvent["type"] {
    switch (type) {
        case "create":
            return "create";
        case "update":
            return "update";
        case "delete":
            return "delete";
        default:
            return "update";
    }
}

const TRANSIENT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

const TRANSIENT_MESSAGE_PATTERNS = ["econnrefused", "dns", "timeout", "network", "connection reset", "socket hang up"];

/** Classify whether an error is a transient infrastructure issue */
export function isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }

    const code = (err as NodeJS.ErrnoException).code;

    if (code && TRANSIENT_ERROR_CODES.has(code)) {
        return true;
    }

    const msg = err.message.toLowerCase();

    for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
        if (msg.includes(pattern)) {
            return true;
        }
    }

    return false;
}

export async function createWatcher(
    dir: string,
    callback: WatcherCallback,
    opts?: WatcherOptions
): Promise<WatcherSubscription> {
    const resolvedDir = resolve(dir);
    const debounceMs = opts?.debounceMs ?? 2000;
    const ignorePatterns = opts?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    const maxErrors = opts?.maxErrors ?? 10;
    const filter = opts?.filter;
    const transientBackoffMs = opts?.transientBackoffMs ?? 30000;
    const onTransientError = opts?.onTransientError;

    // Accumulate events for debounce (latest event type per path wins)
    const pendingEvents = new Map<string, WatcherEvent>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;
    let isActive = true;

    // Lazy-import @parcel/watcher (native addon)
    const watcher = await import("@parcel/watcher");

    const flushEvents = async () => {
        debounceTimer = null;

        if (pendingEvents.size === 0) {
            return;
        }

        // Snapshot events for this flush; keep pendingEvents intact until success
        const events = Array.from(pendingEvents.values());
        const flushedPaths = new Set(pendingEvents.keys());

        try {
            await callback(events);
            consecutiveErrors = 0;

            // Only remove events that were successfully processed.
            // New events that arrived during the callback stay in pendingEvents.
            for (const path of flushedPaths) {
                pendingEvents.delete(path);
            }
        } catch (err) {
            if (isTransientError(err)) {
                if (onTransientError) {
                    onTransientError(err as Error, transientBackoffMs);
                }

                // Schedule retry after backoff -- do NOT increment consecutiveErrors
                setTimeout(flushEvents, transientBackoffMs);
                return;
            }

            consecutiveErrors++;

            if (consecutiveErrors >= maxErrors) {
                isActive = false;
                await subscription.unsubscribe();
            }
        }
    };

    const subscription: AsyncSubscription = await watcher.default.subscribe(
        resolvedDir,
        (err: Error | null, events: Event[]) => {
            if (!isActive) {
                return;
            }

            if (err) {
                consecutiveErrors++;

                if (consecutiveErrors >= maxErrors) {
                    isActive = false;
                    subscription.unsubscribe().catch(() => {});
                }

                return;
            }

            // Reset error count on successful event delivery
            consecutiveErrors = 0;

            for (const event of events) {
                const mapped: WatcherEvent = {
                    type: mapEventType(event.type),
                    path: event.path,
                };

                if (filter && !filter(mapped)) {
                    continue;
                }

                pendingEvents.set(event.path, mapped);
            }

            if (pendingEvents.size > 0) {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }

                debounceTimer = setTimeout(flushEvents, debounceMs);
            }
        },
        {
            ignore: ignorePatterns,
        }
    );

    const handle: WatcherSubscription = {
        async unsubscribe() {
            if (!isActive) {
                return;
            }

            isActive = false;

            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }

            pendingEvents.clear();
            await subscription.unsubscribe();
        },

        get active() {
            return isActive;
        },

        get errorCount() {
            return consecutiveErrors;
        },
    };

    return handle;
}
