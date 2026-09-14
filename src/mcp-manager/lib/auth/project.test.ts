import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "./constants.ts";
import {
    gatewayBaseUrl,
    gatewayServerUrl,
    isGatewayProjectedStdio,
    isGatewayProjectedUrl,
    isGatewayProjection,
    projectServerForHarness,
    restoreProjectedServer,
} from "./project.ts";

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

describe("isGatewayProjectedStdio", () => {
    test("recognises Cursor's trampoline for that exact server", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "cursor",
            localToken: "tok",
            listen,
        });

        expect(isGatewayProjectedStdio(projected, "rohlik")).toBe(true);
        expect(isGatewayProjectedStdio(projected, "figma")).toBe(false);
    });

    test("a trailing argument means the user wrote it, not us", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "cursor",
            localToken: "tok",
            listen,
        });
        const userEdited = { ...projected, args: [...(projected.args ?? []), "--verbose"] };

        // A prefix match classified this as ours, and sync-from-providers then replaced
        // the user's own flag with the stored definition before conflict detection.
        expect(isGatewayProjectedStdio(userEdited, "rohlik")).toBe(false);
        expect(isGatewayProjection(userEdited, listen, "rohlik")).toBe(false);
    });

    test("a truncated argument list is not a projection either", () => {
        expect(isGatewayProjectedStdio({ command: "tools", args: ["mcp-manager", "gateway", "stdio"] }, "rohlik")).toBe(
            false
        );
    });

    test("a user's own stdio server is not a projection", () => {
        expect(isGatewayProjectedStdio({ type: "stdio", command: "npx", args: ["-y", "some-mcp"] }, "rohlik")).toBe(
            false
        );
        expect(isGatewayProjectedStdio({ type: "http", url: "https://mcp.rohlik.cz/mcp" }, "rohlik")).toBe(false);
    });
});

describe("isGatewayProjection", () => {
    test("true for BOTH shapes projectServerForHarness writes", () => {
        for (const provider of ["grok", "cursor"] as const) {
            const projected = projectServerForHarness("rohlik", rohlik, { provider, localToken: "tok", listen });

            expect(isGatewayProjection(projected, listen, "rohlik")).toBe(true);
        }
    });

    test("false for the stored upstream definition", () => {
        expect(isGatewayProjection(rohlik, listen, "rohlik")).toBe(false);
    });
});

describe("restoreProjectedServer round trip", () => {
    test("a Cursor projection restores to the stored url AND auth", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "cursor",
            localToken: "tok",
            listen,
        });

        expect(isGatewayProjection(projected, listen, "rohlik")).toBe(true);
        restoreProjectedServer(projected, rohlik);

        expect(projected.url).toBe("https://mcp.rohlik.cz/mcp");
        expect(projected.auth).toEqual(rohlik.auth);
        // The trampoline keys must be GONE, not sitting on top of the restored url.
        expect(projected.command).toBeUndefined();
        expect(projected.args).toBeUndefined();
        expect(projected.type).toBe("http");
    });

    test("an HTTP projection restores without keeping the loopback header", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "grok",
            localToken: "tok",
            listen,
        });
        restoreProjectedServer(projected, rohlik);

        expect(projected.url).toBe("https://mcp.rohlik.cz/mcp");
        expect(projected.headers).toBeUndefined();
        expect(projected.auth).toEqual(rohlik.auth);
    });

    test("_meta belongs to the caller and survives untouched", () => {
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "grok",
            localToken: "tok",
            listen,
        });
        projected._meta = { enabled: { cursor: false } };
        restoreProjectedServer(projected, rohlik);

        expect(projected._meta).toEqual({ enabled: { cursor: false } });
    });
});

describe("gatewayBaseUrl", () => {
    test("brackets an IPv6 host so the URL parses and the port survives", () => {
        expect(gatewayBaseUrl({ host: "::1", port: 8318 })).toBe("http://[::1]:8318");
        expect(new URL(gatewayBaseUrl({ host: "::1", port: 8318 })).port).toBe("8318");
        // Already bracketed stays as-is rather than becoming [[::1]].
        expect(gatewayBaseUrl({ host: "[::1]", port: 8318 })).toBe("http://[::1]:8318");
        expect(gatewayBaseUrl({ host: "127.0.0.1", port: 8318 })).toBe("http://127.0.0.1:8318");
    });

    test("an IPv6 projection is a URL a harness can actually use", () => {
        const v6 = { host: "::1", port: 8318 };
        const projected = projectServerForHarness("rohlik", rohlik, {
            provider: "grok",
            localToken: "tok",
            listen: v6,
        });

        expect(() => new URL(projected.url ?? "")).not.toThrow();
        expect(new URL(projected.url ?? "").pathname).toBe("/mcp/rohlik");
        expect(isGatewayProjection(projected, v6, "rohlik")).toBe(true);
    });
});
