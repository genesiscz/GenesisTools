import { z } from "zod";
import { alertLabel, formatAge, matchesCategories } from "./alerts";
import type { FeedType } from "./client";
import type { WazeContext } from "./context";
import { alertsNear, type CorridorResult, DEFAULT_CORRIDOR_M, jamsNear, scanCorridor } from "./corridor";
import { liveMapDirectionsLink, liveMapLink, navigateLink, searchLink } from "./deeplinks";
import { EXPORT_FORMATS, exportTrip } from "./export";
import {
    areaAlertsMarkdown,
    areaAlertsTable,
    areaJamsMarkdown,
    areaJamsTable,
    clockText,
    corridorAlertsMarkdown,
    corridorAlertsTable,
    corridorJamsMarkdown,
    corridorJamsTable,
    corridorSummary,
    coverageWarnings,
    dateTimeText,
    departuresMarkdown,
    durationText,
    kmText,
    routesMarkdown,
    routesTable,
    statsLine,
} from "./format";
import { bboxAround, bboxCenter, bboxContains, haversineM, parseBBox, parseLatLon, thinLine } from "./geo";
import { nominatimSearch, resolvePlace } from "./places";
import { planRoute } from "./routing";
import {
    ALERT_CATEGORIES,
    type AlertCategory,
    type BBox,
    type LatLon,
    type Place,
    type RouteAlternative,
} from "./types";
import { parseWhen } from "./when";

export interface OperationResult {
    /** The machine result (`--json`, MCP structuredContent). */
    data: unknown;
    /** The human result for MCP and a non-TTY stdout. */
    markdown: string;
    /** Boxed tables for a TTY; markdown is printed when absent. */
    tables?: string;
}

export interface WazeOperation {
    name: string;
    description: string;
    input: z.ZodObject;
    /** Opens the browser tab (every Waze call). False for the pure and store-only operations. */
    usesBrowser: boolean;
    /** Lists user reports, so it carries the hidden-reports notice when Waze hides them. */
    listsReports?: boolean;
    run(ctx: WazeContext, args: unknown): Promise<OperationResult>;
}

const categoryList = z
    .array(z.enum(ALERT_CATEGORIES))
    .optional()
    .describe(`Only these categories: ${ALERT_CATEGORIES.join(", ")}. Default: all`);
const corridorM = z
    .number()
    .int()
    .min(20)
    .max(3000)
    .optional()
    .describe(`How far from the route line a report may be, metres (default ${DEFAULT_CORRIDOR_M})`);
const vignette = z
    .boolean()
    .optional()
    .describe("Allow vignette and toll motorways (default true). False gives Waze's no-vignette alternatives");
const place = (what: string) => z.string().min(1).describe(`${what}: a place name, an address or "lat,lon"`);
const area = z.string().min(1).describe('A place name, "lat,lon", or a box "south,west,north,east" (four numbers)');

interface ResolvedArea {
    label: string;
    center: LatLon;
    box: BBox;
    radiusM: number;
    /** True when the user gave a box: membership is the box, not a circle. */
    isBox: boolean;
    place?: Place;
}

async function resolveArea(ctx: WazeContext, text: string, radiusKm: number): Promise<ResolvedArea> {
    const box = parseBBox(text);
    if (box) {
        const center = bboxCenter(box);
        return {
            label: text,
            center,
            box,
            radiusM: haversineM(center, { lat: box.top, lon: box.right }),
            isBox: true,
        };
    }

    const resolved = await resolvePlace({ query: text, client: await ctx.client() });
    const radiusM = radiusKm * 1000;
    return {
        label: resolved.label,
        center: resolved,
        box: bboxAround(resolved, radiusM),
        radiusM,
        isBox: false,
        place: resolved,
    };
}

function inArea<T extends LatLon>(
    resolved: ResolvedArea,
    items: Array<T & { distanceM: number }>
): Array<T & { distanceM: number }> {
    return resolved.isBox ? items.filter((item) => bboxContains(resolved.box, item)) : items;
}

interface Trip {
    from: Place;
    to: Place;
    routes: RouteAlternative[];
    primary: RouteAlternative;
    fallbackReason?: string;
    departedAt: number;
}

