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
/** Hosts whose probe fails; every other host answers. */
const offline = new Set<string>();
/** The probe deadline each plain tier was built with. */
const timeouts: Record<string, number> = {};
const paired: string[] = [];
/** Hosts whose probe waits until the test releases it. */
const held = new Map<string, Promise<void>>();

function transport(tier: string, host = `${tier}.example.test`) {
    return {
        tier,
        baseUrl: () => `http://${host}`,
        authHeader: () => undefined,
        reachable: async () => {
            await held.get(host);
            return !offline.has(host);
        },
    };
}

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
    createManagedTransport: async (pairing: unknown, timeoutMs: number) => {
        managedPairing = pairing;
        timeouts.managed = timeoutMs;
        return transport("managed");
    },
    pairManagedDevice: async ({ deviceCode }: { deviceCode: string }) => {
        if (deviceCode !== "123456") {
            throw new Error("The Mac refused the pairing code");
        }

        paired.push(deviceCode);
    },
}));
mock.module("@/transport/tiers/lan", () => ({
    createLanTransport: (agent: { host: string }, _creds: unknown, timeoutMs: number) => {
        timeouts.lan = timeoutMs;
        return transport("lan", agent.host);
    },
}));
mock.module("@/transport/tiers/tailscale", () => ({
    createTailscaleTransport: (config: { tailnetHost: string }, timeoutMs: number) => {
        timeouts.tailscale = timeoutMs;
        return transport("tailscale", config.tailnetHost);
    },
}));
mock.module("@/transport/tiers/cloudflared", () => ({
    createCloudflaredTransport: (_pairing: unknown, _password: string, timeoutMs: number) => {
        timeouts["cloudflared-self"] = timeoutMs;
        return transport("cloudflared-self");
    },
}));

const { buildTransportFor, getActiveConnectionId, getConnection, loadConnections, migrateSavedConnection, updateConnection, upsertConnection } =
    await import("@/features/connections/store");
const { useConnectionStore } = await import("@/state/connection-store");
const { TIERS } = await import("@/transport/tiers");
const { applyPairingUri } = await import("@/lib/apply-pairing");

beforeEach(() => {
    kv.clear();
    secure.clear();
    offline.clear();
    paired.length = 0;
    managedPairing = null;
    useConnectionStore.setState({
        tier: null,
        transport: null,
        connections: [],
        activeId: null,
        status: "disconnected",
        restored: false,
        sessionGeneration: 0,
    });
});

const lanInput = (host: string) => ({
    tier: "lan" as const,
    baseUrl: `http://${host}`,
    host,
    port: 3042,
    username: "work",
});

describe("connection session — probe before commit", () => {
    it("a failed probe leaves the old connection active and saves nothing", async () => {
        const first = await useConnectionStore.getState().connect(lanInput("machine-a.test"));
        expect(first.ok).toBe(true);

        offline.add("machine-b.test");
        const second = await useConnectionStore.getState().connect(lanInput("machine-b.test"));

        expect(second).toEqual({ ok: false, failure: "unreachable" });
        expect(useConnectionStore.getState().transport?.baseUrl()).toBe("http://machine-a.test");
        expect((await loadConnections()).map((c) => c.host)).toEqual(["machine-a.test"]);
        expect(await getActiveConnectionId()).toBe(first.ok ? first.id : null);
    });

    it("a slow attempt that finishes after a newer one commits nothing", async () => {
        let release = () => {};
        held.set("machine-slow.test", new Promise<void>((resolve) => (release = resolve)));

        const slow = useConnectionStore.getState().connect(lanInput("machine-slow.test"));
        const fast = await useConnectionStore.getState().connect(lanInput("machine-fast.test"));
        release();
        const late = await slow;
        held.clear();

        expect(fast.ok).toBe(true);
        expect(late).toEqual({ ok: false, failure: "error", error: "A newer connection attempt replaced this one." });
        expect(useConnectionStore.getState().transport?.baseUrl()).toBe("http://machine-fast.test");
        expect((await loadConnections()).map((c) => c.host)).toEqual(["machine-fast.test"]);
    });

    it("an activate whose row is removed during its probe commits nothing", async () => {
        const kept = await useConnectionStore.getState().connect(lanInput("machine-kept.test"));
        const doomed = await useConnectionStore.getState().connect(lanInput("machine-doomed.test"));
        if (!kept.ok || !doomed.ok) {
            throw new Error("setup connects failed");
        }

        await useConnectionStore.getState().activate(kept.id);
        let release = () => {};
        held.set("machine-doomed.test", new Promise<void>((resolve) => (release = resolve)));
        const pending = useConnectionStore.getState().activate(doomed.id);
        await useConnectionStore.getState().remove(doomed.id);
        release();
        const result = await pending;
        held.clear();

        expect(result.ok).toBe(false);
        expect(useConnectionStore.getState().transport?.baseUrl()).toBe("http://machine-kept.test");
        expect(useConnectionStore.getState().activeId).toBe(kept.id);
    });

    it("a failed first connect keeps the gate closed (no transport, no active id)", async () => {
        offline.add("machine-a.test");
        const result = await useConnectionStore.getState().connect(lanInput("machine-a.test"));

        expect(result.ok).toBe(false);
        expect(useConnectionStore.getState().transport).toBeNull();
        expect(await getActiveConnectionId()).toBeNull();
    });

    it("a tailscale failure asks for the VPN, from the tier table", async () => {
        offline.add("mac.tailnet.ts.net");
        const result = await useConnectionStore
            .getState()
            .connect({ tier: "tailscale", baseUrl: "http://mac.tailnet.ts.net:3042", host: "mac.tailnet.ts.net", port: 3042, username: "work" });

        expect(result).toEqual({ ok: false, failure: "needs-vpn" });
    });

    it("a managed connect pairs with the Mac's code before its probe, and a wrong code commits nothing", async () => {
        const input = {
            tier: "managed" as const,
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
            tierOptions: { managed: { agentPublicKey: "QUJD" } },
        };

        const refused = await useConnectionStore.getState().connect({ ...input, deviceCode: "000000" });
        expect(refused.ok).toBe(false);
        expect(await loadConnections()).toEqual([]);

        const accepted = await useConnectionStore.getState().connect({ ...input, deviceCode: "123456" });
        expect(accepted.ok).toBe(true);
        expect(paired).toEqual(["123456"]);
    });

    it("a pairing link with an address that is not a URL answers a failure instead of throwing", async () => {
        const result = await applyPairingUri("devdashboard://pair?tier=cloudflared-self&baseUrl=not-a-url&username=tester");

        expect(result).toEqual({ ok: false, error: "The pairing link has an invalid address." });
        expect(await loadConnections()).toEqual([]);
    });

    it("a pairing link that fails its probe answers the scanned tier's own failure", async () => {
        // The cloudflared stub's transport answers for its own host.
        offline.add("cloudflared-self.example.test");
        const result = await applyPairingUri(
            "devdashboard://pair?tier=cloudflared-self&baseUrl=https%3A%2F%2Frelay.example.test&username=tester"
        );
        offline.delete("cloudflared-self.example.test");

        expect(result).toMatchObject({ ok: false, failure: TIERS["cloudflared-self"].probeFailure });
    });

    it("each plain tier probes with its own deadline from the table", async () => {
        for (const tier of ["lan", "tailscale", "cloudflared-self"] as const) {
            await buildTransportFor({
                id: `conn_${tier}`,
                label: tier,
                tier,
                baseUrl: "https://host.example.test",
                host: "host.example.test",
                port: 443,
                username: "",
                addedAt: 0,
                lastUsedAt: 0,
            });
            expect(timeouts[tier]).toBe(TIERS[tier].probeTimeoutMs);
        }
    });

    it("the managed tier probes with its own deadline from the table", async () => {
        await buildTransportFor({
            id: "conn_managed",
            label: "managed",
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
            addedAt: 0,
            lastUsedAt: 0,
            tierOptions: { managed: { agentPublicKey: "QUJD" } },
        });
        expect(timeouts.managed).toBe(TIERS.managed.probeTimeoutMs);
    });

    it("the managed tier refuses plain URLs; the others allow them", () => {
        expect(TIERS.managed.capabilities.plainUrls).toBe(false);
        expect(TIERS.lan.capabilities.plainUrls).toBe(true);
    });
});

