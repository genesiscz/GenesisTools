import { logger } from "@genesiscz/utils/logger";
import { parseSqliteOrIsoDate } from "@genesiscz/utils/sql-time";
import type { Monitor } from "./monitor";
import type { Watcher } from "./types";

export interface SchedulerOptions {
    /** How often the due list is re-read from the database. Default 1 s. */
    tickMs?: number;
    /** Checks allowed to run at the same time. Default 8. */
    concurrency?: number;
    now?: () => number;
}

export function isDue(watcher: Watcher, now: number): boolean {
    if (!watcher.lastCheckedAt) {
        return true;
    }

    const last = parseSqliteOrIsoDate(watcher.lastCheckedAt)?.getTime();

    if (last === undefined) {
        return true;
    }

    return now - last >= watcher.intervalSec * 1000;
}

/**
 * Re-reads enabled watchers from the database every tick, so a watcher added
 * from the CLI or paused from the dashboard takes effect without a restart.
 * Due-ness comes from `last_checked_at`, which a CLI `check` also advances.
 */
export class Scheduler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    private readonly active = new Set<number>();
    private settled: Promise<void> = Promise.resolve();
    private readonly tickMs: number;
    private readonly concurrency: number;
    private readonly now: () => number;

    constructor(
        private readonly monitor: Monitor,
        opts: SchedulerOptions = {}
    ) {
        this.tickMs = opts.tickMs ?? 1_000;
        this.concurrency = opts.concurrency ?? 8;
        this.now = opts.now ?? Date.now;
    }

    start(): void {
        if (this.timer) {
            return;
        }

        logger.info({ tickMs: this.tickMs, concurrency: this.concurrency }, "monitor: scheduler started");
        this.timer = setInterval(() => {
            void this.tick();
        }, this.tickMs);
        void this.tick();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.info("monitor: scheduler stopped");
        }
    }

    get running(): boolean {
        return this.timer !== null;
    }

    /** Checks started by the scheduler that have not settled yet. */
    get activeRuns(): number {
        return this.active.size;
    }

    /**
     * Starts due checks up to the free concurrency and returns at once; a slow
     * check (up to the 120 s timeout) never blocks the next tick from starting
     * other watchers. Returns how many checks this tick launched.
     */
    async tick(): Promise<number> {
        if (this.ticking) {
            return 0;
        }

        this.ticking = true;

        try {
            const free = this.concurrency - this.active.size;

            if (free <= 0) {
                return 0;
            }

            const watchers = await this.monitor.listWatchers({ enabledOnly: true });
            const now = this.now();
            const due = watchers.filter(
                (watcher) => isDue(watcher, now) && !this.active.has(watcher.id) && !this.monitor.isRunning(watcher.id)
            );
            const batch = due.slice(0, free);

            for (const watcher of batch) {
                this.active.add(watcher.id);
                this.settled = Promise.all([
                    this.settled,
                    this.monitor
                        .runWatcher(watcher)
                        .catch((error) => {
                            logger.error(
                                { error, id: watcher.id, name: watcher.name },
                                "monitor: scheduled check failed"
                            );
                        })
                        .finally(() => {
                            this.active.delete(watcher.id);
                        }),
                ]).then(() => undefined);
            }

            return batch.length;
        } catch (error) {
            logger.error({ error }, "monitor: scheduler tick failed");

            return 0;
        } finally {
            this.ticking = false;
        }
    }

    /** Resolves once every check launched so far has settled (tests, shutdown). */
    drain(): Promise<void> {
        return this.settled;
    }
}
