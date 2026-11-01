import { concurrentMap } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { dedupeById, mergeTwins, normalizeAlert, normalizeJam } from "./alerts";
import { bboxCenter, geoEnvFor, splitBBox } from "./geo";
import type { WazeRequest, WazeTransport } from "./session";
import type { BBox, DepartureOption, Feed, FeedStats, LatLon, RouteAlternative, WazeAlert, WazeJam } from "./types";

const { log } = logger.scoped("waze-client");

/** One georss answer holds at most this many alerts (and, separately, jams). Measured 2026-11-01. */
export const GEORSS_ITEM_CAP = 200;
const DEFAULT_SPLIT_DEPTH = 3;
const DEFAULT_CONCURRENCY = 2;
/**
 * Most georss requests one feed may send. Waze refuses every token for a long while after a few hundred requests (see
 * the README), and that also blocks the user's own live map, so a huge area stops splitting and reports capped tiles.
 */
export const DEFAULT_MAX_REQUESTS = 60;
/**
 * The transport already mints a fresh token per five requests (Waze's per-token limit) and retries a 429 once with a new
 * token. This gentle spacing and the backoff below cover a real per-client limit, which was not hit on 2026-11-01.
 */
export const DEFAULT_MIN_INTERVAL_MS = 150;
/**
 * Backoff per refused status, after the transport's own one retry with a fresh token. 403 means reCAPTCHA refused every
 * token: on 2026-11-01, after about 150 requests in 15 minutes, every token in a fresh tab got 403 for a few minutes,
 * while a tab open for longer got through on its second token.
 */
const RETRY_DELAYS_MS: Record<number, number[]> = {
    403: [3_000, 8_000],
    429: [2_000, 5_000, 10_000, 20_000],
};
/** `lo;hi` corners (`lat,lng`) for a search without a centre. */
const WORLD_VIEWPORT = "-60,-179;75,179";

export type FeedType = "alerts" | "traffic";

const STATUS_HINTS: Record<number, string> = {
    403:
        "Waze refused the reCAPTCHA token. After many requests in a short time it refuses every token for a few " +
        "minutes; wait, then retry (--keep-tab reuses one tab, which recovers sooner than a fresh one)",
    429: "Waze rate-limited this tab; wait a minute and retry",
};

export class WazeHttpError extends Error {
    constructor(
        readonly status: number,
        readonly path: string,
        body: string
    ) {
        const detail =
            STATUS_HINTS[status] ??
            body
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200);
        super(`Waze answered HTTP ${status} for ${path.split("?")[0]}: ${detail}`);
    }
}

export interface WazeSuggestion {
    name: string;
    address?: string;
    venueId?: string;
    lat: number;
    lon: number;
}

