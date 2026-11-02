import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import {
    alertLabel,
    categoryOf,
    dedupeById,
    formatAge,
    matchesCategories,
    mergeTwins,
    normalizeAlert,
    normalizeJam,
} from "./alerts";
import { WazeClient } from "./client";
import { WazeContext } from "./context";
import { alertsOnLine, jamsOnLine } from "./corridor";
import { liveMapDirectionsLink, navigateLink, searchLink } from "./deeplinks";
import { exportTrip, toCsv } from "./export";
import { coverageWarnings } from "./format";
import {
    bboxAround,
    corridorTiles,
    cumulativeDistances,
    geoEnvFor,
    haversineM,
    parseBBox,
    parseLatLon,
    positionOnLine,
    splitBBox,
    thinLine,
} from "./geo";
import { findOperation, USER_REPORTS_HIDDEN_NOTICE } from "./operations";
import { planRoute } from "./routing";
import type { WazeRequest, WazeResponse, WazeTransport } from "./session";
import { WazeStore } from "./store";
import type { Feed, FeedStats, LatLon, RouteAlternative, WazeAlert } from "./types";
import { parseInterval, parseWhen } from "./when";

/** A straight road heading east along latitude 50, about 7.2 km long. */
const ROAD: LatLon[] = [
    { lat: 50, lon: 14.0 },
    { lat: 50, lon: 14.05 },
    { lat: 50, lon: 14.1 },
];

function alert(id: string, lat: number, lon: number, extra: Partial<WazeAlert> = {}): WazeAlert {
    return {
        id,
        category: "police",
        type: "POLICE",
        subtype: "",
        lat,
        lon,
        publishedAt: 1_000,
        thumbsUp: 0,
        ...extra,
    };
}

describe("geo parsing", () => {
    test("lat,lon and boxes", () => {
        expect(parseLatLon("50.0755, 14.4378")).toEqual({ lat: 50.0755, lon: 14.4378 });
        expect(parseLatLon("49.19 16.61")).toEqual({ lat: 49.19, lon: 16.61 });
        expect(parseLatLon("Praha")).toBeUndefined();
        expect(parseLatLon("120,14")).toBeUndefined();
        expect(parseBBox("49.9,14.2,50.2,14.7")).toEqual({ top: 50.2, bottom: 49.9, left: 14.2, right: 14.7 });
        expect(parseBBox("50.2,14.2,49.9,14.7")).toBeUndefined();
        expect(parseBBox("50,14")).toBeUndefined();
    });

    test("geo environments follow the live map's lines", () => {
        expect(geoEnvFor({ lat: 50.08, lon: 14.43 })).toBe("row");
        expect(geoEnvFor({ lat: 40.7, lon: -74 })).toBe("na");
        expect(geoEnvFor({ lat: 32.08, lon: 34.78 })).toBe("il");
    });
});

describe("tiling", () => {
    test("a capped box splits into four quarters that cover it", () => {
        const box = { top: 2, bottom: 0, left: 10, right: 14 };
        const parts = splitBBox(box);
        expect(parts).toHaveLength(4);
        expect(Math.max(...parts.map((p) => p.top))).toBe(2);
        expect(Math.min(...parts.map((p) => p.bottom))).toBe(0);
        expect(Math.min(...parts.map((p) => p.left))).toBe(10);
        expect(Math.max(...parts.map((p) => p.right))).toBe(14);
        expect(parts.every((p) => p.top - p.bottom === 1 && p.right - p.left === 2)).toBe(true);
    });

    test("route tiles follow the line and cover every point with padding", () => {
        const tiles = corridorTiles({ line: ROAD, tileM: 3000, paddingM: 200 });
        expect(tiles.length).toBe(2);
        for (const point of ROAD) {
            expect(
                tiles.some(
                    (t) => point.lat <= t.top && point.lat >= t.bottom && point.lon >= t.left && point.lon <= t.right
                )
            ).toBe(true);
        }

        // 200 m of padding north of the line is about 0.0018 degrees.
        expect(tiles[0]?.top).toBeCloseTo(50.0018, 3);
    });

    test("a radius box reaches the radius on each axis", () => {
        const center = { lat: 50, lon: 14 };
        const box = bboxAround(center, 2000);
        expect(haversineM(center, { lat: box.top, lon: 14 })).toBeCloseTo(2000, -1);
        expect(haversineM(center, { lat: 50, lon: box.right })).toBeCloseTo(2000, -1);
    });
});

