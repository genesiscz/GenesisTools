import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "@app/mcp-manager/lib/auth/constants.ts";
import { GrokProvider } from "./grok.ts";

describe("GrokProvider.fromUnifiedConfig", () => {
    test("writes url plus headers, not Codex http_headers", () => {
        const provider = new GrokProvider();
        const projected = {
            rohlik: {
                type: "http" as const,
                url: "http://127.0.0.1:8318/mcp/rohlik",
                headers: { [GATEWAY_HEADER]: "local-token" },
                _meta: { enabled: { grok: true } },
            },
        };
        const grok = provider.fromUnifiedConfig(projected) as {
            mcp_servers: Record<string, Record<string, unknown>>;
        };

        expect(grok.mcp_servers.rohlik.url).toBe("http://127.0.0.1:8318/mcp/rohlik");
        expect(grok.mcp_servers.rohlik.headers).toEqual({ [GATEWAY_HEADER]: "local-token" });
        expect(grok.mcp_servers.rohlik.http_headers).toBeUndefined();
        expect(grok.mcp_servers.rohlik.enabled).toBe(true);
    });
});
