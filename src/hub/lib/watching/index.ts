import type {
    WatchingDto,
    WatchMuteInput,
    WatchMuteReceiptDto,
    WatchRowDto,
    WatchSourceDto,
    WatchSourceId,
    WatchStateDto,
} from "@app/dev-dashboard/contract/watching";
import { logger } from "@genesiscz/utils/logger";

/**
 * The Watching screen (F30): every watch on the Mac in one list. Each source is one entry of `WATCH_SOURCES`, so a
 * new source is one reader here and nothing else. Monitor carries the polled sources that print item lines (Alza
 * watchdogs, a domains watch run as a command watcher, M12), so their newest item is the row's last change, and its
 * mute is the only one the Mac can set; the other sources keep their own alert rules and have no mute.
 */

export interface WatchSourceRead {
    rows: WatchRowDto[];
    note: string | null;
}

export interface WatchSource {
    label: string;
    read(): Promise<WatchSourceRead>;
    /** Silences one row until `until` (null lifts it); absent when the source has no mute. */
    mute?: (id: string, until: Date | null) => Promise<string | null>;
}

/** A source that is slow or broken must not hold the screen; it answers with a note instead. */
const SOURCE_TIMEOUT_MS = 8_000;

function iso(value: string | null | undefined): string | null {
    return value ? value : null;
}

const monitorSource: WatchSource = {
    label: "Monitor",
    async read() {
        const { Monitor } = await import("@app/monitor/lib/monitor");
        const { carriesItems, isMuted } = await import("@app/monitor/lib/types");
        const monitor = new Monitor();

        try {
            const overview = await monitor.overview();
            const rows = await Promise.all(
                overview.watchers.map(async (watcher): Promise<WatchRowDto> => {
                    const [newest] = carriesItems(watcher) ? await monitor.db.listFeedItems(watcher.id, 1) : [];
                    const state: WatchStateDto = !watcher.enabled
                        ? "paused"
                        : watcher.lastStatus === "up"
                          ? "ok"
                          : watcher.lastStatus === "degraded"
                            ? "alert"
                            : watcher.lastStatus;
                    return {
                        source: "monitor",
                        id: String(watcher.id),
                        title: watcher.name,
                        state,
                        detail: newest?.title ?? watcher.lastDetail ?? "",
                        changedAt: iso(newest?.seenAt ?? watcher.openIncident?.startedAt ?? watcher.lastCheckedAt),
                        link: newest?.link ?? null,
                        mutedUntil: isMuted(watcher) ? watcher.mutedUntil : null,
                        canMute: true,
                    };
                })
            );
            return { rows, note: rows.length === 0 ? "No Monitor watchers yet (tools monitor add)." : null };
        } finally {
            await monitor.close();
        }
    },
    async mute(id, until) {
        const { Monitor } = await import("@app/monitor/lib/monitor");
        const monitor = new Monitor();

        try {
            const updated = await monitor.updateWatcher(Number(id), { mutedUntil: until ? until.toISOString() : null });
            return updated ? (updated.mutedUntil ?? null) : null;
        } finally {
            await monitor.close();
        }
    },
};

const domainsSource: WatchSource = {
    label: "Domains",
    async read() {
        const { listWatch } = await import("@app/domains/lib/watch");
        const entries = await listWatch();
        const now = Date.now();
        const rows = entries.map((entry): WatchRowDto => {
            const days = entry.expiresAt ? Math.floor((Date.parse(entry.expiresAt) - now) / 86_400_000) : null;
            const state: WatchStateDto =
                entry.lastStatus === "available" || (days !== null && days <= 45)
                    ? "alert"
                    : entry.lastStatus
                      ? "ok"
                      : "unknown";
            const parts = [
                entry.lastStatus ?? "not checked yet",
                days === null ? null : days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`,
                entry.price === undefined ? null : `price ${entry.price}`,
            ];
            return {
                source: "domains",
                id: entry.domain,
                title: entry.domain,
                state,
                detail: parts.filter(Boolean).join(" · "),
                changedAt: iso(entry.observedAt ?? entry.lastCheckedAt),
                link: `https://${entry.domain}`,
                mutedUntil: null,
                canMute: false,
            };
        });
        return { rows, note: rows.length === 0 ? "No watched names (tools domains watch add)." : null };
    },
};

/** The shops tool keeps one local user. */
const SHOPS_LOCAL_USER = 1;

