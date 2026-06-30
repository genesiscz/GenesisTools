import { existsSync, type FSWatcher, watch } from "node:fs";
import { logger } from "@app/logger";

const log = logger.child({ component: "fs:file-feed-watcher" });

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_FALLBACK_MS = 1000;

export interface FileFeedWatcherOptions {
    path: string;
    onChange: () => Promise<{ done: boolean } | void> | { done: boolean } | void;
    deadlineAt?: number;
    debounceMs?: number;
    pollFallbackMs?: number;
    signal?: AbortSignal;
}

/**
 * Watches a file for change events and invokes a callback per change.
 *
 * - Uses `fs.watch` (inotify/kqueue) with a setInterval polling fallback in case
 *   the platform's watcher misses events (macOS APFS is known to drop notifications).
 * - Debounces bursts of change events into a single callback.
 * - The callback can signal completion by returning `{ done: true }` — the watcher
 *   stops cleanly and the returned Promise resolves.
 * - Deadline (optional wall-clock cap, e.g. 1h sanity ceiling) triggers a final
 *   callback then resolves.
 * - All timers are cleaned up; late-arriving timer callbacks check `resolved` and
 *   short-circuit (prevents post-cleanup emissions).
 *
 * Returns a Promise that resolves when the watcher exits (deadline or done).
 */
export async function watchFileFeed(opts: FileFeedWatcherOptions): Promise<void> {
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const pollFallbackMs = opts.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS;

    let watcher: FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    let onAbort: (() => void) | null = null;

    const cleanup = (): void => {
        if (watcher) {
            watcher.close();
            watcher = null;
        }

        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        if (onAbort && opts.signal) {
            opts.signal.removeEventListener("abort", onAbort);
            onAbort = null;
        }
    };

    return new Promise<void>((resolve) => {
        const finish = (): void => {
            if (resolved) {
                return;
            }

            resolved = true;
            cleanup();
            resolve();
        };

        let checking = false;
        const check = async (): Promise<void> => {
            if (resolved || checking) {
                return;
            }

            checking = true;
            try {
                const result = await opts.onChange();

                if (resolved) {
                    return;
                }

                if (result && result.done) {
                    finish();
                    return;
                }

                if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
                    finish();
                    return;
                }
            } catch (err) {
                log.warn({ err, path: opts.path }, "onChange callback threw");
            } finally {
                checking = false;
            }
        };

        const debounce = (): void => {
            if (debounceTimer) {
                return;
            }

            debounceTimer = setTimeout(() => {
                debounceTimer = null;

                if (resolved) {
                    return;
                }

                void check();
            }, debounceMs);
        };

        if (opts.signal) {
            if (opts.signal.aborted) {
                finish();
                return;
            }

            onAbort = (): void => {
                finish();
            };
            opts.signal.addEventListener("abort", onAbort);
        }

        try {
            if (existsSync(opts.path)) {
                watcher = watch(opts.path, { persistent: true }, debounce);
                watcher.on("error", (err) => {
                    log.warn(
                        { err, path: opts.path },
                        "fs.watch runtime error; closing watcher, poll fallback continues"
                    );

                    if (watcher) {
                        watcher.close();
                        watcher = null;
                    }
                });
            }
        } catch (err) {
            log.warn({ err, path: opts.path }, "fs.watch failed; using poll only");
        }

        pollTimer = setInterval(() => {
            if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
                finish();
                return;
            }

            void check();
        }, pollFallbackMs);

        void check();
    });
}