async function planTrip(
    ctx: WazeContext,
    opts: { from: string; to: string; vignette?: boolean; alternatives?: boolean; startTime?: number }
): Promise<Trip & { departures: Awaited<ReturnType<typeof planRoute>>["departures"] }> {
    const client = await ctx.client();
    const from = await resolvePlace({ query: opts.from, client });
    const to = await resolvePlace({ query: opts.to, client, near: from });
    const planned = await planRoute({
        client,
        from,
        to,
        vignette: opts.vignette ?? true,
        alternatives: opts.alternatives ?? false,
        startTime: opts.startTime,
    });
    const primary = planned.routes[0];
    if (!primary) {
        throw new Error("No route found");
    }

    return {
        from,
        to,
        routes: planned.routes,
        primary,
        fallbackReason: planned.fallbackReason,
        departedAt: opts.startTime ?? Date.now(),
        departures: planned.departures,
    };
}

function tripHeader(trip: Trip): string {
    const lines = [
        `**${trip.from.label}** → **${trip.to.label}**`,
        `${trip.primary.name} · ${kmText(trip.primary.distanceM)} · ${durationText(trip.primary.durationSec)} · arrive ${clockText(trip.departedAt + trip.primary.durationSec * 1000)} (${trip.primary.source}${trip.primary.withVignette ? "" : ", no vignette"})`,
    ];
    if (trip.fallbackReason) {
        lines.push(`⚠️ Waze routing failed (${trip.fallbackReason}); the corridor follows the OSRM demo route instead.`);
    }

    return lines.join("\n");
}

function routeSummary(route: RouteAlternative, maxPoints: number) {
    return { ...route, coords: thinLine(route.coords, maxPoints), points: route.coords.length };
}

function corridorData(result: CorridorResult) {
    return {
        alerts: result.alerts,
        jams: result.jams,
        lengthM: result.lengthM,
        stats: result.stats,
        fetchedAt: result.fetchedAt,
    };
}

const alertsInput = z.object({
    area,
    radiusKm: z.number().min(0.1).max(100).optional().describe("Radius around a place, km (default 5)"),
    types: categoryList,
    limit: z.number().int().min(1).max(2000).optional().describe("Most reports to list (default 100)"),
});

const tripInput = z.object({
    from: place("Start"),
    to: place("Destination"),
    corridorM,
    vignette,
});

const routeInput = tripInput.extend({
    alternatives: z.boolean().optional().describe("Also list Waze's no-vignette alternatives"),
    types: categoryList,
    at: z.string().optional().describe('Departure: "now", "HH:MM", "tomorrow HH:MM" or an ISO date-time'),
});

const jamsInput = z.object({
    area: area.optional(),
    from: place("Start (with to: jams along the trip)").optional(),
    to: place("Destination").optional(),
    radiusKm: z.number().min(0.1).max(100).optional().describe("Radius around a place, km (default 5)"),
    minLevel: z.number().int().min(0).max(5).optional().describe("Lowest Waze jam level to list, 0-5 (default 0)"),
    corridorM,
    vignette,
});

const nearInput = z.object({
    place: place("Where"),
    radiusKm: z.number().min(0.1).max(50).optional().describe("Radius, km (default 2)"),
});

const departInput = tripInput.omit({ corridorM: true }).extend({
    at: z.string().optional().describe('Earliest departure: "now" (default), "HH:MM", "tomorrow HH:MM" or ISO'),
    windowHours: z.number().min(0.5).max(24).optional().describe("How many hours of departures to compare (default 4)"),
});

const exportInput = tripInput.extend({
    format: z.enum(EXPORT_FORMATS).optional().describe("geojson (default), gpx, kml or csv"),
    types: categoryList,
});

const venuesInput = z.object({
    query: z.string().min(1).describe('What to look for, e.g. "benzina", "parking", "McDonald\'s"'),
    near: place("Search around").optional(),
    limit: z.number().int().min(1).max(20).optional().describe("Most results (default 10)"),
});

const recordInput = z.object({
    area: area.optional(),
    radiusKm: z.number().min(0.1).max(100).optional().describe("Radius around a place, km (default 10)"),
    from: place("Start (with to: record the trip corridor)").optional(),
    to: place("Destination").optional(),
    corridorM,
});

