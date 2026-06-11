import type { DashboardClient } from "@dd/contract";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { mockDashboardClient } from "@/api/mock-client";
import { useConnectionStore } from "@/state/connection-store";

interface ClientContextValue {
    /** The active dashboard client: the connected transport's tier-correct client, or the mock. */
    client: DashboardClient;
    /** True when no transport is connected and the mock client is serving fixtures. */
    isMock: boolean;
}

const ClientContext = createContext<ClientContextValue | null>(null);

/**
 * Exposes the ACTIVE `@dd/contract` dashboard client to the whole app (D32). When a transport is
 * connected we use `transport.client()` — NOT a hand-built `createDashboardClient` — because the
 * transport's own client is tier-correct (e.g. the managed tier returns an E2E-wrapped client, so
 * the relay only ever sees ciphertext; a plain client would bypass that). When nothing is
 * connected we fall back to the `mockDashboardClient` so screens render fixtures immediately.
 *
 * Mock↔real is swapped HERE, at the client, exactly once — the hooks and components never know
 * which one they're talking to.
 */
export function ClientProvider({ children }: { children: ReactNode }) {
    const transport = useConnectionStore((s) => s.transport);

    const value = useMemo<ClientContextValue>(() => {
        if (transport) {
            return { client: transport.client(), isMock: false };
        }

        return { client: mockDashboardClient, isMock: true };
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
