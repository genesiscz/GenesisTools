import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * The two properties a saved connection has to keep across a restart and an edit: a managed pairing
 * keeps the agent's public key (without it the transport cannot be rebuilt at all), and editing the
 * host of a tunnel row keeps its scheme and path (rewriting it as `http://host:port` downgraded an
 * HTTPS relay to cleartext on port 443).
 *
 * `store.ts` statically imports expo-secure-store, expo-sqlite/kv-store and the four transport
 * tiers, none of which load under bun; they are stubbed so the pure store logic is reachable.
 */

const kv = new Map<string, string>();
const secure = new Map<string, string>();
let managedPairing: unknown = null;

mock.module("expo-sqlite/kv-store", () => ({
    default: {
        getItem: async (k: string) => kv.get(k) ?? null,
        setItem: async (k: string, v: string) => {
            kv.set(k, v);
        },
        removeItem: async (k: string) => {
            kv.delete(k);
        },
    },
}));

mock.module("expo-secure-store", () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
    getItemAsync: async (k: string) => secure.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => {
        secure.set(k, v);
    },
    deleteItemAsync: async (k: string) => {
        secure.delete(k);
    },
}));

mock.module("@/transport/tiers/managed", () => ({
    createManagedTransport: async (pairing: unknown) => {
        managedPairing = pairing;
        return { tier: "managed" };
    },
}));
mock.module("@/transport/tiers/lan", () => ({ createLanTransport: async () => ({ tier: "lan" }) }));
mock.module("@/transport/tiers/tailscale", () => ({ createTailscaleTransport: async () => ({ tier: "tailscale" }) }));
mock.module("@/transport/tiers/cloudflared", () => ({
    createCloudflaredTransport: async () => ({ tier: "cloudflared-self" }),
}));

const { buildTransportFor, getConnection, loadConnections, updateConnection, upsertConnection } = await import(
    "@/features/connections/store"
);

beforeEach(() => {
    kv.clear();
    secure.clear();
    managedPairing = null;
});

describe("upsertConnection — managed pairings", () => {
    it("persists the agent public key and hands it back to the transport builder", async () => {
        const id = await upsertConnection({
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
            agentPublicKey: "QUJD",
        });

        // Survives the kv round-trip, which is what a restart replays.
        const restored = (await loadConnections()).find((c) => c.id === id);
        expect(restored?.agentPublicKey).toBe("QUJD");

        await buildTransportFor(restored!);
        expect(managedPairing).toMatchObject({ tier: "managed", agentPublicKey: "QUJD" });
    });

    it("keeps the stored key when a later upsert does not carry one", async () => {
        const id = await upsertConnection({
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
            agentPublicKey: "QUJD",
        });
        await upsertConnection({
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
        });

        expect((await getConnection(id))?.agentPublicKey).toBe("QUJD");
    });
});

describe("updateConnection — baseUrl rebuild", () => {
    async function seed(tier: "lan" | "cloudflared-self", baseUrl: string): Promise<string> {
        return upsertConnection({ tier, baseUrl, host: new URL(baseUrl).hostname, port: 443, username: "" });
    }

    it("keeps https and the path when a tunnel connection's host is edited", async () => {
        const id = await seed("cloudflared-self", "https://relay.example.com/a");
        const updated = await updateConnection(id, { host: "new.example.com" });

        expect(updated?.baseUrl).toBe("https://new.example.com/a");
    });

    it("keeps the scheme when only the port is edited", async () => {
        const id = await seed("cloudflared-self", "https://relay.example.com");
        const updated = await updateConnection(id, { port: 8443 });

        expect(updated?.baseUrl).toBe("https://relay.example.com:8443");
    });

    it("still rebuilds a LAN row as http://host:port", async () => {
        const id = await seed("lan", "http://192.168.1.10");
        const updated = await updateConnection(id, { host: "192.168.1.20", port: 3042 });

        expect(updated?.baseUrl).toBe("http://192.168.1.20:3042");
    });

    it("leaves baseUrl alone when neither host nor port changed", async () => {
        const id = await seed("cloudflared-self", "https://relay.example.com/a");
        const updated = await updateConnection(id, { label: "renamed" });

        expect(updated?.baseUrl).toBe("https://relay.example.com/a");
    });

    it("prefers an explicit baseUrl patch over the rebuild", async () => {
        const id = await seed("cloudflared-self", "https://relay.example.com");
        const updated = await updateConnection(id, { host: "ignored.example.com", baseUrl: "https://exact.example.com" });

        expect(updated?.baseUrl).toBe("https://exact.example.com");
    });
});
