import { join } from "node:path";
import { createKyselyClient, type DatabaseClient, nowUtcIso } from "@genesiscz/utils/database";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CheckRow, FeedItemRow, IncidentRow, MonitorDB, NotifyTargetRow, WatcherRow } from "./db-types";
import {
    type CheckRecord,
    type CheckResult,
    type FeedItem,
    type Incident,
    type IncidentStatus,
    type IncidentWithWatcher,
    isNotifyChannel,
    isWatcherKind,
    isWatcherStatus,
    type NotifyTarget,
    type NotifyTargetInput,
    type NotifyTargetPatch,
    type ParsedFeedItem,
    type RecentPoint,
    type Watcher,
    type WatcherConfig,
    type WatcherInput,
    type WatcherKind,
    type WatcherPatch,
    type WatcherStatus,
    type WatcherSummary,
} from "./types";

// Root via `env.tools.getHome()` so the test sandbox's GENESIS_TOOLS_HOME is
// honoured and no test ever writes the real watcher list.
export const MONITOR_DIR = join(env.tools.getHome(), ".genesis-tools", "monitor");
export const DEFAULT_DB_PATH = join(MONITOR_DIR, "monitor.db");

const RECENT_POINTS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

const BOOTSTRAP: string[] = [
    `CREATE TABLE IF NOT EXISTS watchers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        target          TEXT NOT NULL,
        config_json     TEXT NOT NULL DEFAULT '{}',
        interval_sec    INTEGER NOT NULL,
        timeout_ms      INTEGER NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        notify          INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_status     TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at TEXT,
        last_latency_ms INTEGER,
        last_detail     TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        watcher_id  INTEGER NOT NULL,
        checked_at  TEXT NOT NULL,
        status      TEXT NOT NULL,
        latency_ms  INTEGER,
        http_status INTEGER,
        detail      TEXT NOT NULL DEFAULT '',
        meta_json   TEXT,
        FOREIGN KEY (watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        watcher_id  INTEGER NOT NULL,
        status      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        detail      TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS notify_targets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        channel     TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS watcher_targets (
        watcher_id INTEGER NOT NULL,
        target_id  INTEGER NOT NULL,
        PRIMARY KEY (watcher_id, target_id),
        FOREIGN KEY (watcher_id) REFERENCES watchers(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES notify_targets(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS feed_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        watcher_id   INTEGER NOT NULL,
        guid         TEXT NOT NULL,
        title        TEXT NOT NULL,
        link         TEXT,
        summary      TEXT,
        published_at TEXT,
        seen_at      TEXT NOT NULL,
        delivered    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (watcher_id, guid),
        FOREIGN KEY (watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_items_watcher ON feed_items(watcher_id, seen_at)`,
    `CREATE INDEX IF NOT EXISTS idx_checks_watcher_time ON checks(watcher_id, checked_at)`,
    `CREATE INDEX IF NOT EXISTS idx_incidents_watcher ON incidents(watcher_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(ended_at) WHERE ended_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_watcher_targets_target ON watcher_targets(target_id)`,
];

function parseObject(json: string | null, what: string): Record<string, unknown> {
    if (!json) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(json, { strict: true });

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch (error) {
        logger.warn({ error, json, what }, "monitor: unreadable JSON column, using defaults");
    }

    return {};
}

function toKind(value: string): WatcherKind {
    return isWatcherKind(value) ? value : "website";
}

function toStatus(value: string): WatcherStatus {
    return isWatcherStatus(value) ? value : "unknown";
}

export function rowToWatcher(row: WatcherRow, targetIds: number[] = []): Watcher {
    return {
        id: row.id,
        name: row.name,
        kind: toKind(row.kind),
        target: row.target,
        config: parseObject(row.config_json, "watcher config") as WatcherConfig,
        intervalSec: row.interval_sec,
        timeoutMs: row.timeout_ms,
        enabled: row.enabled === 1,
        notify: row.notify === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastStatus: toStatus(row.last_status),
        lastCheckedAt: row.last_checked_at,
        lastLatencyMs: row.last_latency_ms,
        lastDetail: row.last_detail,
        targetIds,
    };
}