// Every operation parses its arguments with the schema it publishes as `input`, the same instance, because the CLI and
// the MCP adapters call `run` directly: a looser copy inside `run` would let `--limit -1` reach SQLite's `LIMIT -1`.
const venueInput = z.object({
    id: z.string().min(1).describe('A Waze venue id such as "venues.10879468.108925751.271372"'),
});

const geocodeInput = z.object({
    query: z.string().min(1).describe('A place name, or "lat,lon" for the reverse lookup'),
});

const linkInput = z.object({
    to: place("Destination"),
    from: place("Start (adds a live-map directions link)").optional(),
    navigate: z.boolean().optional().describe("Start navigation at once (default true)"),
});

const historyInput = z.object({
    limit: z.number().int().min(1).max(500).optional().describe("Most snapshots (default 20)"),
});

const hotspotsInput = z.object({
    category: z.enum(ALERT_CATEGORIES).optional().describe("Category (default police)"),
    sinceDays: z.number().min(0.1).optional().describe("Only reports from the last N days"),
    cellKm: z.number().min(0.1).max(20).optional().describe("Grid cell size, km (default 1)"),
    limit: z.number().int().min(1).max(100).optional().describe("Most places (default 15)"),
});

function parseAt(text: string | undefined): number | undefined {
    if (text === undefined) {
        return undefined;
    }

    const parsed = parseWhen(text, Date.now());
    if (parsed === undefined) {
        throw new Error(`Cannot read the time "${text}": use now, HH:MM, "tomorrow HH:MM" or an ISO date-time`);
    }

    return parsed;
}

/**
 * Shown with every report list while the live map's config hides user reports. Waze then answers road closures only,
 * so an empty police list means "Waze shows none", not "there are none".
 */
export const USER_REPORTS_HIDDEN_NOTICE =
    "⚠️ Waze's live map hides user reports right now (its page config sets hideUserReportsAndWazers), so georss answers " +
    "road closures only: police, accident, hazard and camera lists stay empty whatever is on the road. Closures, jams, " +
    "routes and ETAs are unaffected.";

/** True when the open tab says Waze's live map hides user reports. */
function reportsHidden(ctx: WazeContext): boolean {
    return ctx.openedClient()?.transport.info().userReportsHidden === true;
}

/** Prepends the hidden-reports notice to a report-listing result when the open tab says Waze hides user reports. */
function withReportsNotice(op: WazeOperation): WazeOperation {
    if (!op.listsReports) {
        return op;
    }

    return {
        ...op,
        async run(ctx, args) {
            const result = await op.run(ctx, args);
            if (!reportsHidden(ctx)) {
                return result;
            }

            const data =
                typeof result.data === "object" && result.data !== null
                    ? { ...result.data, notice: USER_REPORTS_HIDDEN_NOTICE }
                    : result.data;
            return {
                data,
                markdown: `${USER_REPORTS_HIDDEN_NOTICE}\n\n${result.markdown}`,
                tables: result.tables ? `${USER_REPORTS_HIDDEN_NOTICE}\n${result.tables}` : undefined,
            };
        },
    };
}

