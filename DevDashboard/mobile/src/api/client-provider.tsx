import type { DashboardClient } from "@dd/contract";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { useConnectionStore } from "@/state/connection-store";

interface ClientContextValue {
    /** The active dashboard client: the connected transport's tier-correct client, or the mock. */
    client: DashboardClient;
    /** True when no transport is connected and the client runs over the fixture wire. */
    isMock: boolean;
}

const ClientContext = createContext<ClientContextValue | null>(null);

/**
 * Exposes the ACTIVE `@dd/contract` dashboard client to the whole app (D32). When a transport is
 * connected we use `transport.client()` — NOT a hand-built `createDashboardClient` — because the
 * transport's own client is tier-correct (e.g. the managed tier returns an E2E-wrapped client, so
 * the relay only ever sees ciphertext; a plain client would bypass that). When nothing is
 * connected we use the same real contract client over the fixture wire (`fixtureDashboardClient`),
 * so screens render fixtures immediately and run the real client's parsing and stream demux.
 *
 * Fixture↔real is swapped HERE, at the client's wire, exactly once — the hooks and components
 * never know which one they're talking to (D32).
 */
export function ClientProvider({ children }: { children: ReactNode }) {
    const transport = useConnectionStore((s) => s.transport);

    const value = useMemo<ClientContextValue>(() => {
        if (transport) {
            return { client: transport.client(), isMock: false };
        }

        return { client: fixtureDashboardClient, isMock: true };
    }, [transport]);

    return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

function useClientContext(): ClientContextValue {
    const ctx = useContext(ClientContext);
    if (!ctx) {
        throw new Error("useDashboardClient must be used within a <ClientProvider>");
    }

    return ctx;
}

/** The active dashboard client (real or mock). Query factories close over this — see queries.ts. */
export function useDashboardClient(): DashboardClient {
    return useClientContext().client;
}

/** True when the mock client is active (no device connected) — drives the "mock data" badge. */
export function useIsMockClient(): boolean {
    return useClientContext().isMock;
}
