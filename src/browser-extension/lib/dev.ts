import { createWatcher, type WatcherSubscription } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("browser-extension-dev");

/** Edits arrive in bursts (a save writes a temp file, then renames it): one rebuild per burst. */
const QUIET_MS = 300;

/**
 * Rebuilds on every change under `roots` and hands each result to `after` (a reload in the browser),
 * until `signal` aborts. One build at a time; a change during a build queues exactly one more.
 */
export async function watchAndRebuild({
    roots,
    build,
    after,
    signal,
}: {
    roots: string[];
    build: () => Promise<void>;
    after: () => Promise<void>;
    signal: AbortSignal;
}): Promise<void> {
    let running = false;
    let again = false;

    const run = async (): Promise<void> => {
        if (running) {
            again = true;
            return;
        }

        running = true;

        try {
            await build();
            await after();
        } catch (error) {
            log.warn({ error }, "rebuild failed; waiting for the next change");
        } finally {
            running = false;

            if (again) {
                again = false;
                void run();
            }
        }
    };

    const subscriptions: WatcherSubscription[] = [];

    try {
        for (const root of roots) {
            subscriptions.push(
                await createWatcher(
                    root,
                    (events) => {
                        log.debug({ root, changed: events.length }, "change");
                        void run();
                    },
                    { debounceMs: QUIET_MS }
                )
            );
        }

        // A Ctrl-C during the subscriptions above already fired; an abort event is never replayed.
        if (!signal.aborted) {
            await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
        }
    } finally {
        await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    }
}
