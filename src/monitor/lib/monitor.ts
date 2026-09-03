import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification, type NotificationEvent } from "@genesiscz/utils/notifications";
import { runCheck } from "./checks/run-check";
import { MonitorDatabase } from "./db";
import { getMonitorNotifyMeta } from "./notify-settings";
import { dispatchToTarget, dispatchToTargets, NOTIFY_APP } from "./notify-targets";
import type {
    CheckRecord,
    FeedItem,
    Incident,
    IncidentStatus,
    MonitorEvent,
    NotifyTarget,
    NotifyTargetInput,
    NotifyTargetPatch,
    Overview,
    OverviewCounts,
    ParsedFeedItem,
    Watcher,
    WatcherInput,
    WatcherPatch,
    WatcherStatus,
    WatcherSummary,
} from "./types";

export type MonitorListener = (event: MonitorEvent) => void;

export interface RunOutcome {
    watcher: Watcher;
    check: CheckRecord;
    transition: { from: WatcherStatus; to: WatcherStatus; incident: Incident | null } | null;
    /** rss: items first seen by this check (empty for other kinds). */
    newItems: FeedItem[];
}

function isOutage(status: WatcherStatus): status is IncidentStatus {
    return status === "down" || status === "degraded";
}

function feedItemsFromMeta(meta: Record<string, unknown> | undefined): ParsedFeedItem[] {
    const items = meta?.items;

    return Array.isArray(items) ? (items as ParsedFeedItem[]) : [];
}

/**
 * The one core behind every door (CLI, HTTP routes, scheduler). Owns the
 * database, runs checks, keeps incidents in step with status changes, delivers
 * feed items, and fans events out to whoever listens (WebSocket bridge, tests).
 */
export class Monitor {
    readonly db: MonitorDatabase;
    private readonly listeners = new Set<MonitorListener>();
    private readonly inFlight = new Set<number>();

    constructor(opts: { dbPath?: string } = {}) {
        this.db = new MonitorDatabase(opts.dbPath);
    }

