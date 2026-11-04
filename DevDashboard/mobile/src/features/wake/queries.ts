import { type DashboardClient, ENDPOINTS, type HealthDto, type WakeRelayDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const wakeKeys = { relay: ["wake", "relay"] as const, health: ["wake", "health"] as const };

/** How often the screen asks the Mac whether it is awake after a wake was sent. */
export const HEALTH_INTERVAL_MS = 3_000;
/** A Mac that has not answered this long after a wake is reported as still asleep. */
export const WAKE_PATIENCE_MS = 120_000;

/** The relay as the Mac last described it. A sleeping Mac answers nothing, so the screen falls back to the stored copy. */
export function relayQuery(client: DashboardClient) {
    return queryOptions<WakeRelayDto>({
        queryKey: wakeKeys.relay,
        queryFn: () => client.call(ENDPOINTS.gatewayWake, {}),
        retry: false,
    });
}

export function healthQuery(client: DashboardClient) {
    return queryOptions<HealthDto>({
        queryKey: wakeKeys.health,
        queryFn: () => client.call(ENDPOINTS.health, {}),
        retry: false,
    });
}

/** The relay's `/wake` request for this Mac's registered device; null when the relay has no login for it. */
export function wakeRequest(relay: WakeRelayDto | null): { url: string; init: RequestInit } | null {
    if (!relay?.configured || !relay.url || !relay.name || !relay.password) {
        return null;
    }

    return {
        url: `${relay.url.replace(/\/$/, "")}/wake`,
        init: {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(relay.token ? { Authorization: `Bearer ${relay.token}` } : {}),
            },
            body: JSON.stringify({ name: relay.name, password: relay.password }),
        },
    };
}

export interface WakeOutcome {
    sent: boolean;
    detail: string;
}

/** Posts the relay's `/wake`. The relay answers `{ ok: true }` once it sent the magic packet. */
export async function sendWake(
    relay: WakeRelayDto | null,
    fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<WakeOutcome> {
    const request = wakeRequest(relay);

    if (!request) {
        return { sent: false, detail: relay?.note ?? "No wakeup relay is set for this Mac." };
    }

    try {
        const response = await fetchFn(request.url, request.init);
        const text = await response.text();

        if (!response.ok) {
            return { sent: false, detail: `The relay answered ${response.status}: ${text.slice(0, 120)}` };
        }

        return { sent: true, detail: "The relay sent the wake packet. Waiting for the Mac to answer." };
    } catch (error) {
        return { sent: false, detail: `Could not reach the relay: ${error instanceof Error ? error.message : String(error)}` };
    }
}