export function rowToCheck(row: CheckRow): CheckRecord {
    const meta = row.meta_json ? parseObject(row.meta_json, "check meta") : undefined;

    return {
        id: row.id,
        watcherId: row.watcher_id,
        checkedAt: row.checked_at,
        status: toStatus(row.status),
        latencyMs: row.latency_ms,
        httpStatus: row.http_status,
        detail: row.detail,
        meta: meta && Object.keys(meta).length > 0 ? meta : undefined,
    };
}

export function rowToIncident(row: IncidentRow): Incident {
    return {
        id: row.id,
        watcherId: row.watcher_id,
        status: row.status === "degraded" ? "degraded" : "down",
        startedAt: row.started_at,
        endedAt: row.ended_at,
        detail: row.detail,
    };
}

function rowToTarget(row: NotifyTargetRow, watcherCount = 0): NotifyTarget {
    const config: Record<string, string | boolean> = {};

    for (const [key, value] of Object.entries(parseObject(row.config_json, "target config"))) {
        if (typeof value === "string" || typeof value === "boolean") {
            config[key] = value;
        }
    }

    return {
        id: row.id,
        name: row.name,
        channel: isNotifyChannel(row.channel) ? row.channel : "system",
        config,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        watcherCount,
    };
}

function rowToFeedItem(row: FeedItemRow): FeedItem {
    return {
        id: row.id,
        watcherId: row.watcher_id,
        guid: row.guid,
        title: row.title,
        link: row.link,
        summary: row.summary,
        publishedAt: row.published_at,
        seenAt: row.seen_at,
        delivered: row.delivered === 1,
    };
}

export class MonitorDatabase {
    private readonly client: DatabaseClient<MonitorDB>;

    constructor(dbPath: string = DEFAULT_DB_PATH) {
        this.client = createKyselyClient<MonitorDB>({
            path: dbPath,
            bootstrap: BOOTSTRAP,
            pragmas: { foreignKeys: true },
        });
        logger.debug({ dbPath }, "monitor: database opened");
    }

    get path(): string {
        return this.client.path;
    }

    close(): void {
        this.client.close();
    }

    // ---------------------------------------------------------------- watchers

    private async targetIdsByWatcher(watcherIds?: number[]): Promise<Map<number, number[]>> {
        let query = this.client.kysely.selectFrom("watcher_targets").selectAll();

        if (watcherIds) {
            if (watcherIds.length === 0) {
                return new Map();
            }

            query = query.where("watcher_id", "in", watcherIds);
        }

        const rows = await query.orderBy("target_id").execute();
        const map = new Map<number, number[]>();

        for (const row of rows) {
            const list = map.get(row.watcher_id) ?? [];
            list.push(row.target_id);
            map.set(row.watcher_id, list);
        }

        return map;
    }

    async listWatchers(opts: { enabledOnly?: boolean } = {}): Promise<Watcher[]> {
        let query = this.client.kysely.selectFrom("watchers").selectAll();

        if (opts.enabledOnly) {
            query = query.where("enabled", "=", 1);
        }

        const rows = await query.orderBy("id").execute();
        const targets = await this.targetIdsByWatcher();

        return rows.map((row) => rowToWatcher(row, targets.get(row.id) ?? []));
    }

    async getWatcher(id: number): Promise<Watcher | null> {
        const row = await this.client.kysely.selectFrom("watchers").selectAll().where("id", "=", id).executeTakeFirst();

        if (!row) {
            return null;
        }

        const targets = await this.targetIdsByWatcher([id]);

        return rowToWatcher(row, targets.get(id) ?? []);
    }