const OPERATION_DEFS: WazeOperation[] = [
    {
        name: "alerts",
        listsReports: true,
        description:
            "Live Waze reports (police, accidents, hazards, jam reports, closures, cameras) around a place or inside a box, nearest first.",
        input: alertsInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = alertsInput.parse(args);
            const resolved = await resolveArea(ctx, input.area, input.radiusKm ?? 5);
            const feed = await (await ctx.client()).feed({ boxes: [resolved.box], types: ["alerts"] });
            const wanted: AlertCategory[] = input.types ?? [];
            const alerts = inArea(
                resolved,
                alertsNear({ alerts: feed.alerts, center: resolved.center, radiusM: resolved.radiusM })
            )
                .filter((alert) => matchesCategories(alert, wanted))
                .slice(0, input.limit ?? 100);
            const now = Date.now();
            const head = `${alerts.length} reports around **${resolved.label}** (${kmText(resolved.radiusM)}${resolved.isBox ? " box" : " radius"}); ${statsLine(feed.stats)}.`;
            return {
                data: { area: resolved, alerts, stats: feed.stats, fetchedAt: feed.fetchedAt },
                markdown: `${head}\n\n${areaAlertsMarkdown(alerts, now)}`,
                tables: alerts.length > 0 ? `${head}\n${areaAlertsTable(alerts, now)}` : undefined,
            };
        },
    },
    {
        name: "police",
        listsReports: true,
        description:
            "Police reports along a whole trip: the route from Waze, every georss tile on its corridor, each report with its km marker from the start, age and side of the road.",
        input: tripInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = tripInput.parse(args);
            const trip = await planTrip(ctx, input);
            const result = await scanCorridor({
                client: await ctx.client(),
                line: trip.primary.coords,
                corridorM: input.corridorM,
                types: ["police"],
                feedTypes: ["alerts"],
            });
            const now = Date.now();
            const head = `${tripHeader(trip)}\n${result.alerts.length} police reports on the corridor; ${statsLine(result.stats)}.`;
            return {
                data: {
                    from: trip.from,
                    to: trip.to,
                    route: routeSummary(trip.primary, 0),
                    fallbackReason: trip.fallbackReason,
                    police: result.alerts,
                    stats: result.stats,
                    fetchedAt: result.fetchedAt,
                    link: navigateLink(trip.to),
                },
                markdown: `${head}\n\n${corridorAlertsMarkdown(result.alerts, now)}`,
                tables: result.alerts.length > 0 ? `${head}\n${corridorAlertsTable(result.alerts, now)}` : undefined,
            };
        },
    },
    {
        name: "route",
        listsReports: true,
        description:
            "A trip: distance, ETA and alternatives from Waze, plus every report and jam on the route corridor with km markers. Optional departure time.",
        input: routeInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = routeInput.parse(args);
            const trip = await planTrip(ctx, { ...input, startTime: parseAt(input.at) });
            const result = await scanCorridor({
                client: await ctx.client(),
                line: trip.primary.coords,
                corridorM: input.corridorM,
                types: input.types,
            });
            const now = Date.now();
            const head = `${tripHeader(trip)}\n${corridorSummary(result)}`;
            const markdown = [
                head,
                "## Routes",
                routesMarkdown(trip.routes, trip.departedAt),
                "## Reports on the route",
                corridorAlertsMarkdown(result.alerts, now),
                "## Jams on the route",
                corridorJamsMarkdown(result.jams),
                `Open in Waze: ${liveMapDirectionsLink(trip.from, trip.to)}`,
            ].join("\n\n");
            const tables = [
                head,
                routesTable(trip.routes, trip.departedAt),
                result.alerts.length > 0 ? corridorAlertsTable(result.alerts, now) : "No reports on the route.",
                result.jams.length > 0 ? corridorJamsTable(result.jams) : "No jams on the route.",
                `Open in Waze: ${liveMapDirectionsLink(trip.from, trip.to)}`,
            ].join("\n");
            return {
                data: {
                    from: trip.from,
                    to: trip.to,
                    routes: trip.routes.map((route) => routeSummary(route, 200)),
                    fallbackReason: trip.fallbackReason,
                    departedAt: trip.departedAt,
                    ...corridorData(result),
                    links: { waze: navigateLink(trip.to), liveMap: liveMapDirectionsLink(trip.from, trip.to) },
                },
                markdown,
                tables,
            };
        },
    },
    {
        name: "jams",
        description:
            "Traffic jams (level 0-5, speed, length) around a place or a box, or along a trip when from and to are given.",
        input: jamsInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = jamsInput.parse(args);
            const minLevel = input.minLevel ?? 0;
            if (input.from && input.to) {
                const trip = await planTrip(ctx, { from: input.from, to: input.to, vignette: input.vignette });
                const result = await scanCorridor({
                    client: await ctx.client(),
                    line: trip.primary.coords,
                    corridorM: input.corridorM,
                    feedTypes: ["traffic"],
                });
                const jams = result.jams.filter((jam) => jam.level >= minLevel);
                const head = `${tripHeader(trip)}\n${jams.length} jams on the corridor; ${statsLine(result.stats)}.`;
                return {
                    data: {
                        from: trip.from,
                        to: trip.to,
                        route: routeSummary(trip.primary, 0),
                        jams,
                        stats: result.stats,
                    },
                    markdown: `${head}\n\n${corridorJamsMarkdown(jams)}`,
                    tables: jams.length > 0 ? `${head}\n${corridorJamsTable(jams)}` : undefined,
                };
            }

            if (!input.area) {
                throw new Error("Give an area, or both from and to");
            }

            const resolved = await resolveArea(ctx, input.area, input.radiusKm ?? 5);
            const types: FeedType[] = ["traffic"];
            const feed = await (await ctx.client()).feed({ boxes: [resolved.box], types });
            const jams = jamsNear({ jams: feed.jams, center: resolved.center, radiusM: resolved.radiusM }).filter(
                (jam) =>
                    jam.level >= minLevel &&
                    (!resolved.isBox || jam.line.some((point) => bboxContains(resolved.box, point)))
            );
            const head = `${jams.length} jams around **${resolved.label}**; ${statsLine(feed.stats)}.`;
            return {
                data: { area: resolved, jams, stats: feed.stats, fetchedAt: feed.fetchedAt },
                markdown: `${head}\n\n${areaJamsMarkdown(jams)}`,
                tables: jams.length > 0 ? `${head}\n${areaJamsTable(jams)}` : undefined,
            };
        },
    },
    {
        name: "near",
        listsReports: true,
        description:
            "Everything Waze shows right around one place: every report and jam within a small radius, nearest first.",
        input: nearInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = nearInput.parse(args);
            const resolved = await resolveArea(ctx, input.place, input.radiusKm ?? 2);
            const feed = await (await ctx.client()).feed({ boxes: [resolved.box] });
            const alerts = alertsNear({ alerts: feed.alerts, center: resolved.center, radiusM: resolved.radiusM });
            const jams = jamsNear({ jams: feed.jams, center: resolved.center, radiusM: resolved.radiusM });
            const now = Date.now();
            const head = `**${resolved.label}** (${kmText(resolved.radiusM)} radius): ${alerts.length} reports, ${jams.length} jams; ${statsLine(feed.stats)}.\nLive map: ${liveMapLink(resolved.center)}`;
            return {
                data: { area: resolved, alerts, jams, stats: feed.stats, fetchedAt: feed.fetchedAt },
                markdown: [head, "## Reports", areaAlertsMarkdown(alerts, now), "## Jams", areaJamsMarkdown(jams)].join(
                    "\n\n"
                ),
                tables: [
                    head,
                    alerts.length > 0 ? areaAlertsTable(alerts, now) : "No reports.",
                    jams.length > 0 ? areaJamsTable(jams) : "No jams.",
                ].join("\n"),
            };
        },
    },
    {
        name: "depart",
        description:
            "Best departure time for a trip: Waze's predicted drive time for each 15-minute departure in a window, shortest marked.",
        input: departInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = departInput.parse(args);
            const start = parseAt(input.at) ?? Date.now();
            const trip = await planTrip(ctx, {
                from: input.from,
                to: input.to,
                vignette: input.vignette,
                startTime: start,
            });
            const end = start + (input.windowHours ?? 4) * 3_600_000;
            const options = trip.departures.filter(
                (option) => option.leaveAt >= start - 15 * 60_000 && option.leaveAt <= end
            );
            const best = options.reduce<(typeof options)[number] | undefined>(
                (winner, option) => (!winner || option.minutes < winner.minutes ? option : winner),
                undefined
            );
            const head = `${tripHeader(trip)}\n${best ? `Best departure ${dateTimeText(best.leaveAt)}: ${best.minutes} min, arrive ${clockText(best.arriveAt)}.` : "No departure times in that window."}`;
            return {
                data: { from: trip.from, to: trip.to, route: routeSummary(trip.primary, 0), options, best },
                markdown: `${head}\n\n${departuresMarkdown(options, best)}`,
            };
        },
    },
    {
        name: "export",
        description:
            "A trip's route with its reports and jams as GeoJSON, GPX, KML or CSV text. When coverage is incomplete (capped, failed or unasked tiles) or Waze hides user reports, `warnings` in the structured result say so, and GeoJSON, GPX and KML also carry them in their own metadata.",
        input: exportInput,
        usesBrowser: true,
        // Not `listsReports`: that notice is prose put before the text, which would break the JSON or XML document.
        // The notice goes into `warnings` and the document's metadata instead.
        async run(ctx, args) {
            const input = exportInput.parse(args);
            const format = input.format ?? "geojson";
            const trip = await planTrip(ctx, input);
            const result = await scanCorridor({
                client: await ctx.client(),
                line: trip.primary.coords,
                corridorM: input.corridorM,
                types: input.types,
            });
            const hidden = reportsHidden(ctx);
            const warnings = [...coverageWarnings(result.stats), ...(hidden ? [USER_REPORTS_HIDDEN_NOTICE] : [])];
            const content = exportTrip(format, {
                from: trip.from,
                to: trip.to,
                route: trip.primary,
                alerts: result.alerts,
                jams: result.jams,
                generatedAt: result.fetchedAt,
                warnings,
            });
            return {
                data: {
                    format,
                    content,
                    alerts: result.alerts.length,
                    jams: result.jams.length,
                    stats: result.stats,
                    fetchedAt: result.fetchedAt,
                    complete: warnings.length === 0,
                    warnings,
                    ...(hidden ? { notice: USER_REPORTS_HIDDEN_NOTICE } : {}),
                },
                markdown: content,
            };
        },
    },
    {
        name: "venues",
        description: "Waze's place search around a point: names, addresses, coordinates and venue ids (for venue).",
        input: venuesInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = venuesInput.parse(args);
            const client = await ctx.client();
            const near = input.near ? await resolvePlace({ query: input.near, client }) : undefined;
            const found = (await client.autocomplete({ query: input.query, near })).slice(0, input.limit ?? 10);
            const rows = found.map((venue) => ({
                ...venue,
                distanceM: near ? Math.round(haversineM(near, venue)) : undefined,
                link: navigateLink(venue),
            }));
            const lines = rows.map(
                (venue) =>
                    `| ${venue.name.replaceAll("|", "\\|")} | ${(venue.address ?? "").replaceAll("|", "\\|")} | ${venue.distanceM !== undefined ? kmText(venue.distanceM) : ""} | ${venue.venueId ?? ""} |`
            );
            const head = `${rows.length} results for "${input.query}"${near ? ` near **${near.label}**` : ""}.`;
            return {
                data: { near, venues: rows },
                markdown: [head, "", "| Name | Address | Distance | Venue id |", "|---|---|---:|---|", ...lines].join(
                    "\n"
                ),
            };
        },
    },
    {
        name: "venue",
        description:
            "One Waze venue by id (from venues): address, phone, services, opening hours and venues at the same address.",
        input: venueInput,
        usesBrowser: true,
        async run(ctx, args) {
            const { id } = venueInput.parse(args);
            if (id.startsWith("googlePlaces.")) {
                throw new Error("Google place ids have no Waze venue card; use a venues.… id");
            }

            const client = await ctx.client();
            const venue = await client.venue(id);
            const nearby = venue.address ? await client.venuesNearby(venue.address) : [];
            const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const hours = venue.hours.map((entry) =>
                entry.from === "00:00" && entry.to === "00:00"
                    ? `${days[entry.day] ?? entry.day} 24 h`
                    : `${days[entry.day] ?? entry.day} ${entry.from}-${entry.to}`
            );
            const address = venue.address
                ? [venue.address.street, venue.address.houseNumber, venue.address.city, venue.address.countryName]
                      .filter(Boolean)
                      .join(" ")
                : "";
            const markdown = [
                `**${venue.name ?? venue.id}**${address ? `, ${address}` : ""}`,
                venue.phone ? `Phone: ${venue.phone}` : "",
                venue.url ? `Web: ${venue.url}` : "",
                venue.services.length > 0 ? `Services: ${venue.services.join(", ")}` : "",
                hours.length > 0 ? `Hours: ${hours.join(", ")}` : "",
                venue.lat !== undefined && venue.lon !== undefined
                    ? `Navigate: ${navigateLink({ lat: venue.lat, lon: venue.lon })}`
                    : "",
                nearby.length > 0 ? `Same address: ${nearby.map((item) => item.name).join(", ")}` : "",
            ]
                .filter(Boolean)
                .join("\n");
            return { data: { venue, nearby }, markdown };
        },
    },
    {
        name: "geocode",
        description:
            'Turn a place name into coordinates (Waze search, then OpenStreetMap), or "lat,lon" into a street address.',
        input: geocodeInput,
        usesBrowser: true,
        async run(ctx, args) {
            const { query } = geocodeInput.parse(args);
            const client = await ctx.client();
            const point = parseLatLon(query);
            if (point) {
                const address = await client.reverseGeocode(point);
                return {
                    data: { point, address },
                    markdown: `${point.lat},${point.lon}: ${address?.address ?? "no address"}${address?.city ? `, ${address.city}` : ""}`,
                };
            }

            const resolved = await resolvePlace({ query, client });
            return {
                data: resolved,
                markdown: `${resolved.label}: ${resolved.lat.toFixed(6)},${resolved.lon.toFixed(6)} (${resolved.source})`,
            };
        },
    },
    {
        name: "link",
        description:
            "Official Waze deep links (waze.com/ul) to navigate to a place, plus a live-map directions link when a start is given. No browser needed.",
        input: linkInput,
        usesBrowser: false,
        async run(_ctx, args) {
            const input = linkInput.parse(args);
            const links = await buildLinks(input);
            return {
                data: links,
                markdown: [`Navigate: ${links.navigate}`, links.directions ? `Live map: ${links.directions}` : ""]
                    .filter(Boolean)
                    .join("\n"),
            };
        },
    },
    {
        name: "record",
        listsReports: true,
        description:
            "Save a snapshot of the reports in an area or along a trip into the local history (for history and hotspots).",
        input: recordInput,
        usesBrowser: true,
        async run(ctx, args) {
            const input = recordInput.parse(args);
            if (input.from && input.to) {
                const trip = await planTrip(ctx, { from: input.from, to: input.to });
                const result = await scanCorridor({
                    client: await ctx.client(),
                    line: trip.primary.coords,
                    corridorM: input.corridorM,
                });
                const row = ctx.store().record({
                    kind: "route",
                    label: `${trip.from.label} → ${trip.to.label}`,
                    area: {
                        from: trip.from,
                        to: trip.to,
                        route: trip.primary.name,
                        corridorM: input.corridorM ?? DEFAULT_CORRIDOR_M,
                    },
                    alerts: result.alerts,
                    jams: result.jams.length,
                    takenAt: result.fetchedAt,
                });
                return {
                    data: { snapshot: row, stats: result.stats },
                    markdown: `Recorded snapshot ${row.id}: ${row.alerts} reports (${row.police} police), ${row.jams} jams along ${row.label}; ${statsLine(result.stats)}.`,
                };
            }

            if (!input.area) {
                throw new Error("Give an area, or both from and to");
            }

            const resolved = await resolveArea(ctx, input.area, input.radiusKm ?? 10);
            const feed = await (await ctx.client()).feed({ boxes: [resolved.box] });
            const alerts = resolved.isBox
                ? feed.alerts.filter((alert) => bboxContains(resolved.box, alert))
                : alertsNear({ alerts: feed.alerts, center: resolved.center, radiusM: resolved.radiusM });
            const row = ctx.store().record({
                kind: "area",
                label: resolved.label,
                area: { center: resolved.center, box: resolved.box, radiusM: resolved.radiusM },
                alerts,
                jams: feed.jams.length,
                takenAt: feed.fetchedAt,
            });
            return {
                data: { snapshot: row, stats: feed.stats },
                markdown: `Recorded snapshot ${row.id}: ${row.alerts} reports (${row.police} police), ${row.jams} jams around ${row.label}; ${statsLine(feed.stats)}.`,
            };
        },
    },
    {
        name: "history",
        description: "Recorded snapshots, newest first, with report and police counts.",
        input: historyInput,
        usesBrowser: false,
        async run(ctx, args) {
            const { limit } = historyInput.parse(args);
            const store = ctx.readStore();
            const rows = store?.snapshots(limit ?? 20) ?? [];
            const counts = store?.counts() ?? { snapshots: 0, alerts: 0, police: 0 };
            const lines = rows.map(
                (row) =>
                    `| ${row.id} | ${dateTimeText(row.takenAt)} | ${row.kind} | ${row.label.replaceAll("|", "\\|")} | ${row.alerts} | ${row.police} | ${row.jams} |`
            );
            return {
                data: { counts, snapshots: rows },
                markdown: [
                    `${counts.snapshots} snapshots, ${counts.alerts} distinct reports (${counts.police} police) recorded.`,
                    "",
                    "| # | Taken | Kind | Where | Reports | Police | Jams |",
                    "|---:|---|---|---|---:|---:|---:|",
                    ...lines,
                ].join("\n"),
            };
        },
    },
    {
        name: "hotspots",
        description:
            "From the recorded history: the places with the most distinct reports of a category (police by default) and the hours of day they cluster in.",
        input: hotspotsInput,
        usesBrowser: false,
        async run(ctx, args) {
            const input = hotspotsInput.parse(args);
            const category = input.category ?? "police";
            const sinceMs = input.sinceDays ? Date.now() - input.sinceDays * 86_400_000 : undefined;
            const store = ctx.readStore();
            const spots =
                store?.hotspots({ category, cellDeg: (input.cellKm ?? 1) / 111, sinceMs, limit: input.limit }) ?? [];
            const hours =
                store?.hourHistogram({ category, sinceMs }) ??
                Array.from({ length: 24 }, (_, hour) => ({ hour, reports: 0 }));
            const peak = Math.max(1, ...hours.map((row) => row.reports));
            const lines = spots.map(
                (spot) =>
                    `| ${spot.reports} | ${(spot.street ?? "").replaceAll("|", "\\|")} | ${spot.lat.toFixed(3)},${spot.lon.toFixed(3)} | ${spot.topHours.map((hour) => `${hour}:00`).join(", ")} | ${dateTimeText(spot.lastSeen)} |`
            );
            const bars = hours
                .filter((row) => row.reports > 0)
                .map(
                    (row) =>
                        `${String(row.hour).padStart(2, "0")}:00 ${"█".repeat(Math.max(1, Math.round((row.reports / peak) * 30)))} ${row.reports}`
                );
            return {
                data: { category, spots, hours },
                markdown: [
                    spots.length === 0
                        ? `No recorded ${category} reports yet. Record some first with the record operation.`
                        : `Top places for ${category} reports:`,
                    "",
                    "| Reports | Street | Cell | Busiest hours | Last seen |",
                    "|---:|---|---|---|---|",
                    ...lines,
                    "",
                    bars.length > 0 ? `Reports by hour of day:\n\`\`\`\n${bars.join("\n")}\n\`\`\`` : "",
                ].join("\n"),
            };
        },
    },
];

