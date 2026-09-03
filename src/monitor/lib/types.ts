export const WATCHER_KINDS = ["website", "statuspage", "ai-provider", "rss"] as const;
export type WatcherKind = (typeof WATCHER_KINDS)[number];

export const WATCHER_STATUSES = ["up", "degraded", "down", "unknown"] as const;
export type WatcherStatus = (typeof WATCHER_STATUSES)[number];

export type HttpMethod = "GET" | "HEAD" | "POST";

export interface WatcherConfig {
    /** website: request method. Default GET. */
    method?: HttpMethod;
    /** website: extra request headers. */
    headers?: Record<string, string>;
    /** website: HTTP status the target must answer with. Default: any 2xx/3xx. */
    expectStatus?: number;
    /** website: substring the response body must contain. */
    expectBody?: string;
    /** website + ai-provider: latency above this is reported as degraded. */
    degradedAboveMs?: number;
    /** statuspage: only components whose name contains one of these matter. Empty = all. */
    components?: string[];
    /** rss: deliver every new item through the watcher's notification targets. Default true. */
    deliverItems?: boolean;
    /** rss: only items whose title or summary contains one of these (case-insensitive). Empty = all. */
    itemFilter?: string[];
}

export interface FeedItem {
    id: number;
    watcherId: number;
    guid: string;
    title: string;
    link: string | null;
    summary: string | null;
    publishedAt: string | null;
    seenAt: string;
    delivered: boolean;
}

export interface ParsedFeedItem {
    guid: string;
    title: string;
    link: string | null;
    summary: string | null;
    publishedAt: string | null;
}

export interface Watcher {
    id: number;
    name: string;
    kind: WatcherKind;
    /** website/statuspage: URL. ai-provider: account id (`acc_…`). */
    target: string;
    config: WatcherConfig;
    intervalSec: number;
    timeoutMs: number;
    enabled: boolean;
    notify: boolean;
    createdAt: string;
    updatedAt: string;
    lastStatus: WatcherStatus;
    lastCheckedAt: string | null;
    lastLatencyMs: number | null;
    lastDetail: string | null;
    /** Notification targets from the library. Empty = the monitor app defaults. */
    targetIds: number[];
}

export interface WatcherInput {
    name: string;
    kind: WatcherKind;
    target: string;
    config?: WatcherConfig;
    intervalSec?: number;
    timeoutMs?: number;
    enabled?: boolean;
    notify?: boolean;
    targetIds?: number[];
}

export const NOTIFY_CHANNELS = ["system", "say", "telegram", "webhook"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** One named destination in the notification library, e.g. "Slack #ops" or "Samantha, loud". */
export interface NotifyTarget {
    id: number;
    name: string;
    channel: NotifyChannel;
    config: Record<string, string | boolean>;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    /** Watchers subscribed to this target. */
    watcherCount: number;
}

export interface NotifyTargetInput {
    name: string;
    channel: NotifyChannel;
    config?: Record<string, string | boolean>;
    enabled?: boolean;
}

export type NotifyTargetPatch = Partial<NotifyTargetInput>;

export function isNotifyChannel(value: unknown): value is NotifyChannel {
    return typeof value === "string" && (NOTIFY_CHANNELS as readonly string[]).includes(value);
}

export type WatcherPatch = Partial<WatcherInput>;

export interface CheckResult {
    status: WatcherStatus;
    latencyMs: number | null;
    httpStatus: number | null;
    detail: string;
    meta?: Record<string, unknown>;
}

export interface CheckRecord extends CheckResult {
    id: number;
    watcherId: number;
    checkedAt: string;
}

export type IncidentStatus = "degraded" | "down";

export interface Incident {
    id: number;
    watcherId: number;
    status: IncidentStatus;
    startedAt: string;
    endedAt: string | null;
    detail: string;
}

export interface IncidentWithWatcher extends Incident {
    watcherName: string;
    watcherKind: WatcherKind;
}

export interface RecentPoint {
    t: string;
    status: WatcherStatus;
    latencyMs: number | null;
}

export interface WatcherSummary extends Watcher {
    /** Share of checks in the last 24h that were not `down`; null without checks. */
    uptime24h: number | null;
    avgLatency24h: number | null;
    checks24h: number;
    /** Oldest first. */
    recent: RecentPoint[];
    openIncident: Incident | null;
}

export interface OverviewCounts {
    total: number;
    up: number;
    degraded: number;
    down: number;
    unknown: number;
    paused: number;
}

export interface Overview {
    counts: OverviewCounts;
    watchers: WatcherSummary[];
    openIncidents: IncidentWithWatcher[];
}

export interface WatcherPreset {
    id: string;
    name: string;
    kind: WatcherKind;
    target: string;
    description: string;
    config?: WatcherConfig;
    intervalSec?: number;
}

export interface AiAccountOption {
    id: string;
    name: string;
    provider: string;
    enabled: boolean;
    hasHealth: boolean;
}

export type MonitorEvent =
    | { type: "hello"; protocolVersion: 1 }
    | { type: "pong" }
    | { type: "watcher:created"; watcher: Watcher }
    | { type: "watcher:updated"; watcher: Watcher }
    | { type: "watcher:deleted"; watcherId: number }
    | { type: "watcher:checked"; watcher: Watcher; check: CheckRecord }
    | { type: "feed:items"; watcher: Watcher; items: FeedItem[] }
    | {
          type: "watcher:state";
          watcher: Watcher;
          from: WatcherStatus;
          to: WatcherStatus;
          incident: Incident | null;
      };

export const DEFAULT_INTERVAL_SEC = 60;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_INTERVAL_SEC = 10;
export const MAX_INTERVAL_SEC = 24 * 60 * 60;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

export function isWatcherKind(value: unknown): value is WatcherKind {
    return typeof value === "string" && (WATCHER_KINDS as readonly string[]).includes(value);
}

export function isWatcherStatus(value: unknown): value is WatcherStatus {
    return typeof value === "string" && (WATCHER_STATUSES as readonly string[]).includes(value);
}