    private async setWatcherTargets(watcherId: number, targetIds: number[]): Promise<void> {
        await this.client.kysely.deleteFrom("watcher_targets").where("watcher_id", "=", watcherId).execute();
        const unique = [...new Set(targetIds)];

        if (unique.length === 0) {
            return;
        }

        const existing = await this.client.kysely
            .selectFrom("notify_targets")
            .select("id")
            .where("id", "in", unique)
            .execute();
        const known = new Set(existing.map((row) => row.id));
        const rows = unique.filter((id) => known.has(id)).map((target_id) => ({ watcher_id: watcherId, target_id }));

        if (rows.length === 0) {
            // Kysely renders `values([])` as `... VALUES ()`, which SQLite
            // rejects with a syntax error. Every requested id being unknown is
            // an ordinary outcome (the target was deleted), not a crash.
            logger.warn({ watcherId, targetIds: unique }, "monitor: no known notify target in the requested list");

            return;
        }

        await this.client.kysely.insertInto("watcher_targets").values(rows).execute();
    }

    async createWatcher(input: WatcherInput): Promise<Watcher> {
        const now = nowUtcIso();
        const result = await this.client.kysely
            .insertInto("watchers")
            .values({
                name: input.name,
                kind: input.kind,
                target: input.target,
                config_json: SafeJSON.stringify(input.config ?? {}),
                interval_sec: input.intervalSec ?? 60,
                timeout_ms: input.timeoutMs ?? 10_000,
                enabled: input.enabled === false ? 0 : 1,
                notify: input.notify === false ? 0 : 1,
                created_at: now,
                updated_at: now,
                last_status: "unknown",
            })
            .executeTakeFirstOrThrow();
        const id = Number(result.insertId);

        if (input.targetIds && input.targetIds.length > 0) {
            await this.setWatcherTargets(id, input.targetIds);
        }

        const watcher = await this.getWatcher(id);

        if (!watcher) {
            throw new Error(`monitor: watcher ${id} vanished after insert`);
        }

        logger.info({ id, name: input.name, kind: input.kind, target: input.target }, "monitor: watcher created");

        return watcher;
    }

    async updateWatcher(id: number, patch: WatcherPatch): Promise<Watcher | null> {
        const set: Partial<Omit<WatcherRow, "id">> = { updated_at: nowUtcIso() };

        if (patch.name !== undefined) {
            set.name = patch.name;
        }

        if (patch.kind !== undefined) {
            set.kind = patch.kind;
        }

        if (patch.target !== undefined) {
            set.target = patch.target;
        }

        if (patch.config !== undefined) {
            set.config_json = SafeJSON.stringify(patch.config);
        }

        if (patch.intervalSec !== undefined) {
            set.interval_sec = patch.intervalSec;
        }

        if (patch.timeoutMs !== undefined) {
            set.timeout_ms = patch.timeoutMs;
        }

        if (patch.enabled !== undefined) {
            set.enabled = patch.enabled ? 1 : 0;
        }

        if (patch.notify !== undefined) {
            set.notify = patch.notify ? 1 : 0;
        }

        await this.client.kysely.updateTable("watchers").set(set).where("id", "=", id).execute();

        if (patch.targetIds !== undefined) {
            await this.setWatcherTargets(id, patch.targetIds);
        }

        return this.getWatcher(id);
    }

    async deleteWatcher(id: number): Promise<boolean> {
        const result = await this.client.kysely.deleteFrom("watchers").where("id", "=", id).executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }

    // ---------------------------------------------------------- notify targets

    async listTargets(): Promise<NotifyTarget[]> {
        const rows = await this.client.kysely.selectFrom("notify_targets").selectAll().orderBy("id").execute();
        const counts = await this.client.kysely
            .selectFrom("watcher_targets")
            .select((eb) => ["target_id", eb.fn.countAll<number>().as("n")])
            .groupBy("target_id")
            .execute();
        const countById = new Map(counts.map((row) => [row.target_id, Number(row.n)]));

        return rows.map((row) => rowToTarget(row, countById.get(row.id) ?? 0));
    }

    async getTarget(id: number): Promise<NotifyTarget | null> {
        const row = await this.client.kysely
            .selectFrom("notify_targets")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

        if (!row) {
            return null;
        }

        const count = await this.client.kysely
            .selectFrom("watcher_targets")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("target_id", "=", id)
            .executeTakeFirst();

        return rowToTarget(row, Number(count?.n ?? 0));
    }

