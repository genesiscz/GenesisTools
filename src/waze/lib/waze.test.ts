import { describe, expect, test } from "bun:test";
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
import { alertsOnLine, jamsOnLine } from "./corridor";
import { liveMapDirectionsLink, navigateLink, searchLink } from "./deeplinks";
import { toCsv } from "./export";
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
import { WazeStore } from "./store";
import type { LatLon, WazeAlert } from "./types";
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
