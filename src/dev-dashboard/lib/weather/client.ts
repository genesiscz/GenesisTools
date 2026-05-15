import { SafeJSON } from "@app/utils/json";
import type { WeatherSnapshot } from "./types";

interface OpenMeteoResponse {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: { sunrise?: string[]; sunset?: string[] };
}

interface WeatherCoords {
    latitude: number;
    longitude: number;
    label: string;
}

const WMO_DESCRIPTIONS: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Drizzle",
    53: "Drizzle",
    55: "Drizzle",
    56: "Drizzle",
    57: "Drizzle",
    61: "Rain",
    63: "Rain",
    65: "Rain",
    66: "Rain",
    67: "Rain",
    71: "Snow",
    73: "Snow",
    75: "Snow",
    77: "Snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm",
    99: "Thunderstorm",
};

export function weatherCodeDescription(code: number): string {
    return WMO_DESCRIPTIONS[code] ?? "Unknown";
}

export function parseOpenMeteo(json: OpenMeteoResponse, label: string): WeatherSnapshot {
    const code = typeof json.current?.weather_code === "number" ? json.current.weather_code : null;
    const temp =
        typeof json.current?.temperature_2m === "number" ? json.current.temperature_2m : null;
    const sunrise = json.daily?.sunrise?.[0] ?? null;
    const sunset = json.daily?.sunset?.[0] ?? null;

    return {
        tempC: temp,
        weatherCode: code,
        description: code === null ? "" : weatherCodeDescription(code),
        sunrise,
        sunset,
        label,
        fetchedAt: new Date().toISOString(),
    };
}

export async function fetchWeather(coords: WeatherCoords): Promise<WeatherSnapshot> {
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}` +
        `&longitude=${coords.longitude}` +
        "&current=temperature_2m,weather_code&daily=sunrise,sunset&timezone=auto";

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const json = SafeJSON.parse(await res.text()) as OpenMeteoResponse;
        return parseOpenMeteo(json, coords.label);
    } catch {
        return {
            tempC: null,
            weatherCode: null,
            description: "",
            sunrise: null,
            sunset: null,
            label: coords.label,
            fetchedAt: new Date().toISOString(),
            error: "fetch failed",
        };
    }
}