    on(listener: MonitorListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(event: MonitorEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                logger.warn({ error, type: event.type }, "monitor: event listener threw");
            }
        }
    }

    close(): void {
        this.listeners.clear();
        this.db.close();
    }

    // ---------------------------------------------------------------- reading

    listWatchers(opts: { enabledOnly?: boolean } = {}): Promise<Watcher[]> {
        return this.db.listWatchers(opts);
    }

    getWatcher(id: number): Promise<Watcher | null> {
        return this.db.getWatcher(id);
    }

    async getSummary(id: number): Promise<WatcherSummary | null> {
        const watcher = await this.db.getWatcher(id);

        return watcher ? this.db.summarize(watcher) : null;
    }

    async overview(): Promise<Overview> {
        const watchers = await this.db.summarizeAll();
        const counts: OverviewCounts = { total: watchers.length, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0 };

        for (const watcher of watchers) {
            if (!watcher.enabled) {
                counts.paused += 1;
                continue;
            }

            counts[watcher.lastStatus] += 1;
        }

        return { counts, watchers, openIncidents: await this.db.listIncidents({ openOnly: true }) };
    }

    isRunning(id: number): boolean {
        return this.inFlight.has(id);
    }

    // ---------------------------------------------------------------- writing

    async createWatcher(input: WatcherInput): Promise<Watcher> {
        const watcher = await this.db.createWatcher(input);
        this.emit({ type: "watcher:created", watcher });

        return watcher;
    }

    async updateWatcher(id: number, patch: WatcherPatch): Promise<Watcher | null> {
        const watcher = await this.db.updateWatcher(id, patch);

        if (watcher) {
            logger.info({ id, patch }, "monitor: watcher updated");
            this.emit({ type: "watcher:updated", watcher });
        }

        return watcher;
    }

    async deleteWatcher(id: number): Promise<boolean> {
        const deleted = await this.db.deleteWatcher(id);

        if (deleted) {
            logger.info({ id }, "monitor: watcher deleted");
            this.emit({ type: "watcher:deleted", watcherId: id });
        }

        return deleted;
    }

    // -------------------------------------------------------- notify targets

    listTargets(): Promise<NotifyTarget[]> {
        return this.db.listTargets();
    }

    getTarget(id: number): Promise<NotifyTarget | null> {
        return this.db.getTarget(id);
    }

    createTarget(input: NotifyTargetInput): Promise<NotifyTarget> {
        return this.db.createTarget(input);
    }

    updateTarget(id: number, patch: NotifyTargetPatch): Promise<NotifyTarget | null> {
        return this.db.updateTarget(id, patch);
    }

    deleteTarget(id: number): Promise<boolean> {
        return this.db.deleteTarget(id);
    }

    /** Demo message through one library target, even when the target is paused. */
    async testTarget(id: number): Promise<NotifyTarget | null> {
        const target = await this.db.getTarget(id);

        if (!target) {
            return null;
        }

        await dispatchToTarget(
            { ...target, enabled: true },
            {
                app: NOTIFY_APP,
                title: `Monitor test · ${target.name}`,
                subtitle: target.channel,
                message: `This is how "${target.name}" sounds when a watcher changes state.`,
                group: `monitor-target-${target.id}`,
            }
        );

        return target;
    }

    // ---------------------------------------------------------------- checking

    /**
     * Runs one check, records it, moves incidents, delivers feed items,
     * notifies on transitions. A watcher already mid-check returns `null`
     * instead of running twice.
     */
    async runWatcher(target: number | Watcher): Promise<RunOutcome | null> {
        const watcher = typeof target === "number" ? await this.db.getWatcher(target) : target;

        if (!watcher) {
            return null;
        }

        if (this.inFlight.has(watcher.id)) {
            logger.debug({ id: watcher.id }, "monitor: check already in flight, skipping");

            return null;
        }

        this.inFlight.add(watcher.id);

        try {
            const result = await runCheck(watcher);
            // Feed items live in their own table; the check row keeps only the count.
            const { meta, ...rest } = result;
            const storedMeta =
                watcher.kind === "rss" && meta
                    ? { feedTitle: meta.feedTitle, itemCount: feedItemsFromMeta(meta).length }
                    : meta;
            const check = await this.db.recordCheck(watcher.id, { ...rest, meta: storedMeta });
            const updated = (await this.db.getWatcher(watcher.id)) ?? { ...watcher, lastStatus: result.status };
            logger.debug(
                { id: watcher.id, name: watcher.name, status: result.status, latencyMs: result.latencyMs },
                "monitor: check recorded"
            );
            this.emit({ type: "watcher:checked", watcher: updated, check });

            const transition = await this.applyTransition(updated, watcher.lastStatus, check);
            const newItems =
                watcher.kind === "rss" ? await this.deliverFeedItems(updated, feedItemsFromMeta(meta)) : [];

            return { watcher: updated, check, transition, newItems };
        } finally {
            this.inFlight.delete(watcher.id);
        }
    }

    private async applyTransition(
        watcher: Watcher,
        from: WatcherStatus,
        check: CheckRecord
    ): Promise<RunOutcome["transition"]> {
        const to = check.status;

        if (to === from) {
            return null;
        }

        let incident: Incident | null = null;
        const open = await this.db.openIncident(watcher.id);

        if (isOutage(to)) {
            if (open) {
                if (open.status !== to || open.detail !== check.detail) {
                    await this.db.updateIncident(open.id, { status: to, detail: check.detail });
                }

                incident = { ...open, status: to, detail: check.detail };
            } else {
                incident = await this.db.startIncident(watcher.id, to, check.detail);
            }
        } else if (to === "up" && open) {
            // "unknown" (status page unreachable, account missing) is not a
            // recovery: the incident stays open until a real "up" lands.
            incident = await this.db.closeIncident(open.id);
        }

        logger.info({ id: watcher.id, name: watcher.name, from, to, detail: check.detail }, "monitor: state changed");
        this.emit({ type: "watcher:state", watcher, from, to, incident });

        const worthNotifying = isOutage(to) || (to === "up" && isOutage(from));

        if (watcher.notify && worthNotifying) {
            void this.notifyTransition(watcher, from, to, check.detail);
        }

        return { from, to, incident };
    }

    private async deliverFeedItems(watcher: Watcher, items: ParsedFeedItem[]): Promise<FeedItem[]> {
        if (items.length === 0) {
            return [];
        }

        const { fresh, first } = await this.db.ingestFeedItems(watcher.id, items);
        await this.db.pruneFeedItems(watcher.id);

        if (first) {
            logger.info({ id: watcher.id, items: items.length }, "monitor: feed primed, history not delivered");
        }

        if (fresh.length === 0) {
            return [];
        }

        logger.info({ id: watcher.id, name: watcher.name, fresh: fresh.length }, "monitor: new feed items");
        this.emit({ type: "feed:items", watcher, items: fresh });

        if (watcher.notify && watcher.config.deliverItems !== false) {
            for (const item of fresh) {
                await this.send(watcher, {
                    app: NOTIFY_APP,
                    title: `${watcher.name}: ${item.title}`.slice(0, 120),
                    subtitle: "new item",
                    message: item.summary?.slice(0, 240) || item.title,
                    open: item.link ?? undefined,
                    group: `monitor-feed-${watcher.id}`,
                });
            }

            await this.db.markFeedItemsDelivered(fresh.map((item) => item.id));
        }

        return fresh.map((item) => ({ ...item, delivered: watcher.notify && watcher.config.deliverItems !== false }));
    }

    private async notifyTransition(
        watcher: Watcher,
        from: WatcherStatus,
        to: WatcherStatus,
        detail: string
    ): Promise<void> {
        const meta = await getMonitorNotifyMeta();

        if (to === "degraded" && !meta.onDegraded) {
            logger.debug({ id: watcher.id }, "monitor: degraded notification muted by settings");

            return;
        }

        if (to === "up" && !meta.onRecover) {
            logger.debug({ id: watcher.id }, "monitor: recovery notification muted by settings");

            return;
        }

        await this.send(watcher, {
            app: NOTIFY_APP,
            title: to === "up" ? `${watcher.name} recovered` : `${watcher.name} is ${to}`,
            subtitle: `${from} → ${to}`,
            message: detail,
            group: `monitor-${watcher.id}`,
        });
    }

    /**
     * Routes one event: through the watcher's library targets when it has any,
     * otherwise through the monitor app defaults of the shared notify config.
     */
    private async send(watcher: Watcher, event: NotificationEvent): Promise<void> {
        try {
            if (watcher.targetIds.length > 0) {
                const targets = await this.db.getTargets(watcher.targetIds);
                await dispatchToTargets(targets, event);

                return;
            }

            await dispatchNotification(event);
        } catch (error) {
            logger.warn({ error, id: watcher.id }, "monitor: notification dispatch failed");
        }
    }
}