describe("corridor", () => {
    test("position on line: metres along, metres off, side of the driving direction", () => {
        const cumulative = cumulativeDistances(ROAD);
        const north = positionOnLine({ lat: 50.0009, lon: 14.06 }, ROAD, cumulative);
        expect(north.side).toBe("left");
        expect(north.offsetM).toBeCloseTo(100, -1);
        expect(north.alongM / 1000).toBeCloseTo(4.3, 1);
        expect(positionOnLine({ lat: 49.9991, lon: 14.06 }, ROAD, cumulative).side).toBe("right");
    });

    test("alerts off the corridor drop out and the rest are ordered from the start", () => {
        const kept = alertsOnLine({
            alerts: [alert("far", 50.01, 14.05), alert("b", 50.0005, 14.09), alert("a", 49.9995, 14.01)],
            line: ROAD,
            maxOffsetM: 150,
        });
        expect(kept.map((a) => a.id)).toEqual(["a", "b"]);
        expect(kept[0]?.side).toBe("right");
    });

    test("a jam counts only when it runs along the route in the driving direction", () => {
        const along = {
            id: "1",
            level: 4,
            lengthM: 500,
            speedKmh: 5,
            updatedAt: 0,
            line: [
                { lat: 50.0001, lon: 14.02 },
                { lat: 50.0001, lon: 14.03 },
            ],
        };
        const crossing = {
            ...along,
            id: "2",
            line: [
                { lat: 50.0001, lon: 14.04 },
                { lat: 50.01, lon: 14.04 },
            ],
        };
        const opposite = { ...along, id: "3", line: [...along.line].reverse() };
        expect(jamsOnLine({ jams: [crossing, along, opposite], line: ROAD, maxOffsetM: 40 }).map((j) => j.id)).toEqual([
            "1",
        ]);
    });
});

describe("feed normalisation", () => {
    test("georss alerts and jams in the 2026 shape", () => {
        const raw = {
            id: "alert-1/abc",
            location: { x: 14.4, y: 50.06 },
            type: "POLICE",
            subtype: "POLICE_HIDING",
            street: "D1",
            reportDescription: "",
            pubMillis: 1_700_000_000_000,
            nThumbsUp: 3,
        };
        expect(normalizeAlert(raw)).toEqual({
            id: "alert-1/abc",
            category: "police",
            type: "POLICE",
            subtype: "POLICE_HIDING",
            lat: 50.06,
            lon: 14.4,
            street: "D1",
            description: undefined,
            publishedAt: 1_700_000_000_000,
            thumbsUp: 3,
        });
        expect(normalizeAlert({ type: "POLICE" })).toBeUndefined();
        const jam = normalizeJam({
            id: 7,
            line: [
                { x: 14.1, y: 50.1 },
                { x: 14.2, y: 50.2 },
            ],
            level: 4,
            length: 261,
            speed: 0.35,
            updateMillis: 5,
        });
        expect(jam?.id).toBe("7");
        expect(jam?.speedKmh).toBe(1.3);
        expect(jam?.line[1]).toEqual({ lat: 50.2, lon: 14.2 });
    });

    test("categories, labels, dedupe and age", () => {
        expect(categoryOf("ROAD_CLOSED", "")).toBe("closure");
        expect(categoryOf("HAZARD", "HAZARD_ON_ROAD_POT_HOLE")).toBe("hazard");
        expect(categoryOf("CHIT_CHAT", "")).toBe("other");
        const camera = alert("c", 0, 0, { subtype: "POLICE_WITH_MOBILE_CAMERA" });
        expect(matchesCategories(camera, ["camera"])).toBe(true);
        expect(matchesCategories(camera, ["accident"])).toBe(false);
        expect(alertLabel({ category: "hazard", type: "HAZARD", subtype: "HAZARD_ON_ROAD_POT_HOLE" })).toBe(
            "Hazard (on road pot hole)"
        );
        expect(alertLabel({ category: "police", type: "POLICE", subtype: "POLICE_HIDING" })).toBe("Police (hiding)");
        expect(dedupeById([alert("x", 1, 1), alert("x", 2, 2), alert("y", 3, 3)]).map((a) => a.lat)).toEqual([1, 3]);
        const merged = mergeTwins([
            alert("east", 50, 14),
            alert("west", 50, 14, { thumbsUp: 4 }),
            alert("other", 50, 14.1),
        ]);
        expect(merged.map((a) => a.id)).toEqual(["east", "other"]);
        expect(merged[0]?.twinIds).toEqual(["west"]);
        expect(merged[0]?.thumbsUp).toBe(4);
        expect(alertLabel(merged[0] ?? alert("x", 0, 0))).toBe("Police ×2");
        expect(formatAge(0, 10)).toBe("?");
        expect(formatAge(1, 1 + 125 * 60_000)).toBe("2 h 5 min");
    });
});