    async getTargets(ids: number[]): Promise<NotifyTarget[]> {
        if (ids.length === 0) {
            return [];
        }

        const rows = await this.client.kysely
            .selectFrom("notify_targets")
            .selectAll()
            .where("id", "in", ids)
            .orderBy("id")
            .execute();

        return rows.map((row) => rowToTarget(row));
    }

    async createTarget(input: NotifyTargetInput): Promise<NotifyTarget> {
        const now = nowUtcIso();
        const result = await this.client.kysely
            .insertInto("notify_targets")
            .values({
                name: input.name,
                channel: input.channel,
                config_json: SafeJSON.stringify(input.config ?? {}),
                enabled: input.enabled === false ? 0 : 1,
                created_at: now,
                updated_at: now,
            })
            .executeTakeFirstOrThrow();
        const target = await this.getTarget(Number(result.insertId));

        if (!target) {
            throw new Error("monitor: notify target vanished after insert");
        }

        logger.info({ id: target.id, name: target.name, channel: target.channel }, "monitor: notify target created");

        return target;
    }

    async updateTarget(id: number, patch: NotifyTargetPatch): Promise<NotifyTarget | null> {
        const set: Partial<Omit<NotifyTargetRow, "id">> = { updated_at: nowUtcIso() };

        if (patch.name !== undefined) {
            set.name = patch.name;
        }

        if (patch.channel !== undefined) {
            set.channel = patch.channel;
        }

        if (patch.config !== undefined) {
            set.config_json = SafeJSON.stringify(patch.config);
        }

        if (patch.enabled !== undefined) {
            set.enabled = patch.enabled ? 1 : 0;
        }

        await this.client.kysely.updateTable("notify_targets").set(set).where("id", "=", id).execute();

        return this.getTarget(id);
    }

    async deleteTarget(id: number): Promise<boolean> {
        const result = await this.client.kysely.deleteFrom("notify_targets").where("id", "=", id).executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }

    // -------------------------------------------------------------- feed items

    /**
     * Stores items the feed did not have before and returns them, oldest
     * first, so they can be delivered in reading order. The first sync of a
     * watcher marks everything delivered: a new subscription must not replay
     * a year of history through the notification targets.
     */
    async ingestFeedItems(watcherId: number, items: ParsedFeedItem[]): Promise<{ fresh: FeedItem[]; first: boolean }> {
        const existing = await this.client.kysely
            .selectFrom("feed_items")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("watcher_id", "=", watcherId)
            .executeTakeFirst();
        // "First sync" is the watcher's FIRST check, not merely "no rows yet".
        // A check whose `itemFilter` matched nothing stores no row, so the row
        // count alone would prime again days later and swallow the first item
        // the filter ever matched: the one item it existed to catch. The caller
        // records its check row before it ingests, so the count is 1 here on
        // that first run.
        const checked = await this.client.kysely
            .selectFrom("checks")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("watcher_id", "=", watcherId)
            .executeTakeFirst();
        const first = Number(existing?.n ?? 0) === 0 && Number(checked?.n ?? 0) <= 1;
        const seenAt = nowUtcIso();
        const fresh: FeedItem[] = [];

        for (const item of [...items].reverse()) {
            const inserted = await this.client.kysely
                .insertInto("feed_items")
                .values({
                    watcher_id: watcherId,
                    guid: item.guid,
                    title: item.title,
                    link: item.link,
                    summary: item.summary,
                    published_at: item.publishedAt,
                    seen_at: seenAt,
                    delivered: first ? 1 : 0,
                })
                .onConflict((oc) => oc.columns(["watcher_id", "guid"]).doNothing())
                .executeTakeFirst();

            if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0 && !first) {
                fresh.push({
                    id: Number(inserted.insertId),
                    watcherId,
                    guid: item.guid,
                    title: item.title,
                    link: item.link,
                    summary: item.summary,
                    publishedAt: item.publishedAt,
                    seenAt,
                    delivered: false,
                });
            }
        }

