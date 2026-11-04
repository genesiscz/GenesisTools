import { type DashboardClient, ENDPOINTS, type ForecastDto, type ForecastWindowDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const accountsKeys = { forecast: ["accounts", "forecast"] as const };

/** Stored readings change about once a minute on the Mac; nothing here fetches an account. */
export const FORECAST_INTERVAL_MS = 60_000;

export function forecastQuery(client: DashboardClient) {
    return queryOptions<ForecastDto>({
        queryKey: accountsKeys.forecast,
        queryFn: () => client.call(ENDPOINTS.gatewayForecast, {}),
        refetchInterval: FORECAST_INTERVAL_MS,
    });
}

function clock(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "resets in 2 h 10 min", or null without a reset time. */
export function resetLine(window: Pick<ForecastWindowDto, "resetsAt">, now: number): string | null {
    if (!window.resetsAt) {
        return null;
    }

    const minutes = Math.max(0, Math.round((Date.parse(window.resetsAt) - now) / 60_000));

    if (minutes >= 24 * 60) {
        return `resets in ${Math.round(minutes / (24 * 60))} d`;
    }

    return minutes >= 60 ? `resets in ${Math.floor(minutes / 60)} h ${minutes % 60} min` : `resets in ${minutes} min`;
}

/** "runs out at 15:40 at this pace" when the pace reaches the cap before the reset; null otherwise. */
export function paceLine(window: Pick<ForecastWindowDto, "exhaustAt" | "beforeReset" | "stale">): string | null {
    if (window.stale || !window.beforeReset || !window.exhaustAt) {
        return null;
    }

    return `runs out at ${clock(window.exhaustAt)} at this pace`;
}

/** The ring's tone: danger at 90 % or when it runs out before the reset, warning at 70 %, accent below. */
export function ringTone(window: Pick<ForecastWindowDto, "utilization" | "beforeReset">): "danger" | "warning" | "accent" {
    if (window.utilization >= 90 || window.beforeReset) {
        return "danger";
    }

    return window.utilization >= 70 ? "warning" : "accent";
}