describe("links, times, exports", () => {
    test("official deep links", () => {
        expect(navigateLink({ lat: 49.1951, lon: 16.6068 })).toBe(
            "https://waze.com/ul?ll=49.195100%2C16.606800&navigate=yes"
        );
        expect(searchLink("Brno hlavní nádraží")).toBe("https://waze.com/ul?q=Brno+hlavn%C3%AD+n%C3%A1dra%C5%BE%C3%AD");
        expect(liveMapDirectionsLink({ lat: 50, lon: 14 }, { lat: 49, lon: 16 })).toBe(
            "https://www.waze.com/live-map/directions?from=ll.50.000000%2C14.000000&to=ll.49.000000%2C16.000000"
        );
    });

    test("departure times and poll intervals", () => {
        const now = new Date(2026, 10, 1, 8, 30).getTime();
        expect(parseWhen("now", now)).toBe(now);
        expect(new Date(parseWhen("17:15", now) ?? 0).getDate()).toBe(1);
        expect(new Date(parseWhen("07:00", now) ?? 0).getDate()).toBe(2);
        expect(new Date(parseWhen("tomorrow 9:00", now) ?? 0).getHours()).toBe(9);
        expect(parseWhen("25:00", now)).toBeUndefined();
        expect(parseInterval("90s")).toBe(90_000);
        expect(parseInterval("2")).toBe(120_000);
        expect(parseInterval("1h")).toBe(3_600_000);
        expect(parseInterval("soon")).toBeUndefined();
        expect(thinLine(ROAD, 2)).toEqual([ROAD[0], ROAD[2]]);
        // A summary that asks for no points gets none, not the whole line; one point is the start.
        expect(thinLine(ROAD, 0)).toEqual([]);
        expect(thinLine(ROAD, -1)).toEqual([]);
        expect(thinLine(ROAD, 1)).toEqual([ROAD[0]]);
        expect(thinLine(ROAD, 10)).toEqual(ROAD);
    });

    test("csv quotes cells with commas", () => {
        const csv = toCsv({
            from: { label: "A", lat: 50, lon: 14 },
            to: { label: "B", lat: 50, lon: 14.1 },
            route: {
                source: "waze",
                name: "D1",
                distanceM: 7000,
                durationSec: 300,
                isFastest: true,
                isToll: false,
                withVignette: true,
                coords: ROAD,
            },
            alerts: [{ ...alert("q", 50, 14.05, { street: "Main, North" }), alongM: 3600, offsetM: 10, side: "right" }],
            jams: [],
            generatedAt: 0,
        });
        expect(csv.split("\n")[1]).toContain('"Main, North"');
        expect(csv.split("\n")[1]?.startsWith("alert,3.6,police")).toBe(true);
    });
});