        return { fresh, first };
    }

    /** Items a previous check could not deliver, oldest first, minus the ones the caller already holds. */
    async listUndeliveredFeedItems(watcherId: number, excludeIds: number[] = [], limit = 20): Promise<FeedItem[]> {
        let query = this.client.kysely
            .selectFrom("feed_items")
            .selectAll()
            .where("watcher_id", "=", watcherId)
            .where("delivered", "=", 0);

        if (excludeIds.length > 0) {
            query = query.where("id", "not in", excludeIds);
        }

        const rows = await query.orderBy("id").limit(limit).execute();

        return rows.map(rowToFeedItem);
    }

    async markFeedItemsDelivered(ids: number[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        await this.client.kysely.updateTable("feed_items").set({ delivered: 1 }).where("id", "in", ids).execute();
    }

    async listFeedItems(watcherId: number, limit = 50): Promise<FeedItem[]> {
        const rows = await this.client.kysely
            .selectFrom("feed_items")
            .selectAll()
            .where("watcher_id", "=", watcherId)
            .orderBy("published_at", "desc")
            .orderBy("id", "desc")
            .limit(Math.min(limit, 500))
            .execute();

        return rows.map(rowToFeedItem);
    }

    async pruneFeedItems(watcherId: number, keep = 500): Promise<void> {
        const rows = await this.client.kysely
            .selectFrom("feed_items")
            .select("id")
            .where("watcher_id", "=", watcherId)
            .orderBy("id", "desc")
            .offset(keep)
            .limit(10_000)
            .execute();

        if (rows.length > 0) {
            await this.client.kysely
                .deleteFrom("feed_items")
                .where(
                    "id",
                    "in",
                    rows.map((row) => row.id)
                )
                .execute();
        }
    }

    // ------------------------------------------------------------------ checks

    async recordCheck(watcherId: number, result: CheckResult, checkedAt: string = nowUtcIso()): Promise<CheckRecord> {
        const inserted = await this.client.kysely
            .insertInto("checks")
            .values({
                watcher_id: watcherId,
                checked_at: checkedAt,
                status: result.status,
                latency_ms: result.latencyMs,
                http_status: result.httpStatus,
                detail: result.detail,
                meta_json: result.meta ? SafeJSON.stringify(result.meta) : null,
            })
            .executeTakeFirstOrThrow();

        await this.client.kysely
            .updateTable("watchers")
            .set({
                last_status: result.status,
                last_checked_at: checkedAt,
                last_latency_ms: result.latencyMs,
                last_detail: result.detail,
            })
            .where("id", "=", watcherId)
            .execute();

        return {
            id: Number(inserted.insertId),
            watcherId,
            checkedAt,
            ...result,
        };
    }

    async listChecks(watcherId: number, opts: { limit?: number; since?: string } = {}): Promise<CheckRecord[]> {
        let query = this.client.kysely.selectFrom("checks").selectAll().where("watcher_id", "=", watcherId);

        if (opts.since) {
            query = query.where("checked_at", ">=", opts.since);
        }

        const rows = await query
            .orderBy("checked_at", "desc")
            .limit(Math.min(opts.limit ?? 200, 5_000))
            .execute();

        return rows.map(rowToCheck);
    }

    async pruneChecks(olderThanDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
        const result = await this.client.kysely
            .deleteFrom("checks")
            .where("checked_at", "<", cutoff)
            .executeTakeFirst();
        const deleted = Number(result.numDeletedRows);

        if (deleted > 0) {
            logger.info({ deleted, olderThanDays }, "monitor: pruned old checks");
        }

        return deleted;
    }

    // --------------------------------------------------------------- incidents

    async openIncident(watcherId: number): Promise<Incident | null> {
        const row = await this.client.kysely
            .selectFrom("incidents")
            .selectAll()
            .where("watcher_id", "=", watcherId)
            .where("ended_at", "is", null)
            .orderBy("started_at", "desc")
            .executeTakeFirst();

        return row ? rowToIncident(row) : null;
    }

    async startIncident(watcherId: number, status: IncidentStatus, detail: string): Promise<Incident> {
        const startedAt = nowUtcIso();
        const inserted = await this.client.kysely
            .insertInto("incidents")
            .values({ watcher_id: watcherId, status, started_at: startedAt, detail })
            .executeTakeFirstOrThrow();

        return { id: Number(inserted.insertId), watcherId, status, startedAt, endedAt: null, detail };
    }

    async updateIncident(id: number, patch: { status?: IncidentStatus; detail?: string }): Promise<void> {
        await this.client.kysely.updateTable("incidents").set(patch).where("id", "=", id).execute();
    }

    async closeIncident(id: number): Promise<Incident | null> {
        await this.client.kysely
            .updateTable("incidents")
            .set({ ended_at: nowUtcIso() })
            .where("id", "=", id)
            .where("ended_at", "is", null)
            .execute();
        const row = await this.client.kysely
            .selectFrom("incidents")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

        return row ? rowToIncident(row) : null;
    }

    async listIncidents(
        opts: { watcherId?: number; openOnly?: boolean; limit?: number } = {}
    ): Promise<IncidentWithWatcher[]> {
        let query = this.client.kysely
            .selectFrom("incidents")
            .innerJoin("watchers", "watchers.id", "incidents.watcher_id")
            .select([
                "incidents.id as id",
                "incidents.watcher_id as watcher_id",
                "incidents.status as status",
                "incidents.started_at as started_at",
                "incidents.ended_at as ended_at",
                "incidents.detail as detail",
                "watchers.name as watcher_name",
                "watchers.kind as watcher_kind",
            ]);

        if (opts.watcherId !== undefined) {
            query = query.where("incidents.watcher_id", "=", opts.watcherId);
        }

        if (opts.openOnly) {
            query = query.where("incidents.ended_at", "is", null);
        }

        const rows = await query
            .orderBy("incidents.started_at", "desc")
            .limit(Math.min(opts.limit ?? 100, 1_000))
            .execute();

        return rows.map((row) => ({
            ...rowToIncident(row),
            watcherName: row.watcher_name,
            watcherKind: toKind(row.watcher_kind),
        }));
    }

    // --------------------------------------------------------------- summaries

    async summarize(watcher: Watcher): Promise<WatcherSummary> {
        const since = new Date(Date.now() - DAY_MS).toISOString();
        const stats = await this.client.kysely
            .selectFrom("checks")
            .select((eb) => [
                eb.fn.countAll<number>().as("total"),
                eb.fn.sum<number>(eb.case().when("status", "=", "down").then(1).else(0).end()).as("down"),
                eb.fn.avg<number>("latency_ms").as("avg_latency"),
            ])
            .where("watcher_id", "=", watcher.id)
            .where("checked_at", ">=", since)
            .executeTakeFirst();
        const recentRows = await this.client.kysely
            .selectFrom("checks")
            .select(["checked_at", "status", "latency_ms"])
            .where("watcher_id", "=", watcher.id)
            .orderBy("checked_at", "desc")
            .limit(RECENT_POINTS)
            .execute();
        const total = Number(stats?.total ?? 0);
        const down = Number(stats?.down ?? 0);
        const avg = stats?.avg_latency === null || stats?.avg_latency === undefined ? null : Number(stats.avg_latency);
        const recent: RecentPoint[] = recentRows
            .map((row) => ({ t: row.checked_at, status: toStatus(row.status), latencyMs: row.latency_ms }))
            .reverse();

        return {
            ...watcher,
            uptime24h: total > 0 ? (total - down) / total : null,
            avgLatency24h: avg === null ? null : Math.round(avg),
            checks24h: total,
            recent,
            openIncident: await this.openIncident(watcher.id),
        };
    }

    async summarizeAll(): Promise<WatcherSummary[]> {
        const watchers = await this.listWatchers();

        return Promise.all(watchers.map((watcher) => this.summarize(watcher)));
    }
}
