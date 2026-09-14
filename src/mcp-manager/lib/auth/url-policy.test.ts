import { afterEach, describe, expect, test } from "bun:test";
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
        ]) {
            expect(isPrivateHost(host)).toBe(true);
        }
    });

    test("public hosts are not private", () => {
        for (const host of [
            "mcp.figma.com",
            "8.8.8.8",
            "172.32.0.1",
            "172.15.0.1",
            "11.0.0.1",
            "2606:4700::1111",
            "fec0::1",
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

    test("a name that does not resolve is left to fail on its own terms", async () => {
        _setLookupForTest(async () => {
            throw new Error("ENOTFOUND");
        });

        const url = await assertDiscoveryTarget("https://nope.example.com/x", PUBLIC_MCP);

        expect(url.host).toBe("nope.example.com");
    });
});