describe("history store", () => {
    test("a report seen in two snapshots counts once, with two sightings, and shows as a hotspot", () => {
        const store = WazeStore.open(":memory:");
        try {
            const report = alert("p1", 50.001, 14.001, { publishedAt: new Date(2026, 10, 1, 7, 10).getTime() });
            store.record({ kind: "area", label: "test", area: {}, alerts: [report], jams: 2, takenAt: 10 });
            store.record({ kind: "area", label: "test", area: {}, alerts: [report], jams: 1, takenAt: 20 });
            expect(store.counts()).toEqual({ snapshots: 2, alerts: 1, police: 1 });
            const sightings = store.db.query<{ sightings: number }, []>("SELECT sightings FROM alerts").get();
            expect(sightings?.sightings).toBe(2);
            const [spot] = store.hotspots({ category: "police" });
            expect(spot?.reports).toBe(1);
            expect(spot?.topHours).toEqual([7]);
            expect(store.hourHistogram({ category: "police" })[7]?.reports).toBe(1);
            expect(store.snapshots(1)[0]?.takenAt).toBe(20);
        } finally {
            store.close();
        }
    });
});

/** A transport that answers every request from `answer` (an empty georss answer by default) and records it. */
function fakeTransport(
    opts: { hidden?: boolean; answer?: (req: WazeRequest) => WazeResponse } = {}
): WazeTransport & { seen: WazeRequest[] } {
    const seen: WazeRequest[] = [];
    return {
        seen,
        request: async (req) => {
            seen.push(req);
            return opts.answer?.(req) ?? { status: 200, body: '{"alerts":[],"jams":[]}', retried: false };
        },
        info: () => ({
            kind: "browser-tab",
            port: 0,
            browser: "test",
            tabId: "tab",
            reused: false,
            keepTab: false,
            userReportsHidden: opts.hidden,
        }),
        close: async () => {},
    };
}

function road(name: string, withVignette: boolean): RouteAlternative {
    return {
        source: "waze",
        name,
        distanceM: 7000,
        durationSec: 300,
        isFastest: withVignette,
        isToll: false,
        withVignette,
        coords: ROAD,
    };
}

/** A client whose routes and feed are canned; it records the departure each route request asked for. */
class TripClient extends WazeClient {
    readonly drives: Array<{ withVignette: boolean; startTime?: number }> = [];

    constructor(
        private readonly stats: FeedStats,
        hidden = false
    ) {
        super(fakeTransport({ hidden }), { minIntervalMs: 0 });
    }

    override async userDrive(opts: { withVignette: boolean; startTime?: number }) {
        this.drives.push({ withVignette: opts.withVignette, startTime: opts.startTime });
        return { routes: [road(opts.withVignette ? "D1" : "Old road", opts.withVignette)], departures: [] };
    }

    override async feed(): Promise<Feed> {
        return { alerts: [], jams: [], stats: this.stats, fetchedAt: 1_000 };
    }
}

/** A context over one client, never a browser tab. */
class ClientContext extends WazeContext {
    constructor(private readonly fake: WazeClient) {
        super();
    }

    override client(): Promise<WazeClient> {
        return Promise.resolve(this.fake);
    }

    override openedClient(): WazeClient {
        return this.fake;
    }
}

const WHOLE: FeedStats = { requests: 1, tiles: 1, capped: 0, failed: 0, skipped: 0 };

describe("feed budget", () => {
    test("a feed never sends more than its budget, retries included, and counts the boxes it left unasked", async () => {
        // Every answer took the transport's fresh-token retry unless the request forbade it: two wire requests each.
        const transport = fakeTransport({
            answer: (req) => ({ status: 200, body: '{"alerts":[],"jams":[]}', retried: req.retry !== false }),
        });
        const client = new WazeClient(transport, { minIntervalMs: 0 });
        const box = bboxAround({ lat: 50, lon: 14 }, 1000);
        const feed = await client.feed({ boxes: [box, box, box, box], maxRequests: 5, concurrency: 1 });

        expect(feed.stats).toEqual({ requests: 5, tiles: 3, capped: 0, failed: 0, skipped: 1 });
        // The third box had room for one request only, so it went out without the retry.
        expect(transport.seen.map((req) => req.retry)).toEqual([true, true, false]);
    });

    test("more first boxes than the budget do not raise it", async () => {
        const transport = fakeTransport();
        const client = new WazeClient(transport, { minIntervalMs: 0 });
        const box = bboxAround({ lat: 50, lon: 14 }, 1000);
        const feed = await client.feed({ boxes: [box, box, box], maxRequests: 2, concurrency: 1 });

        expect(transport.seen).toHaveLength(2);
        expect(feed.stats).toMatchObject({ requests: 2, tiles: 2, skipped: 1 });
        expect(coverageWarnings(feed.stats)).toEqual([
            "1 georss tiles were not asked (request budget spent): their area is missing.",
        ]);
    });
});

