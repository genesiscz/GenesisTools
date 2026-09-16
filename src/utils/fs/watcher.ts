import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { AsyncSubscription, Event } from "@parcel/watcher";

// No static import of the logger here. `tools ts imports analyze src/utils/fs/watcher.ts` put
// 17.8 ms of this module's 19 ms import cost on `@genesiscz/utils/logger` (its prompt backend
// pulls @clack/prompts and comment-json), and the logger is used on exactly one line, inside a
// callback that runs only when a circuit breaker trips.

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
                debounceTimer = setTimeout(flushEvents, transientBackoffMs);
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
                    subscription.unsubscribe().catch(async (err) => {
                        const { logger } = await import("@genesiscz/utils/logger");
                        logger.warn({ err }, "[watcher] circuit-breaker unsubscribe failed");
                    });
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

export interface WatchPathOptions {
    /** Collect events for N ms and fire once. Default: 0 (fire per event). */
    debounceMs?: number;
}

const DEFAULT_WAIT_FOR_PATH_POLL_MS = 500;

export interface WaitForPathOptions {
    /** Give up after this long. Default: no deadline. */
    timeoutMs?: number;
    /** Abort early; resolves `false` like a timeout. */
    signal?: AbortSignal;
    /**
     * Safety-net poll behind the directory watch, in ms. Default 500; 0 disables it.
     *
     * Measured on bun 1.3.13, darwin 25.3: after the first `FSWatcher.close()` in a process, every
     * `fs.watch` created afterwards delivers at most one event (10/10 events before any close, 1/10
     * after). A long-lived process that waits for files one after another therefore goes deaf on the
     * second wait and sits out its whole timeout. Two `existsSync` calls a second heal that within
     * half a second; the watch still answers first whenever it works.
     */
    pollMs?: number;
}

/**
 * Watch ONE path (a file that may not exist yet) with `node:fs`, no native addon.
 *
 * The watch is attached to the parent DIRECTORY, never to the file. A file watcher is bound to an
 * inode, so the first write-temp-then-rename swaps the inode out from under it and it goes deaf
 * (measured 2026-09-16: a second rename produced no event at all). A directory watcher reports
 * every entry by name, so both renames and later in-place writes arrive as events for `basename`.
 *
 * Costs about 0.5 ms to arm against roughly 5 to 8 ms for loading `@parcel/watcher` plus its first
 * subscribe, which is why single-path waits do not go through `createWatcher`. The parent
 * directory must exist; it is created if it does not. Not recursive, not cross-directory: for a
 * tree, use `createWatcher`.
 */
export function watchPath(path: string, callback: WatcherCallback, opts?: WatchPathOptions): WatcherSubscription {
    const resolvedPath = resolve(path);
    const dir = dirname(resolvedPath);
    const name = basename(resolvedPath);
    const debounceMs = opts?.debounceMs ?? 0;
    mkdirSync(dir, { recursive: true });

    let isActive = true;
    let pending: WatcherEvent | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;

    const fire = async () => {
        debounceTimer = null;
        const event = pending;
        pending = null;

        if (!event || !isActive) {
            return;
        }

        try {
            await callback([event]);
            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            const { logger } = await import("@genesiscz/utils/logger");
            logger.warn({ err, path: resolvedPath }, "[watcher] watchPath callback failed");
        }
    };

    const watcher: FSWatcher = watch(dir, { persistent: true }, (eventType, filename) => {
        if (!isActive || filename === null || filename.toString() !== name) {
            return;
        }

        // `rename` covers create, delete and the atomic rename-into-place; the file's presence
        // afterwards says which. `change` is an in-place write.
        const exists = existsSync(resolvedPath);
        const type: WatcherEvent["type"] = eventType === "change" ? "update" : exists ? "create" : "delete";
        pending = { type, path: resolvedPath };

        if (debounceMs === 0) {
            void fire();
            return;
        }

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(fire, debounceMs);
    });

    watcher.on("error", (err) => {
        consecutiveErrors++;
        void import("@genesiscz/utils/logger").then(({ logger }) =>
            logger.warn({ err, path: resolvedPath }, "[watcher] watchPath fs.watch error")
        );
    });

    return {
        async unsubscribe() {
            if (!isActive) {
                return;
            }

            isActive = false;

            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }

            pending = null;
            watcher.close();
        },

        get active() {
            return isActive;
        },

        get errorCount() {
            return consecutiveErrors;
        },
    };
}

/**
 * Resolve `true` as soon as `path` exists, `false` on timeout or abort. Never throws: one `watchPath`
 * subscription, one deadline timer and a slow existence poll behind the watch (see `pollMs`). The
 * path existing before the call resolves at once; a file landing between the existence check and
 * the watch being armed is caught by a second check after arming.
 */
export async function waitForPath(path: string, opts?: WaitForPathOptions): Promise<boolean> {
    const resolvedPath = resolve(path);

    if (existsSync(resolvedPath)) {
        return true;
    }

    if (opts?.signal?.aborted) {
        return false;
    }

    let settle: (appeared: boolean) => void = () => {};
    const outcome = new Promise<boolean>((resolvePromise) => {
        settle = resolvePromise;
    });

    const subscription = watchPath(resolvedPath, (events) => {
        if (events.some((event) => event.type !== "delete")) {
            settle(true);
        }
    });

    if (existsSync(resolvedPath)) {
        settle(true);
    }

    const timer = opts?.timeoutMs === undefined ? null : setTimeout(() => settle(false), opts.timeoutMs);
    const pollMs = opts?.pollMs ?? DEFAULT_WAIT_FOR_PATH_POLL_MS;
    const poll =
        pollMs > 0
            ? setInterval(() => {
                  if (existsSync(resolvedPath)) {
                      settle(true);
                  }
              }, pollMs)
            : null;
    const onAbort = () => settle(false);
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
        return await outcome;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }

        if (poll) {
            clearInterval(poll);
        }

        opts?.signal?.removeEventListener("abort", onAbort);
        await subscription.unsubscribe();
    }
}
