import { create } from "zustand";
import {
    buildTransportFor,
    deleteConnection as deleteSavedConnection,
    getActiveConnectionId,
    getConnection,
    loadConnections,
    markActivated,
    targetOf,
    updateConnection as updateSavedConnection,
    upsertConnection,
} from "@/features/connections/store";
import type {
    SavedConnection,
    SavedConnectionInput,
    SavedConnectionPatch,
} from "@/features/connections/types";
import type { ProbeFailure } from "@/transport/reachability";
import { TIERS, type TierCapabilities } from "@/transport/tiers";
import type { Transport, TransportTier } from "@/transport/Transport";

export type ConnStatus = "disconnected" | "connected" | "error";

/**
 * The outcome of a connect or an activation. A failure committed nothing: the old connection stays active, the
 * route gate stays as it was, and nothing about the new target was saved.
 */
export type ConnectResult =
    | { ok: true; id: string }
    | { ok: false; failure: ProbeFailure | "error"; error?: string };

/** A connect: the row to save, plus the one-time device code a tier that pairs by code asks for. */
export interface ConnectInput extends SavedConnectionInput {
    deviceCode?: string;
}

interface ConnectionStoreState {
    tier: TransportTier | null;
    transport: Transport | null;
    connections: SavedConnection[];
    activeId: string | null;
    status: ConnStatus;
    /** Monotonic ownership boundary for cache, subscriptions, and screen-local state. */
    sessionGeneration: number;
    /** False until boot-time `restore()` has resolved — the root layout shows a splash until then. */
    restored: boolean;
    /** Build, pair when the tier asks, probe, and only then save, activate and open the gate. */
    connect: (input: ConnectInput) => Promise<ConnectResult>;
    /** Builds and probes a saved connection, then makes it the active one; a failed probe changes nothing. */
    activate: (id: string) => Promise<ConnectResult>;
    /** Rebuilds the last active connection at launch WITHOUT a probe, so an offline launch still lands in the app. */
    restore: () => Promise<void>;
    listConnections: () => Promise<SavedConnection[]>;
    /** Saves a connection without connecting to it (the Connections screen's add form). */
    addConnection: (input: SavedConnectionInput) => Promise<string>;
    updateConnection: (id: string, patch: SavedConnectionPatch) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

/**
 * The one connection session (M10). Connect means build, probe, then commit: persist, mark active, open the route
 * gate. The pairing path, the Connect screen and the Connections list all go through `connect` or `activate`, so a
 * failed probe can never leave an unreachable Mac active (the pairing rollback is gone with the defect it patched).
 * It replaces the gate's copy store (`state/connection.ts`): the route gate reads `transport` here.
 */
export const useConnectionStore = create<ConnectionStoreState>((set, get) => {
    /**
     * The latest connect or activate. Each attempt takes a number before it pairs, builds and probes; one that is no
     * longer the latest when its probe returns commits nothing, so a slow attempt to A cannot replace B after B won.
     */
    let latestAttempt = 0;
    const SUPERSEDED: ConnectResult = {
        ok: false,
        failure: "error",
        error: "A newer connection attempt replaced this one.",
    };

    /** The commit step: the transport is live from here on. */
    function commit(id: string, transport: Transport, connections: SavedConnection[]): void {
        set((state) => ({
            tier: transport.tier,
            transport,
            activeId: id,
            connections,
            status: "connected",
            sessionGeneration: state.sessionGeneration + 1,
        }));
    }

    async function probed(tier: TransportTier, transport: Transport): Promise<ConnectResult | null> {
        const ok = await transport.reachable();
        return ok ? null : { ok: false, failure: TIERS[tier].probeFailure };
    }

    return {
        tier: null,
        transport: null,
        connections: [],
        activeId: null,
        status: "disconnected",
        sessionGeneration: 0,
        restored: false,

        async connect({ deviceCode, ...input }) {
            const attempt = ++latestAttempt;
            const row = TIERS[input.tier];
            const target = targetOf(input, input.password ?? "");

            try {
                if (row.pairing === "device-code") {
                    await row.pair(target, deviceCode ?? "");
                }

                const transport = await row.build(target);
                const failed = await probed(input.tier, transport);

                if (attempt !== latestAttempt) {
                    return SUPERSEDED;
                }

                if (failed) {
                    return failed;
                }

                const id = await upsertConnection(input);
                await markActivated(id);
                commit(id, transport, await loadConnections());
                return { ok: true, id };
            } catch (err) {
                return { ok: false, failure: "error", error: err instanceof Error ? err.message : String(err) };
            }
        },

        async activate(id) {
            const attempt = ++latestAttempt;
            const conn = await getConnection(id);

            if (!conn) {
                return { ok: false, failure: "error", error: `No saved connection ${id}` };
            }

            try {
                const transport = await buildTransportFor(conn);
                const failed = await probed(conn.tier, transport);

                if (attempt !== latestAttempt) {
                    return SUPERSEDED;
                }

                if (failed) {
                    return failed;
                }

                await markActivated(id);
                commit(id, transport, await loadConnections());
                return { ok: true, id };
            } catch (err) {
                return { ok: false, failure: "error", error: err instanceof Error ? err.message : String(err) };
            }
        },

        async restore() {
            try {
                const connections = await loadConnections();
                const activeId = await getActiveConnectionId();
                set({ connections, activeId });

                if (!activeId) {
                    return;
                }

                const active = connections.find((c) => c.id === activeId);

                if (!active) {
                    console.warn(`[connection-store] active id ${activeId} has no saved connection`);
                    set({ activeId: null });
                    return;
                }

                try {
                    // No probe here on purpose: an offline launch must still land in the app on its last Mac.
                    commit(activeId, await buildTransportFor(active), connections);
                } catch (err) {
                    // Restore failure must never crash the boot path — fall through to /connect.
                    console.warn(`[connection-store] failed to restore connection ${activeId}`, err);
                    set({ status: "error" });
                }
            } finally {
                // Always flip `restored` so the root splash gives way to the resolved gate, even when
                // there was nothing to restore or rebuilding the transport threw.
                set({ restored: true });
            }
        },

        async listConnections() {
            const connections = await loadConnections();
            const activeId = await getActiveConnectionId();
            set({ connections, activeId });
            return connections;
        },

        async addConnection(input) {
            const id = await upsertConnection(input);
            set({ connections: await loadConnections() });
            return id;
        },

        async updateConnection(id, patch) {
            await updateSavedConnection(id, patch);
            const connections = await loadConnections();
            set({ connections });

            // If we edited the live connection, rebuild its transport so the change takes effect now.
            if (get().activeId === id) {
                const conn = connections.find((c) => c.id === id);

                if (conn) {
                    commit(id, await buildTransportFor(conn), connections);
                }
            }
        },

        async remove(id) {
            await deleteSavedConnection(id);
            const connections = await loadConnections();
            const activeId = await getActiveConnectionId();
            set({ connections, activeId });

            // Removing the active connection drops the app back to the connect gate.
            if (get().transport && activeId === null) {
                set((state) => ({
                    tier: null,
                    transport: null,
                    status: "disconnected",
                    sessionGeneration: state.sessionGeneration + 1,
                }));
            }
        },
    };
});

/** What the active connection's tier allows a screen to do; nothing when no Mac is connected. */
export function useTierCapabilities(): TierCapabilities | null {
    const tier = useConnectionStore((s) => s.tier);
    return tier ? TIERS[tier].capabilities : null;
}

/**
 * The base URL a WebView or the system browser may load in plain HTTP, or null when the tier refuses it (the managed
 * relay) or nothing is connected. Screens ask this instead of reading the transport's base URL themselves.
 */
export function usePlainBaseUrl(): string | null {
    const transport = useConnectionStore((s) => s.transport);
    return transport && TIERS[transport.tier].capabilities.plainUrls ? transport.baseUrl() : null;
}
