import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "./constants.ts";
import { gatewayServerUrl, isGatewayProjectedUrl, projectServerForHarness } from "./project.ts";

const listen = { host: "127.0.0.1", port: 8318 };

const rohlik = {
    type: "http" as const,
    url: "https://mcp.rohlik.cz/mcp",
    auth: {
        kind: "oauth" as const,
        gateway: true,
        resource: "https://mcp.rohlik.cz/mcp",
    },
    _meta: { enabled: { grok: true } },
};

describe("projectServerForHarness", () => {
    test("HTTP harnesses get loopback url and local header, never the upstream url", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "grok",
            localToken: "tok",
            listen,
        });

        expect(projected.url).toBe("http://127.0.0.1:8318/mcp/rohlik");
        expect(projected.headers?.[GATEWAY_HEADER]).toBe("tok");
        expect(projected.auth).toBeUndefined();
        expect(projected.url).not.toContain("rohlik.cz");
    });

    test("Cursor gets a stdio trampoline, not an HTTP url", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "cursor",
            localToken: "tok",
            listen,
        });

        expect(projected.type).toBe("stdio");
        expect(projected.command).toBe("tools");
        expect(projected.args).toEqual(["mcp-manager", "gateway", "stdio", "--server", "rohlik"]);
        expect(projected.url).toBeUndefined();
    });

    test("non-gateway servers keep their url and drop auth", () => {
        const projected = projectServerForHarness(
            "jina",
            { type: "http", url: "https://mcp.jina.ai/v1", auth: { kind: "bearer" } },
            { provider: "claude", localToken: "tok", listen }
        );

        expect(projected.url).toBe("https://mcp.jina.ai/v1");
        expect(projected.auth).toBeUndefined();
        expect(projected.headers).toBeUndefined();
    });
});

describe("isGatewayProjectedUrl", () => {
    test("matches the loopback path for that server", () => {
        expect(isGatewayProjectedUrl(gatewayServerUrl(listen, "rohlik"), listen, "rohlik")).toBe(true);
        expect(isGatewayProjectedUrl("https://mcp.rohlik.cz/mcp", listen, "rohlik")).toBe(false);
    });
});
