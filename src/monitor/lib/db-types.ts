import type { Generated, Selectable } from "kysely";

export interface WatchersTable {
    id: Generated<number>;
    name: string;
    kind: string;
    target: string;
    config_json: string;
    interval_sec: number;
    timeout_ms: number;
    enabled: number;
    notify: number;
    created_at: string;
    updated_at: string;
    last_status: string;
    last_checked_at: string | null;
    last_latency_ms: number | null;
    last_detail: string | null;
}

export interface ChecksTable {
    id: Generated<number>;
    watcher_id: number;
    checked_at: string;
    status: string;
    latency_ms: number | null;
    http_status: number | null;
    detail: string;
    meta_json: string | null;
}

export interface IncidentsTable {
    id: Generated<number>;
    watcher_id: number;
    status: string;
    started_at: string;
    ended_at: string | null;
    detail: string;
}

export interface NotifyTargetsTable {
    id: Generated<number>;
    name: string;
    channel: string;
    config_json: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

export interface WatcherTargetsTable {
    watcher_id: number;
    target_id: number;
}

export interface FeedItemsTable {
    id: Generated<number>;
    watcher_id: number;
    guid: string;
    title: string;
    link: string | null;
    summary: string | null;
    published_at: string | null;
    seen_at: string;
    delivered: number;
}

export interface MonitorDB {
    watchers: WatchersTable;
    checks: ChecksTable;
    incidents: IncidentsTable;
    notify_targets: NotifyTargetsTable;
    watcher_targets: WatcherTargetsTable;
    feed_items: FeedItemsTable;
}

export type FeedItemRow = Selectable<FeedItemsTable>;

export type WatcherRow = Selectable<WatchersTable>;
export type CheckRow = Selectable<ChecksTable>;
export type IncidentRow = Selectable<IncidentsTable>;
export type NotifyTargetRow = Selectable<NotifyTargetsTable>;
