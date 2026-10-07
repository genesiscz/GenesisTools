import { afterEach, describe, expect, test } from "bun:test";
import { fetchPinnedPublicUrl, pinnedRequest, untilAborted } from "@genesiscz/utils/net/pinned-fetch";
import { discoverAuthorizationServer } from "./discovery.ts";
import { _resetMcpFetchForTest, _setMcpFetchForTest } from "./fetch.ts";
import {
    _resetLookupForTest,
    _setLookupForTest,
    assertDiscoveryTarget,
    isPrivateHost,
    OutboundUrlPolicyError,
} from "./url-policy.ts";

const PUBLIC_MCP = "https://mcp.figma.com/mcp";

/** The default for tests that are not about DNS: resolve everything to a public address. */
function publicLookup() {
    _setLookupForTest(async () => [{ address: "93.184.216.34" }]);
}

afterEach(() => {
    _resetLookupForTest();
    _resetMcpFetchForTest();
});

describe("authorization server metadata endpoints", () => {
    test("private registration and token endpoints are rejected before a consuming POST", async () => {
        publicLookup();
        let posts = 0;
        _setMcpFetchForTest(async (_input, init) => {
            if (init?.method === "POST") {
                posts += 1;
                throw new Error("credential POST reached");
            }

            return Response.json({
                issuer: "https://identity.example",
                authorization_endpoint: "https://identity.example/authorize",
                token_endpoint: "http://127.0.0.1:3042/token",
                registration_endpoint: "http://[::1]:3042/register",
            });
        });

        await expect(discoverAuthorizationServer("https://identity.example", PUBLIC_MCP)).rejects.toThrow(
            OutboundUrlPolicyError
        );
        expect(posts).toBe(0);
    });

    test("discovery cancels the unread bodies of redirect and error responses", async () => {
        publicLookup();
        let calls = 0;
        let cancelled = 0;
        const body = () =>
            new ReadableStream<Uint8Array>({
                pull: () => undefined,
                cancel: () => {
                    cancelled += 1;
                },
            });
        _setMcpFetchForTest(async (input) => {
            calls += 1;
            const redirect = String(input).endsWith("/start");
            return redirect
                ? new Response(body(), { status: 302, headers: { location: "/missing" } })
                : new Response(body(), { status: 404 });
        });

        await expect(discoverAuthorizationServer("https://identity.example/start", PUBLIC_MCP)).rejects.toThrow();
        expect(calls).toBeGreaterThan(0);
        expect(cancelled).toBe(calls);
    });

    test("a different public authorization-server origin remains valid", async () => {
        publicLookup();
        _setMcpFetchForTest(async () =>
            Response.json({
                issuer: "https://identity.example",
                authorization_endpoint: "https://login.example/authorize",
                token_endpoint: "https://login.example/token",
                registration_endpoint: "https://register.example/client",
            })
        );

        const metadata = await discoverAuthorizationServer("https://identity.example", PUBLIC_MCP);
        expect(metadata.registration_endpoint).toBe("https://register.example/client");
        expect(metadata.token_endpoint).toBe("https://login.example/token");
    });
});

describe("isPrivateHost", () => {
    test("loopback, link-local, private and unique-local are private", () => {
        for (const host of [
            "localhost",
            "app.localhost",
            "printer.local",
            "127.0.0.1",
            "127.1.2.3",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "[::1]",
            "::",
            "fd00::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "feff::1",
            "ff02::1",
            "100.64.0.0",
            "100.127.255.255",
            "100.100.100.200",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "64:ff9b::7f00:1",
            "64:ff9b::a9fe:a9fe",
        ]) {
            expect(isPrivateHost(host)).toBe(true);
        }
    });

    test("the edges just outside the added ranges stay public", () => {
        for (const host of ["100.63.255.255", "100.128.0.0", "192.0.1.1", "198.17.255.255", "198.20.0.0"]) {
            expect(isPrivateHost(host)).toBe(false);
        }
        expect(isPrivateHost("64:ff9b::808:808")).toBe(false);
    });

    test("public hosts are not private", () => {
        for (const host of [
            "mcp.figma.com",
            "8.8.8.8",
            "172.32.0.1",
            "172.15.0.1",
            "11.0.0.1",
            "2606:4700::1111",
            "2001:4860::8888",
        ]) {
            expect(isPrivateHost(host)).toBe(false);
        }
    });
});