const shopsSource: WatchSource = {
    label: "Shops",
    async read() {
        const { getWatchlist } = await import("@app/shops/lib/watchlist-api");
        const favorites = await getWatchlist(SHOPS_LOCAL_USER);
        const rows = favorites.map((favorite): WatchRowDto => {
            const underTarget =
                favorite.target_price !== null &&
                favorite.best_price !== null &&
                favorite.best_price <= favorite.target_price;
            const parts = [
                favorite.best_price === null
                    ? "no price yet"
                    : `${favorite.best_price.toFixed(2)} at ${favorite.best_shop ?? "?"}`,
                favorite.target_price === null ? null : `target ${favorite.target_price.toFixed(2)}`,
                favorite.delta_percent === null ? null : `${(favorite.delta_percent * 100).toFixed(1)}%`,
                favorite.best_in_stock === 0 ? "out of stock" : null,
            ];
            return {
                source: "shops",
                id: String(favorite.id),
                title: favorite.label ?? `favorite ${favorite.id}`,
                state: underTarget ? "alert" : favorite.best_price === null ? "unknown" : "ok",
                detail: parts.filter(Boolean).join(" · "),
                changedAt: iso(favorite.best_observed_at ?? favorite.last_observed_at),
                link: null,
                mutedUntil: null,
                canMute: false,
            };
        });
        return { rows, note: rows.length === 0 ? "No watched products (tools shops watch add)." : null };
    },
};

const tradingviewSource: WatchSource = {
    label: "TradingView",
    async read() {
        const { resolveSession } = await import("@app/tradingview/lib/auth");
        const { listAlerts } = await import("@app/tradingview/lib/alerts-rest");
        const session = await resolveSession();

        if (!session) {
            return { rows: [], note: "Signed out of TradingView (tools tradingview login)." };
        }

        const alerts = await listAlerts(session);
        const rows = alerts.map(
            (alert): WatchRowDto => ({
                source: "tradingview",
                id: String(alert.alert_id),
                title: alert.name ?? `${alert.symbol} alert`,
                state: !alert.active ? "paused" : alert.last_error ? "down" : alert.last_fire_time ? "alert" : "ok",
                detail: alert.last_error ?? alert.message ?? alert.symbol,
                changedAt: iso(alert.last_fire_time ?? alert.create_time),
                link: `https://www.tradingview.com/symbols/${encodeURIComponent(alert.symbol.replace(":", "-"))}/`,
                mutedUntil: null,
                canMute: false,
            })
        );
        return { rows, note: rows.length === 0 ? "No TradingView alerts." : null };
    },
};

const hotelsSource: WatchSource = {
    label: "Hotels",
    // The hotels tool lives on a local-only branch, so this branch cannot import it; its saved searches join here
    // once it lands.
    read: async () => ({ rows: [], note: "Saved hotel searches live on a local-only branch." }),
};

export const WATCH_SOURCES = {
    monitor: monitorSource,
    domains: domainsSource,
    shops: shopsSource,
    tradingview: tradingviewSource,
    hotels: hotelsSource,
} satisfies Record<WatchSourceId, WatchSource>;

/** The source ids, for an input check (the route's zod enum, the CLI argument). */
export const WATCH_SOURCE_IDS = [
    "monitor",
    "domains",
    "shops",
    "tradingview",
    "hotels",
] as const satisfies readonly WatchSourceId[];

const STATE_ORDER: Readonly<Record<WatchStateDto, number>> = { down: 0, alert: 1, unknown: 2, ok: 3, paused: 4 };

async function readSource(id: WatchSourceId, source: WatchSource): Promise<WatchSourceRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            source.read(),
            new Promise<WatchSourceRead>((resolve) => {
                timer = setTimeout(() => resolve({ rows: [], note: "Did not answer in time." }), SOURCE_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        logger.warn({ error, source: id }, "watching: a source could not be read");
        return { rows: [], note: `Could not read: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
        clearTimeout(timer);
    }
}

export async function watching(
    sources: Readonly<Record<WatchSourceId, WatchSource>> = WATCH_SOURCES
): Promise<WatchingDto> {
    const ids = Object.keys(sources) as WatchSourceId[];
    const reads = await Promise.all(ids.map((id) => readSource(id, sources[id])));
    const summary: WatchSourceDto[] = ids.map((id, index) => ({
        id,
        label: sources[id].label,
        count: reads[index].rows.length,
        note: reads[index].note,
    }));
    const rows = reads
        .flatMap((read) => read.rows)
        .sort(
            (a, b) =>
                STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.changedAt ?? "").localeCompare(a.changedAt ?? "")
        );
    return { generatedAt: new Date().toISOString(), sources: summary, rows };
}

export async function muteWatch(
    input: WatchMuteInput,
    sources: Readonly<Record<WatchSourceId, WatchSource>> = WATCH_SOURCES
): Promise<WatchMuteReceiptDto> {
    const mute = sources[input.source].mute;

    if (!mute) {
        return {
            ...input,
            muted: false,
            mutedUntil: null,
            detail: `${sources[input.source].label} has no mute on the Mac.`,
        };
    }

    const until = input.minutes > 0 ? new Date(Date.now() + input.minutes * 60_000) : null;
    const mutedUntil = await mute(input.id, until);
    logger.info({ source: input.source, id: input.id, mutedUntil }, "watching: mute set");
    return {
        source: input.source,
        id: input.id,
        muted: mutedUntil !== null,
        mutedUntil,
        detail: mutedUntil ? `Muted until ${mutedUntil}.` : "Not muted.",
    };
}
