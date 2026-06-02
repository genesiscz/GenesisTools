import type { PairingPayload } from "@dd/contract";
import { create } from "zustand";
import {
    buildTransportFor,
    deleteConnection as deleteSavedConnection,
    getActiveConnectionId,
    getConnection,
    loadConnections,
    markActivated,
    updateConnection as updateSavedConnection,
    upsertConnection,
} from "@/features/connections/store";
import type {
    SavedConnection,
    SavedConnectionInput,
    SavedConnectionPatch,
} from "@/features/connections/types";
import { useConnection } from "@/state/connection";
import type { DiscoveredAgent } from "@/transport/lan-discovery";
import type { LanCredentials } from "@/transport/tiers/lan";
import type { Transport, TransportTier } from "@/transport/Transport";

export interface TailscaleSettings {
    tailnetHost: string;
    port: number;
    username: string;
    password: string;
}

interface ConnectionStoreState {
    tier: TransportTier | null;
    transport: Transport | null;
    connections: SavedConnection[];
    activeId: string | null;
    /** False until boot-time `restore()` has resolved — the root layout shows a splash until then. */
    restored: boolean;
    setLan: (agent: DiscoveredAgent, creds: LanCredentials) => Promise<void>;
    setTailscale: (cfg: TailscaleSettings) => Promise<void>;
    setCloudflared: (pairing: PairingPayload, password: string) => Promise<void>;
    setManaged: (pairing: PairingPayload) => Promise<void>;
    restore: () => Promise<void>;
    listConnections: () => Promise<SavedConnection[]>;
    addConnection: (input: SavedConnectionInput) => Promise<string>;
    activateConnection: (id: string) => Promise<void>;
    updateConnection: (id: string, patch: SavedConnectionPatch) => Promise<void>;
    removeConnection: (id: string) => Promise<void>;
}

/**
 * Bridges a transport into the foundation `useConnection` store so the root layout's
 * `Stack.Protected guard={baseUrl !== null}` gate opens after a successful connect. The transport
 * object lives only here (richer than the gate's primitive baseUrl/authHeader).
 */
function publishToGate(transport: Transport): void {
    const conn = useConnection.getState();
    conn.setEndpoint(transport.tier, transport.baseUrl(), transport.authHeader() ?? null);
    conn.setStatus("connected");
}

export const useConnectionStore = create<ConnectionStoreState>((set, get) => ({
    tier: null,
    transport: null,
    connections: [],
    activeId: null,
    restored: false,

    async setLan(agent, creds) {
        const id = await upsertConnection({
            tier: "lan",
            label: agent.name,
            baseUrl: agent.baseUrl,
            host: agent.host,
            port: agent.port,
            username: creds.username,
            password: creds.password,
        });
        await get().activateConnection(id);
    },

    async setTailscale(cfg) {
        const baseUrl = `http://${cfg.tailnetHost}:${cfg.port}`;
        const id = await upsertConnection({
            tier: "tailscale",
            baseUrl,
            host: cfg.tailnetHost,
            port: cfg.port,
            username: cfg.username,
            password: cfg.password,
        });
        await get().activateConnection(id);
    },

    async setCloudflared(pairing, password) {
        const base = pairing.baseUrl.replace(/\/+$/, "");
        const url = new URL(base);
        const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
        const id = await upsertConnection({
            tier: "cloudflared-self",
            baseUrl: base,
            host: url.hostname,
            port,
            username: pairing.username ?? "",
            password,
        });
        await get().activateConnection(id);
    },

    async setManaged(pairing) {
        const base = pairing.baseUrl.replace(/\/+$/, "");
        const url = new URL(base);
        const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
        const id = await upsertConnection({
            tier: "managed",
            baseUrl: base,
            host: url.hostname,
            port,
            username: "",
        });
        await get().activateConnection(id);
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
                const transport = await buildTransportFor(active);
                publishToGate(transport);
                set({ tier: transport.tier, transport });
            } catch (err) {
                // Restore failure must never crash the boot path — fall through to /connect.
                console.warn(`[connection-store] failed to restore connection ${activeId}`, err);
                useConnection.getState().setStatus("error");
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
        set({ connections: await loadConnections(), activeId: id });
        return id;
    },

    async activateConnection(id) {
        const conn = await getConnection(id);

        if (!conn) {
            throw new Error(`No saved connection ${id}`);
        }

        const transport = await buildTransportFor(conn);
        await markActivated(id);
        publishToGate(transport);
        set({
            tier: transport.tier,
            transport,
            activeId: id,
            connections: await loadConnections(),
        });
    },

    async updateConnection(id, patch) {
        await updateSavedConnection(id, patch);
        const connections = await loadConnections();
        set({ connections });

        // If we edited the live connection, rebuild its transport so the change takes effect now.
        if (get().activeId === id) {
            const conn = connections.find((c) => c.id === id);

            if (conn) {
                const transport = await buildTransportFor(conn);
                publishToGate(transport);
                set({ tier: transport.tier, transport });
            }
        }
    },

    async removeConnection(id) {
        await deleteSavedConnection(id);
        const connections = await loadConnections();
        const activeId = await getActiveConnectionId();
        set({ connections, activeId });

        // Removing the active connection drops the app back to the connect gate.
        if (get().transport && get().activeId === null) {
            set({ tier: null, transport: null });
            useConnection.getState().reset();
        }
    },
}));
