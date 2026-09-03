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

    async tick(): Promise<number> {
        if (this.ticking) {
            return 0;
        }

        this.ticking = true;

        try {
            const watchers = await this.monitor.listWatchers({ enabledOnly: true });
            const now = this.now();
            const due = watchers.filter((watcher) => isDue(watcher, now) && !this.monitor.isRunning(watcher.id));
            const batch = due.slice(0, this.concurrency);

            await Promise.all(
                batch.map((watcher) =>
                    this.monitor.runWatcher(watcher).catch((error) => {
                        logger.error({ error, id: watcher.id, name: watcher.name }, "monitor: scheduled check failed");
                    })
                )
            );

            return batch.length;
        } catch (error) {
            logger.error({ error }, "monitor: scheduler tick failed");

            return 0;
        } finally {
            this.ticking = false;
        }
    }
}
