import { describe, expect, test } from "bun:test";
import { parseOpenMeteo, weatherCodeDescription } from "./client";

describe("weatherCodeDescription", () => {
    test("maps known WMO codes", () => {
        expect(weatherCodeDescription(0)).toBe("Clear sky");
        expect(weatherCodeDescription(3)).toBe("Overcast");
        expect(weatherCodeDescription(45)).toBe("Fog");
        expect(weatherCodeDescription(63)).toBe("Rain");
        expect(weatherCodeDescription(75)).toBe("Snow");
        expect(weatherCodeDescription(82)).toBe("Rain showers");
        expect(weatherCodeDescription(95)).toBe("Thunderstorm");
    });

    test("falls back for unknown code", () => {
        expect(weatherCodeDescription(999)).toBe("Unknown");
    });
});

describe("parseOpenMeteo", () => {
    test("extracts current temp, code and daily sun times", () => {
        const fixture = {
            current: { temperature_2m: 7.2, weather_code: 3 },
            daily: { sunrise: ["2026-05-15T05:12"], sunset: ["2026-05-15T20:41"] },
        };
        const snap = parseOpenMeteo(fixture, "Prague");
        expect(snap.tempC).toBe(7.2);
        expect(snap.weatherCode).toBe(3);
        expect(snap.description).toBe("Overcast");
        expect(snap.sunrise).toBe("2026-05-15T05:12");
        expect(snap.sunset).toBe("2026-05-15T20:41");
        expect(snap.label).toBe("Prague");
        expect(snap.error).toBeUndefined();
        expect(typeof snap.fetchedAt).toBe("string");
    });

    test("handles missing fields gracefully", () => {
        const snap = parseOpenMeteo({}, "Nowhere");
        expect(snap.tempC).toBeNull();
        expect(snap.weatherCode).toBeNull();
        expect(snap.sunrise).toBeNull();
        expect(snap.sunset).toBeNull();
        expect(snap.label).toBe("Nowhere");
    });
});
