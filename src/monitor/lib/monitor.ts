import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification, type NotificationEvent } from "@genesiscz/utils/notifications";
import { runCheck } from "./checks/run-check";
import { MonitorDatabase } from "./db";
import { getMonitorNotifyMeta } from "./notify-settings";
import { dispatchToTarget, dispatchToTargets, NOTIFY_APP } from "./notify-targets";
import type {
    CheckRecord,
    CheckResult,
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
import { isMuted, maskWatcher, SECRET_KEYS } from "./types";
import { assertTargetConfigComplete } from "./validate";

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

    /**
     * Fan an event out to every listener. The watcher is masked HERE, not per
     * route: the event stream leaves this process over a WebSocket that no
     * route handler sees, and `config.headers` can hold an auth token.
     */
    private emit(event: MonitorEvent): void {
        const published: MonitorEvent = "watcher" in event ? { ...event, watcher: maskWatcher(event.watcher) } : event;

        for (const listener of this.listeners) {
            try {
                listener(published);
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

    async updateTarget(id: number, patch: NotifyTargetPatch): Promise<NotifyTarget | null> {
        return this.db.updateTarget(id, await this.preserveSecrets(id, patch));
    }

    /**
     * The HTTP API masks `botToken` out of every target it hands back, so an
     * editor that round-trips a target has no secret to send. Carry the stored
     * value forward instead of writing a config that lost it.
     */
    private async preserveSecrets(id: number, patch: NotifyTargetPatch): Promise<NotifyTargetPatch> {
        if (!patch.config) {
            return patch;
        }

        const current = await this.db.getTarget(id);

        if (!current || (patch.channel !== undefined && patch.channel !== current.channel)) {
            return patch;
        }

        const config = { ...patch.config };

        for (const key of SECRET_KEYS) {
            const stored = current.config[key];

            if (config[key] === undefined && typeof stored === "string" && stored.length > 0) {
                config[key] = stored;
            }
        }

        assertTargetConfigComplete(current.channel, config);

        return { ...patch, config };
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
            const result = await this.safeRunCheck(watcher);
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

    /**
     * A check that THROWS must still record a row. Without this the `finally`
     * in runWatcher clears the in-flight mark, `last_checked_at` never advances,
     * and the 1 s scheduler tick finds the same watcher due again forever.
     */
    private async safeRunCheck(watcher: Watcher): Promise<CheckResult> {
        try {
            return await runCheck(watcher);
        } catch (error) {
            logger.warn({ error, id: watcher.id, name: watcher.name }, "monitor: check threw, recording it as unknown");

            return {
                status: "unknown",
                latencyMs: null,
                httpStatus: null,
                detail: `check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
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

        if (watcher.notify && worthNotifying && isMuted(watcher)) {
            logger.info(
                { id: watcher.id, until: watcher.mutedUntil },
                "monitor: state change not announced, watcher is muted"
            );
        }

        if (watcher.notify && worthNotifying && !isMuted(watcher)) {
            // Detached on purpose (a slow telegram send must not hold the check
            // open), so it needs its own catch: the first await reads the notify
            // config, and a hand-broken config.json would otherwise take the
            // whole scheduler process down as an unhandled rejection.
            void this.notifyTransition(watcher, from, to, check.detail).catch((notifyError) => {
                logger.warn({ notifyError, id: watcher.id }, "monitor: transition notification failed");
            });
        }

        return { from, to, incident };
    }

    private async deliverFeedItems(watcher: Watcher, items: ParsedFeedItem[]): Promise<FeedItem[]> {
        // No early return on an empty list: ingest is what PRIMES the feed. Skip
        // it and the first item that ever passes an `--item-filter` is stored as
        // already-delivered and never notified, which is the one item the filter
        // existed to catch.
        const { fresh, first } = await this.db.ingestFeedItems(watcher.id, items);
        await this.db.pruneFeedItems(watcher.id);

        if (first) {
            logger.info({ id: watcher.id, items: items.length }, "monitor: feed primed, history not delivered");
        }

        if (fresh.length > 0) {
            logger.info({ id: watcher.id, name: watcher.name, fresh: fresh.length }, "monitor: new feed items");
            this.emit({ type: "feed:items", watcher, items: fresh });
        }

        const deliver = watcher.notify && watcher.config.deliverItems !== false;

        if (deliver && isMuted(watcher)) {
            // A muted feed swallows its items on purpose; replaying them after the
            // mute ends would dump the whole maintenance window on the user.
            await this.db.markFeedItemsDelivered(fresh.map((item) => item.id));
            logger.info({ id: watcher.id, items: fresh.length }, "monitor: feed items silenced, watcher is muted");

            return fresh.map((item) => ({ ...item, delivered: true }));
        }

        if (!deliver) {
            return fresh;
        }

        // Items whose notification failed last time are retried before the new
        // ones, so a dead webhook loses nothing once it is back.
        const retries = await this.db.listUndeliveredFeedItems(
            watcher.id,
            fresh.map((item) => item.id)
        );
        const delivered = new Set<number>();

        for (const item of [...retries, ...fresh]) {
            const sent = await this.send(watcher, {
                app: NOTIFY_APP,
                title: `${watcher.name}: ${item.title}`.slice(0, 120),
                subtitle: "new item",
                message: item.summary?.slice(0, 240) || item.title,
                open: item.link ?? undefined,
                group: `monitor-feed-${watcher.id}`,
            });

            if (sent) {
                delivered.add(item.id);
            }
        }

        await this.db.markFeedItemsDelivered([...delivered]);

        if (delivered.size < retries.length + fresh.length) {
            logger.warn(
                { id: watcher.id, failed: retries.length + fresh.length - delivered.size },
                "monitor: feed items not delivered, will retry on the next check"
            );
        }

        return fresh.map((item) => ({ ...item, delivered: delivered.has(item.id) }));
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
    private async send(watcher: Watcher, event: NotificationEvent): Promise<boolean> {
        try {
            if (watcher.targetIds.length > 0) {
                const targets = await this.db.getTargets(watcher.targetIds);

                return dispatchToTargets(targets, event);
            }

            await dispatchNotification(event);

            return true;
        } catch (error) {
            logger.warn({ error, id: watcher.id }, "monitor: notification dispatch failed");

            return false;
        }
    }
}