describe("saved shape migration", () => {
    const old = {
        id: "conn_a",
        label: "relay",
        tier: "managed",
        baseUrl: "https://relay.example.com",
        host: "relay.example.com",
        port: 443,
        username: "",
        agentPublicKey: "QUJD",
        addedAt: 1,
        lastUsedAt: 2,
    };

    it("moves the flat agent key under tierOptions.managed", () => {
        const migrated = migrateSavedConnection(old) as Record<string, unknown>;
        expect(migrated.agentPublicKey).toBeUndefined();
        expect(migrated.tierOptions).toEqual({ managed: { agentPublicKey: "QUJD" } });
    });

    it("is idempotent and leaves the new shape unchanged", () => {
        const once = migrateSavedConnection(old);
        expect(migrateSavedConnection(once)).toEqual(once);
    });

    it("reads an old list from disk into the new shape", async () => {
        kv.set("dd.connections", JSON.stringify([old]));
        const [loaded] = await loadConnections();
        expect(loaded?.tierOptions?.managed?.agentPublicKey).toBe("QUJD");
    });
});

describe("upsertConnection — managed pairings", () => {
    it("persists the agent public key and hands it back to the transport builder", async () => {
        const id = await upsertConnection({
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
            tierOptions: { managed: { agentPublicKey: "QUJD" } },
        });

        // Survives the kv round-trip, which is what a restart replays.
        const restored = (await loadConnections()).find((c) => c.id === id);
        expect(restored?.tierOptions?.managed?.agentPublicKey).toBe("QUJD");

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
            tierOptions: { managed: { agentPublicKey: "QUJD" } },
        });
        await upsertConnection({
            tier: "managed",
            baseUrl: "https://relay.example.com",
            host: "relay.example.com",
            port: 443,
            username: "",
        });

        expect((await getConnection(id))?.tierOptions?.managed?.agentPublicKey).toBe("QUJD");
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

describe("connection session ownership", () => {
    it("advances the session generation whenever a connection is activated", async () => {
        const first = await upsertConnection({
            tier: "lan",
            baseUrl: "http://machine-a.test",
            host: "machine-a.test",
            port: 3042,
            username: "work",
        });
        const second = await upsertConnection({
            tier: "lan",
            baseUrl: "http://machine-b.test",
            host: "machine-b.test",
            port: 3042,
            username: "work",
        });

        await useConnectionStore.getState().activate(first);
        const firstGeneration = useConnectionStore.getState().sessionGeneration;
        await useConnectionStore.getState().activate(second);

        expect(firstGeneration).toBe(1);
        expect(useConnectionStore.getState().sessionGeneration).toBe(2);
        expect(useConnectionStore.getState().activeId).toBe(second);
    });
});