/**
 * 🛑 These go through `new URL()` on purpose. The first version of this file checked
 * the dotted spelling of IPv4-mapped IPv6, and `new URL()` rewrites it to hex, so every
 * mapped address — loopback included — walked straight through while a direct
 * isPrivateHost() test passed. A test that never canonicalises proves nothing here.
 */
describe("IPv4-mapped IPv6 survives URL canonicalization", () => {
    test("every mapped private form is still recognised after new URL()", async () => {
        publicLookup();

        for (const literal of [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:192.168.1.10",
            "::ffff:172.16.0.1",
            "::ffff:169.254.169.254",
        ]) {
            const target = `http://[${literal}]/.well-known/oauth-protected-resource`;

            // Proof the rewrite actually happens, so this test cannot silently stop
            // exercising the thing it exists for.
            expect(new URL(target).hostname).not.toContain(".");
            await expect(assertDiscoveryTarget(target, PUBLIC_MCP)).rejects.toThrow(OutboundUrlPolicyError);
        }
    });

    test("a mapped PUBLIC address is still allowed", async () => {
        publicLookup();

        const url = await assertDiscoveryTarget("http://[::ffff:8.8.8.8]/x", PUBLIC_MCP);

        expect(url.hostname).toBe("[::ffff:808:808]");
    });
});

describe("assertDiscoveryTarget", () => {
    test("a public MCP server may not aim discovery at the cloud metadata address", async () => {
        publicLookup();

        await expect(assertDiscoveryTarget("http://169.254.169.254/latest/meta-data/", PUBLIC_MCP)).rejects.toThrow(
            OutboundUrlPolicyError
        );
    });

    test("a public MCP server may not aim discovery at loopback or the LAN", async () => {
        publicLookup();

        for (const target of [
            "http://127.0.0.1:8318/.well-known/oauth-protected-resource",
            "http://localhost:9200/",
            "https://192.168.1.10/.well-known/oauth-authorization-server",
            "http://[::1]:8318/",
        ]) {
            await expect(assertDiscoveryTarget(target, PUBLIC_MCP)).rejects.toThrow(OutboundUrlPolicyError);
        }
    });

    test("non-http schemes are refused whatever the origin", async () => {
        publicLookup();

        await expect(assertDiscoveryTarget("file:///etc/passwd", PUBLIC_MCP)).rejects.toThrow(/scheme file:/);
        await expect(assertDiscoveryTarget("file:///etc/passwd", "http://127.0.0.1:9/mcp")).rejects.toThrow(
            /scheme file:/
        );
    });

    test("garbage is refused rather than fetched", async () => {
        publicLookup();

        await expect(assertDiscoveryTarget("/.well-known/oauth-protected-resource", PUBLIC_MCP)).rejects.toThrow(
            /not a valid absolute URL/
        );
    });

    test("a public server reaching other public hosts is the normal Figma case", async () => {
        publicLookup();

        const url = await assertDiscoveryTarget(
            "https://api.figma.com/.well-known/oauth-authorization-server",
            PUBLIC_MCP
        );

        expect(url.host).toBe("api.figma.com");
    });

    test("a loopback MCP server keeps working — it is already inside the boundary", async () => {
        const local = "http://127.0.0.1:9331/mcp";
        // Proves the DNS guard is SKIPPED for a private origin: a lookup that would
        // reject is installed, and these still pass.
        _setLookupForTest(async () => [{ address: "127.0.0.1" }]);

        expect((await assertDiscoveryTarget("http://127.0.0.1:9331/.well-known/x", local)).port).toBe("9331");
        expect((await assertDiscoveryTarget("http://localhost:9332/token", local)).hostname).toBe("localhost");
    });
});

/**
 * A literal-host check is not an SSRF control on its own: a public NAME can carry a
 * private A record, and nothing in the URL text says so.
 */