export interface WazeVenue {
    id: string;
    name?: string;
    lat?: number;
    lon?: number;
    address?: Record<string, string>;
    phone?: string;
    url?: string;
    services: string[];
    hours: Array<{ day: number; from: string; to: string }>;
    categories: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function finite(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function latLngOf(value: unknown): LatLon | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const lat = finite(value.lat);
    const lon = finite(value.lng);
    return lat === undefined || lon === undefined ? undefined : { lat, lon };
}

function hhmm(value: unknown): string {
    if (!isRecord(value)) {
        return "";
    }

    const hours = finite(value.hours) ?? 0;
    const minutes = finite(value.minutes) ?? 0;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Typed Waze live-map endpoints over a transport. Every method throws WazeHttpError on a non-2xx answer. */
export class WazeClient {
    private nextSlot = 0;
    private readonly minIntervalMs: number;

    constructor(
        readonly transport: WazeTransport,
        opts: { minIntervalMs?: number } = {}
    ) {
        this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    }

    /** Waits for this request's slot: requests leave at least `minIntervalMs` apart, whatever the concurrency. */
    private async pace(): Promise<void> {
        const now = Date.now();
        const slot = Math.max(now, this.nextSlot);
        this.nextSlot = slot + this.minIntervalMs;
        if (slot > now) {
            await Bun.sleep(slot - now);
        }
    }

    private async json(req: WazeRequest): Promise<unknown> {
        for (let attempt = 0; ; attempt++) {
            await this.pace();
            const response = await this.transport.request(req);
            const delays = RETRY_DELAYS_MS[response.status];
            if (delays && attempt < delays.length) {
                const header = Number(response.retryAfter);
                const delay = Number.isFinite(header) && header > 0 ? header * 1000 : (delays[attempt] ?? 20_000);
                log.debug(
                    { path: req.path.split("?")[0], status: response.status, attempt, delay },
                    "waze refused the request, backing off"
                );
                // Everyone waits: the refusal is per client, so other queued requests would only be refused too.
                this.nextSlot = Math.max(this.nextSlot, Date.now() + delay);
                continue;
            }

            if (response.status < 200 || response.status >= 300) {
                throw new WazeHttpError(response.status, req.path, response.body);
            }

            return SafeJSON.parse(response.body, { strict: true });
        }
    }

    /** One georss call for a box. */
    async georss(
        box: BBox,
        types: FeedType[] = ["alerts", "traffic"]
    ): Promise<{ alerts: unknown[]; jams: unknown[] }> {
        const params = new URLSearchParams({
            top: box.top.toFixed(6),
            bottom: box.bottom.toFixed(6),
            left: box.left.toFixed(6),
            right: box.right.toFixed(6),
            env: geoEnvFor(bboxCenter(box)),
            types: types.join(","),
        });
        const data = await this.json({ path: `/live-map/api/georss?${params}` });
        if (!isRecord(data)) {
            throw new Error("georss answered something that is not an object");
        }

        return {
            alerts: Array.isArray(data.alerts) ? data.alerts : [],
            jams: Array.isArray(data.jams) ? data.jams : [],
        };
    }

    /**
     * Alerts and jams for a set of boxes. A box whose answer reaches the 200-item cap is split into four and asked
     * again, up to `maxDepth` times, because a capped answer is filled with road closures first and drops police
     * reports. Results are deduplicated by id.
     */
    async feed(opts: {
        boxes: BBox[];
        types?: FeedType[];
        maxDepth?: number;
        concurrency?: number;
        maxRequests?: number;
    }): Promise<Feed> {
        const types = opts.types ?? ["alerts", "traffic"];
        const maxDepth = opts.maxDepth ?? DEFAULT_SPLIT_DEPTH;
        const maxRequests = Math.max(opts.boxes.length, opts.maxRequests ?? DEFAULT_MAX_REQUESTS);
        const stats: FeedStats = { requests: 0, tiles: 0, capped: 0, failed: 0 };
        const alerts: WazeAlert[] = [];
        const jams: WazeJam[] = [];
        let firstError: unknown;
        let queue = opts.boxes.map((box) => ({ box, depth: 0 }));
        while (queue.length > 0) {
            const answers = await concurrentMap({
                items: queue,
                fn: (item) => this.georss(item.box, types),
                concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
                onError: (item, error) => {
                    firstError ??= error;
                    stats.failed++;
                    log.debug({ error, box: item.box, depth: item.depth }, "georss tile failed");
                },
            });
            stats.requests += queue.length;
            const nextQueue: typeof queue = [];
            for (const [item, answer] of answers) {
                const capped =
                    (types.includes("alerts") && answer.alerts.length >= GEORSS_ITEM_CAP) ||
                    (types.includes("traffic") && answer.jams.length >= GEORSS_ITEM_CAP);
                // A capped answer is still true, only incomplete: keep it, and ask its quarters for the rest.
                alerts.push(...answer.alerts.map(normalizeAlert).filter((a): a is WazeAlert => a !== undefined));
                jams.push(...answer.jams.map(normalizeJam).filter((j): j is WazeJam => j !== undefined));
                const withinBudget = stats.requests + nextQueue.length + 4 <= maxRequests;
                if (capped && item.depth < maxDepth && withinBudget) {
                    nextQueue.push(...splitBBox(item.box).map((box) => ({ box, depth: item.depth + 1 })));
                    continue;
                }

                stats.tiles++;
                if (capped) {
                    stats.capped++;
                }
            }

            queue = nextQueue;
        }

        if (stats.tiles === 0 && firstError !== undefined) {
            throw firstError;
        }

        if (stats.failed > 0) {
            log.debug({ error: firstError, failed: stats.failed }, "first georss tile failure");
            log.warn(
                `${stats.failed} of ${stats.requests} georss tiles failed (${firstError instanceof Error ? firstError.message.slice(0, 80) : "unknown error"}); their area is missing from the answer`
            );
        }

        const feed: Feed = {
            alerts: mergeTwins(dedupeById(alerts)),
            jams: dedupeById(jams),
            stats,
            fetchedAt: Date.now(),
        };
        log.debug(
            { boxes: opts.boxes.length, ...stats, alerts: feed.alerts.length, jams: feed.jams.length },
            "waze feed"
        );
        return feed;
    }

    /**
     * Routes from Waze's own planner. `withVignette` adds `debugParams.subscription: ["*"]` (every vignette and toll
     * pass), which Waze honours with one path; without it Waze avoids vignette motorways and returns up to `paths`.
     * `startTime` (epoch ms) also returns departure histograms.
     */
    async userDrive(opts: {
        from: LatLon;
        to: LatLon;
        paths?: number;
        withVignette: boolean;
        startTime?: number;
    }): Promise<{ routes: RouteAlternative[]; departures: DepartureOption[] }> {
        const body: Record<string, unknown> = {
            from: { y: opts.from.lat, x: opts.from.lon },
            to: { y: opts.to.lat, x: opts.to.lon },
            nPaths: opts.paths ?? 3,
            useCase: "LIVEMAP_PLANNING",
        };
        if (opts.startTime !== undefined) {
            body.startTime = opts.startTime;
            body.interval = 15;
        }

        if (opts.withVignette) {
            body.debugParams = { subscription: ["*"] };
        }

        const data = await this.json({
            path: `/live-map/api/user-drive?geo_env=${geoEnvFor(opts.from)}`,
            method: "POST",
            body,
        });
        if (!isRecord(data)) {
            throw new Error("user-drive answered something that is not an object");
        }

        if ("error" in data) {
            throw new Error(`Waze routing failed: ${String(data.code ?? data.error)}`);
        }

        const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];
        const routes: RouteAlternative[] = [];
        const departures: DepartureOption[] = [];
        for (const alternative of alternatives) {
            if (!isRecord(alternative) || !isRecord(alternative.response)) {
                continue;
            }

            const response = alternative.response;
            const coords = (Array.isArray(alternative.coords) ? alternative.coords : [])
                .map((point) =>
                    isRecord(point)
                        ? { lat: finite(point.y) ?? Number.NaN, lon: finite(point.x) ?? Number.NaN }
                        : undefined
                )
                .filter(
                    (point): point is LatLon =>
                        point !== undefined && Number.isFinite(point.lat) && Number.isFinite(point.lon)
                );
            const label =
                isRecord(response.label) && isRecord(response.label.extraInfoLabel)
                    ? response.label.extraInfoLabel
                    : {};
            routes.push({
                source: "waze",
                name: str(response.routeName) ?? "?",
                distanceM: finite(response.totalLength) ?? 0,
                durationSec: finite(response.totalSeconds) ?? 0,
                isFastest: response.isFastest === true,
                isToll: response.isToll === true,
                trafficLabel: str(label.trafficStatusLabel),
                withVignette: opts.withVignette,
                coords,
            });
            if (departures.length === 0 && Array.isArray(response.etaHistograms)) {
                for (const entry of response.etaHistograms) {
                    const leave = isRecord(entry) ? finite(entry.timeToLeave) : undefined;
                    const arrive = isRecord(entry) ? finite(entry.eta) : undefined;
                    const minutes = isRecord(entry) ? finite(entry.routeLengthInMinutes) : undefined;
                    if (leave !== undefined && arrive !== undefined && minutes !== undefined) {
                        departures.push({ leaveAt: leave * 1000, arriveAt: arrive * 1000, minutes });
                    }
                }
            }
        }

        return { routes, departures };
    }

    /** Waze's place search (the live map's search box), ranked around `near` when given. */
    async autocomplete(opts: { query: string; near?: LatLon; lang?: string }): Promise<WazeSuggestion[]> {
        const params = new URLSearchParams({
            q: opts.query,
            exp: "8,10,12",
            "geo-env": opts.near ? geoEnvFor(opts.near) : "row",
            lang: opts.lang ?? "cs",
        });
        if (opts.near) {
            params.set("sll", `${opts.near.lat},${opts.near.lon}`);
        } else {
            // Waze refuses a search with neither a centre nor a viewport (HTTP 400); the whole map is the viewport.
            params.set("v", WORLD_VIEWPORT);
        }

        const data = await this.json({ path: `/live-map/api/autocomplete/?${params}` });
        const rows = Array.isArray(data) ? data : [];
        return rows.flatMap((row): WazeSuggestion[] => {
            const point = isRecord(row) ? latLngOf(row.latLng) : undefined;
            if (!isRecord(row) || !point) {
                return [];
            }

            return [
                {
                    name: str(row.cleanName) ?? str(row.name) ?? "?",
                    address: str(row.address),
                    venueId: str(row.venueId),
                    lat: point.lat,
                    lon: point.lon,
                },
            ];
        });
    }

    /** The street address at a point (`radius` in degrees, the page's default 0.0005). */
    async reverseGeocode(point: LatLon): Promise<{ address?: string; street?: string; city?: string } | undefined> {
        const params = new URLSearchParams({
            lat: String(point.lat),
            lng: String(point.lon),
            geoEnv: geoEnvFor(point),
            radius: "0.0005",
        });
        const data = await this.json({ path: `/live-map/api/reverse-geocoding?${params}` });
        const first = Array.isArray(data) ? data[0] : undefined;
        if (!isRecord(first)) {
            return undefined;
        }

        return { address: str(first.address), street: str(first.street), city: str(first.city) };
    }

    /** A Waze venue (`venues.<a>.<b>.<c>` or the bare `<a>.<b>.<c>`): address, phone, services, opening hours. */
    async venue(id: string, lang = "cs"): Promise<WazeVenue> {
        const bare = id.replace(/^venues\./, "");
        const data = await this.json({
            path: `/live-map/api/venues/${encodeURIComponent(bare)}?${new URLSearchParams({ locale: lang })}`,
        });
        if (!isRecord(data)) {
            throw new Error(`Venue ${id} answered something that is not an object`);
        }

        const point = latLngOf(data.latLng);
        const address = isRecord(data.address)
            ? Object.fromEntries(
                  Object.entries(data.address).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string"
                  )
              )
            : undefined;
        return {
            id: str(data.id) ?? `venues.${bare}`,
            name: str(data.name),
            lat: point?.lat,
            lon: point?.lon,
            address,
            phone: isRecord(data.phone) ? str(data.phone.text) : undefined,
            url: str(data.url) ?? (isRecord(data.url) ? str(data.url.href) : undefined),
            services: Array.isArray(data.services)
                ? data.services.filter((s): s is string => typeof s === "string")
                : [],
            categories: Array.isArray(data.categories)
                ? data.categories.filter((s): s is string => typeof s === "string")
                : [],
            hours: (Array.isArray(data.hours) ? data.hours : []).flatMap((entry) =>
                isRecord(entry) ? [{ day: finite(entry.day) ?? 0, from: hhmm(entry.from), to: hhmm(entry.to) }] : []
            ),
        };
    }

    /** Venues Waze lists at the same address (the venue card's "nearby" list); often empty. */
    async venuesNearby(address: Record<string, string>): Promise<WazeSuggestion[]> {
        const data = await this.json({ path: `/live-map/api/venues/nearby?${new URLSearchParams(address)}` });
        const rows = isRecord(data) && Array.isArray(data.nearbyVenues) ? data.nearbyVenues : [];
        return rows.flatMap((row): WazeSuggestion[] => {
            const point = isRecord(row) ? latLngOf(row.latLng) : undefined;
            if (!isRecord(row) || !point) {
                return [];
            }

            return [{ name: str(row.name) ?? "?", venueId: str(row.id), lat: point.lat, lon: point.lon }];
        });
    }
}