export interface TripLinks {
    /** waze.com/ul: `ll=` for coordinates, `q=` for a name (Waze resolves it). */
    navigate: string;
    /** The live map with the route drawn, when a start is given and both ends resolve. */
    directions?: string;
}

/** The official deep links for a destination. Names are resolved through Nominatim only, so no browser tab opens. */
export async function buildLinks(input: { to: string; from?: string; navigate?: boolean }): Promise<TripLinks> {
    const toPoint = parseLatLon(input.to);
    const navigate = toPoint
        ? navigateLink(toPoint, { navigate: input.navigate })
        : searchLink(input.to, { navigate: input.navigate ?? true });
    if (!input.from) {
        return { navigate };
    }

    const fromPoint = parseLatLon(input.from) ?? (await nominatimSearch(input.from))[0];
    const destination = toPoint ?? (await nominatimSearch(input.to))[0];
    return {
        navigate,
        directions: fromPoint && destination ? liveMapDirectionsLink(fromPoint, destination) : undefined,
    };
}

export const WAZE_OPERATIONS: WazeOperation[] = OPERATION_DEFS.map(withReportsNotice);

export function findOperation(name: string): WazeOperation {
    const op = WAZE_OPERATIONS.find((candidate) => candidate.name === name);
    if (!op) {
        throw new Error(`Unknown waze operation: ${name}`);
    }

    return op;
}

/** New police and accident reports on a corridor since the last poll: the `watch` command's diff. */
export function newReports(opts: {
    alerts: CorridorResult["alerts"];
    seen: Set<string>;
    types: AlertCategory[];
}): CorridorResult["alerts"] {
    return opts.alerts.filter((alert) => !opts.seen.has(alert.id) && matchesCategories(alert, opts.types));
}

/** One line per report for a notification body: `km 42.1 Police (hiding) · D1, 5 min ago`. */
export function reportLine(alert: CorridorResult["alerts"][number], now: number): string {
    return `km ${(alert.alongM / 1000).toFixed(1)} ${alertLabel(alert)}${alert.street ? ` · ${alert.street}` : ""}, ${formatAge(alert.publishedAt, now)} ago`;
}
