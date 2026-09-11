import { describe, expect, it, mock } from "bun:test";

// `plain-transport.ts` transitively pulls native modules (`expo/fetch`, `partysocket`,
// `react-native`). Stub them; the test injects its own probe + terminalFactory so neither the
// real fetch nor the real socket are ever constructed.
mock.module("expo/fetch", () => ({ fetch: async () => new Response("") }));
mock.module("partysocket", () => ({ WebSocket: class {} }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));

const { createPlainTransport } = await import("@/transport/plain-transport");

describe("createPlainTransport", () => {
    it("exposes the tier, baseUrl, and authHeader it was built with", () => {
        const t = createPlainTransport({
            tier: "lan",
            baseUrl: "http://192.168.1.5:3042",
            authHeader: () => "Basic abc",
            probe: async () => true,
        });
        expect(t.tier).toBe("lan");
        expect(t.baseUrl()).toBe("http://192.168.1.5:3042");
        expect(t.authHeader()).toBe("Basic abc");
    });

    it("delegates reachable() to the injected probe", async () => {
        let probed = 0;
        const t = createPlainTransport({
            tier: "tailscale",
            baseUrl: "http://mac.tail.ts.net:3042",
            authHeader: () => undefined,
            probe: async () => {
                probed++;
                return false;
            },
        });
        expect(await t.reachable()).toBe(false);
        expect(probed).toBe(1);
    });

    it("openTerminal builds a ws:// URL from an http base", () => {
        const t = createPlainTransport({
            tier: "lan",
            baseUrl: "http://192.168.1.5:3042",
            authHeader: () => undefined,
            probe: async () => true,
            terminalFactory: (o) => ({ wsUrl: o.wsUrl }) as never,
        });
        const term = t.openTerminal("abc-123") as unknown as { wsUrl: string };
        expect(term.wsUrl).toBe("ws://192.168.1.5:3042/ttyd/abc-123/ws");
    });

    it("openTerminal builds wss:// from an https base", () => {
        const t = createPlainTransport({
            tier: "cloudflared-self",
            baseUrl: "https://mac.example.com",
            authHeader: () => undefined,
            probe: async () => true,
            terminalFactory: (o) => ({ wsUrl: o.wsUrl }) as never,
        });
        const term = t.openTerminal("abc-123") as unknown as { wsUrl: string };
        expect(term.wsUrl).toBe("wss://mac.example.com/ttyd/abc-123/ws");
    });
});