describe("DNS resolution is validated, not just the hostname text", () => {
    test("a public name resolving to loopback is refused", async () => {
        _setLookupForTest(async () => [{ address: "127.0.0.1" }]);

        await expect(assertDiscoveryTarget("https://evil.example.com/.well-known/x", PUBLIC_MCP)).rejects.toThrow(
            /resolves to the private address 127\.0\.0\.1/
        );
    });

    test("a public name resolving to the cloud metadata address is refused", async () => {
        _setLookupForTest(async () => [{ address: "169.254.169.254" }]);

        await expect(assertDiscoveryTarget("https://evil.example.com/x", PUBLIC_MCP)).rejects.toThrow(
            OutboundUrlPolicyError
        );
    });

    test("ONE private answer among several public ones is enough to refuse", async () => {
        _setLookupForTest(async () => [
            { address: "93.184.216.34" },
            { address: "2606:4700::1111" },
            { address: "10.1.2.3" },
        ]);

        await expect(assertDiscoveryTarget("https://evil.example.com/x", PUBLIC_MCP)).rejects.toThrow(
            /resolves to the private address 10\.1\.2\.3/
        );
    });

    test("a mapped private answer is caught too", async () => {
        _setLookupForTest(async () => [{ address: "::ffff:192.168.0.9" }]);

        await expect(assertDiscoveryTarget("https://evil.example.com/x", PUBLIC_MCP)).rejects.toThrow(
            OutboundUrlPolicyError
        );
    });

    test("an all-public resolution passes", async () => {
        _setLookupForTest(async () => [{ address: "93.184.216.34" }, { address: "2606:4700::1111" }]);

        const url = await assertDiscoveryTarget("https://api.figma.com/x", PUBLIC_MCP);

        expect(url.host).toBe("api.figma.com");
    });

    test("a name that does not resolve is rejected before a request", async () => {
        _setLookupForTest(async () => {
            throw new Error("ENOTFOUND");
        });

        await expect(assertDiscoveryTarget("https://nope.example.com/x", PUBLIC_MCP)).rejects.toThrow(
            /DNS resolution failed/
        );
    });

    test("a pinned fetch passes the approved address to the connector without a second lookup", async () => {
        let lookups = 0;
        _setLookupForTest(async () => {
            lookups += 1;
            return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1" }];
        });
        const seen: string[] = [];

        const response = await fetchPinnedPublicUrl({
            target: "https://public.example/page",
            request: async ({ address }) => {
                seen.push(address);
                return new Response("ok");
            },
        });

        expect(await response.text()).toBe("ok");
        expect(seen).toEqual(["93.184.216.34"]);
        expect(lookups).toBe(1);
    });

    test("the pinned connector turns a 204 or 304 reply into a body-less Response instead of throwing", async () => {
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: (request) => new Response(null, { status: request.url.endsWith("/304") ? 304 : 204 }),
        });
        try {
            for (const status of [204, 304]) {
                const response = await pinnedRequest({
                    url: new URL(`http://empty.example:${server.port}/${status}`),
                    address: "127.0.0.1",
                });

                expect(response.status).toBe(status);
                expect(response.body).toBeNull();
            }
        } finally {
            server.stop(true);
        }
    });

    test("the pinned connector sends a POST body to the pinned address under the original Host", async () => {
        const received: Array<{ method: string; host: string | null; body: string }> = [];
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (request) => {
                received.push({
                    method: request.method,
                    host: request.headers.get("host"),
                    body: await request.text(),
                });
                return Response.json({ access_token: "t" });
            },
        });
        try {
            const response = await pinnedRequest({
                url: new URL(`http://token.example:${server.port}/token`),
                address: "127.0.0.1",
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "grant_type=refresh_token&refresh_token=r1",
            });

            expect(await response.json()).toEqual({ access_token: "t" });
            expect(received).toEqual([
                {
                    method: "POST",
                    host: `token.example:${server.port}`,
                    body: "grant_type=refresh_token&refresh_token=r1",
                },
            ]);
        } finally {
            server.stop(true);
        }
    });
});

describe("bounded endpoint validation", () => {
    test("a stalled DNS lookup ends the check at its deadline instead of hanging", async () => {
        _setLookupForTest(() => new Promise(() => undefined));

        await expect(
            assertDiscoveryTarget("https://stalled.example/token", PUBLIC_MCP, { timeoutMs: 20 })
        ).rejects.toThrow();
    });
});

describe("untilAborted", () => {
    test("a lookup that rejects after an already-aborted signal is still observed", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            let rejectLookup: (error: Error) => void = () => {};
            const lookup = new Promise<string[]>((_, reject) => {
                rejectLookup = reject;
            });

            await expect(untilAborted(lookup, AbortSignal.abort(new Error("caller gave up")))).rejects.toThrow(
                "caller gave up"
            );
            rejectLookup(new Error("late DNS failure"));
            await Bun.sleep(10);

            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
