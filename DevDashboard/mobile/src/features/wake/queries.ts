import { type DashboardClient, ENDPOINTS, type HealthDto, type WakeRelayDto } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import { queryOptions } from "@tanstack/react-query";
import type { RelayStore } from "@/features/wake/relay-store";
import { timeoutSignal } from "@/lib/abort-timeout";

export const wakeKeys = { relay: ["wake", "relay"] as const, health: ["wake", "health"] as const };

/** How often the screen asks the Mac whether it is awake after a wake was sent. */
export const HEALTH_INTERVAL_MS = 3_000;
/** A Mac that has not answered this long after a wake is reported as still asleep. */
export const WAKE_PATIENCE_MS = 120_000;

/**
 * The relay as the Mac last described it. A sleeping Mac answers nothing, so the screen falls back to the stored copy.
 * `fixture` is true when the client is the fixture client (no transport): its made-up relay is never saved over a
 * Mac's real one, and for a chosen Mac whose transport did not build the query does not run, so its saved copy shows.
 */
export function relayQuery({
    client,
    connectionId,
    store,
    fixture,
}: {
    client: DashboardClient;
    connectionId: string | null;
    store: RelayStore;
    fixture: boolean;
}) {
    return queryOptions<WakeRelayDto>({
        queryKey: [...wakeKeys.relay, connectionId, fixture],
        queryFn: async () => {
            const relay = await client.call(ENDPOINTS.gatewayWake, {});

            if (connectionId !== null && !fixture) {
                await store.save(connectionId, relay);
            }

            return relay;
        },
        enabled: !fixture || connectionId === null,
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
            body: SafeJSON.stringify({ name: relay.name, password: relay.password }),
        },
    };
}

/** Whether a relay's answer is its acknowledgment, `{ ok: true }` (`src/wakeup/lib/server.ts`). */
function relayAcknowledged(text: string): boolean {
    try {
        const parsed: unknown = SafeJSON.parse(text, { strict: true });
        return typeof parsed === "object" && parsed !== null && Reflect.get(parsed, "ok") === true;
    } catch {
        // Not JSON (an HTML page, an empty body): no acknowledgment.
        return false;
    }
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

    const signal = timeoutSignal(10_000);

    try {
        const response = await fetchFn(request.url, { ...request.init, signal });
        const text = await response.text();

        if (!response.ok) {
            return { sent: false, detail: `The relay answered ${response.status}: ${text.slice(0, 120)}` };
        }

        // Any 2xx is not proof: a wrong relay URL can answer 200 with a web page. Only `{ ok: true }` says it was sent.
        if (!relayAcknowledged(text)) {
            return { sent: false, detail: `The relay did not confirm the wake packet: ${text.slice(0, 120)}` };
        }

        return { sent: true, detail: "The relay sent the wake packet. Waiting for the Mac to answer." };
    } catch (error) {
        if (signal.aborted) {
            return { sent: false, detail: "The wake relay request timed out. Try again when the relay is reachable." };
        }

        return {
            sent: false,
            detail: `Could not reach the relay: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
