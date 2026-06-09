import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Alert, TvSession } from "./types";

const BASE = "https://pricealerts.tradingview.com";
const TV_ORIGIN = "https://www.tradingview.com";

interface ApiEnvelope<T> {
    s: string;
    r: T;
}

function headers(session: TvSession): Record<string, string> {
    return { cookie: session.cookie, origin: TV_ORIGIN, "content-type": "text/plain;charset=UTF-8" };
}

export async function listAlerts(session: TvSession): Promise<Alert[]> {
    const url = `${BASE}/list_alerts?log_username=${encodeURIComponent(session.username)}&user_id=${session.userId}`;
    const res = await fetch(url, { headers: headers(session) });
    const body = (await res.json()) as ApiEnvelope<Alert[]>;
    if (body.s !== "ok") {
        logger.warn({ status: body.s }, "tradingview: list_alerts non-ok");
        return [];
    }
    return body.r;
}

export interface RecentFire {
    fires_count: number;
    latest_fire: {
        fire_id: number;
        alert_id: number;
        symbol: string;
        message: string;
        fire_time: string;
        bar_time: string;
        resolution: string;
        name: string | null;
        kinds: string[];
    };
}

export async function getRecentFires(session: TvSession, limit = 2000): Promise<RecentFire[]> {
    const url = `${BASE}/get_offline_fires?log_username=${encodeURIComponent(session.username)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: headers(session),
        body: SafeJSON.stringify({ payload: { limit } }),
    });
    const body = (await res.json()) as ApiEnvelope<RecentFire[]>;
    return body.s === "ok" ? body.r : [];
}

export async function deleteAlerts(session: TvSession, alertIds: number[]): Promise<boolean> {
    const url = `${BASE}/delete_alerts?log_username=${encodeURIComponent(session.username)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: headers(session),
        body: SafeJSON.stringify({ payload: { alert_ids: alertIds } }),
    });
    const body = (await res.json()) as ApiEnvelope<unknown>;
    return body.s === "ok";
}