describe("operations", () => {
    test("history and hotspots refuse what their published schema refuses", async () => {
        const ctx = new WazeContext();
        await expect(findOperation("history").run(ctx, { limit: -1 })).rejects.toThrow();
        await expect(findOperation("hotspots").run(ctx, { limit: -1 })).rejects.toThrow();
        await expect(findOperation("hotspots").run(ctx, { cellKm: 0 })).rejects.toThrow();
        await expect(findOperation("hotspots").run(ctx, { sinceDays: -3 })).rejects.toThrow();
    });

    test("alternative routes are asked for the same departure as the primary", async () => {
        const client = new TripClient(WHOLE);
        const planned = await planRoute({
            client,
            from: ROAD[0] as LatLon,
            to: ROAD[2] as LatLon,
            vignette: true,
            alternatives: true,
            startTime: 1_800_000_000_000,
        });

        expect(planned.routes.map((route) => route.name)).toEqual(["D1", "Old road"]);
        expect(client.drives).toEqual([
            { withVignette: true, startTime: 1_800_000_000_000 },
            { withVignette: false, startTime: 1_800_000_000_000 },
        ]);
    });

    test("an export says when coverage is incomplete or reports are hidden, in its data and its metadata", async () => {
        const client = new TripClient({ requests: 3, tiles: 2, capped: 1, failed: 0, skipped: 1 }, true);
        const result = await findOperation("export").run(new ClientContext(client), {
            from: "50,14",
            to: "50,14.1",
            format: "geojson",
        });
        const data = z
            .object({ content: z.string(), complete: z.boolean(), warnings: z.array(z.string()), notice: z.string() })
            .parse(result.data);

        expect(data.complete).toBe(false);
        expect(data.warnings).toEqual([
            "1 georss tiles stayed at the 200-report cap: their area may miss reports.",
            "1 georss tiles were not asked (request budget spent): their area is missing.",
            USER_REPORTS_HIDDEN_NOTICE,
        ]);
        expect(data.notice).toBe(USER_REPORTS_HIDDEN_NOTICE);
        // The text is the document itself, still valid JSON, with the warnings as a member.
        expect(result.markdown).toBe(data.content);
        expect(SafeJSON.parse(data.content, { strict: true })).toMatchObject({ warnings: data.warnings });

        const input = {
            from: { label: "A", lat: 50, lon: 14 },
            to: { label: "B", lat: 50, lon: 14.1 },
            route: road("D1", true),
            alerts: [],
            jams: [],
            generatedAt: 0,
            warnings: ["Part <missing> & capped."],
        };
        expect(exportTrip("gpx", input)).toContain("<desc>Part &lt;missing&gt; &amp; capped.</desc><time>");
        expect(exportTrip("kml", input)).toContain("<description>Part &lt;missing&gt; &amp; capped.</description>");
        expect(exportTrip("csv", input)).toBe(exportTrip("csv", { ...input, warnings: [] }));
        expect(exportTrip("gpx", { ...input, warnings: [] })).not.toContain("<desc>");
        expect(SafeJSON.parse(exportTrip("geojson", { ...input, warnings: [] }), { strict: true })).not.toHaveProperty(
            "warnings"
        );

        const whole = await findOperation("export").run(new ClientContext(new TripClient(WHOLE)), {
            from: "50,14",
            to: "50,14.1",
            format: "csv",
        });
        expect(whole.data).toMatchObject({ complete: true, warnings: [] });
    });
});
