import { createDashboardClient, type DashboardClient } from "@dd/contract";
import { useConnection } from "@/state/connection";
import { makeExpoEventSource } from "@/lib/sse";
import { fetch as expoFetch } from "expo/fetch";

/**
 * Build a contract client for the currently-connected endpoint. `baseUrl` and
 * `authHeader` are read live from the connection store at call time (and the auth header
 * is re-read per request / per SSE connect), so a re-pair or tier switch is picked up
 * without rebuilding the client.
 */
export function buildClient(): DashboardClient {
    const { baseUrl } = useConnection.getState();

    if (!baseUrl) {
        throw new Error("Not connected");
    }

    return createDashboardClient({
        baseUrl,
        fetch: expoFetch as unknown as typeof fetch,
        authHeader: () => useConnection.getState().authHeader ?? undefined,
        eventSourceFactory: (url) => makeExpoEventSource(url, useConnection.getState().authHeader),
    });
}
