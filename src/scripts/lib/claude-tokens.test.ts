import { describe, expect, it } from "bun:test";
import { isExpired, type McpToken, matchToken, parseTokens } from "./claude-tokens.ts";

function token(partial: Partial<McpToken>): McpToken {
    return { serverName: "s", serverUrl: "https://mcp.example.com/mcp", accessToken: "tok", ...partial };
}

describe("parseTokens", () => {
    it("reads mcpOAuth entries and drops hollow ones", () => {
        const tokens = parseTokens({
            mcpOAuth: {
                a: { serverName: "figma", serverUrl: "https://mcp.figma.com/mcp", accessToken: "live", expiresAt: 123 },
                b: { serverName: "never-authorised", serverUrl: "https://x.example.com", accessToken: "" },
                c: { serverName: "no-url", accessToken: "tok" },
            },
        });

        expect(tokens).toHaveLength(1);
        expect(tokens[0]?.serverName).toBe("figma");
        expect(tokens[0]?.expiresAt).toBe(123);
    });

    it("returns empty for payloads without an mcpOAuth store", () => {
        expect(parseTokens({})).toEqual([]);
        expect(parseTokens({ mcpOAuth: "garbage" as unknown as Record<string, never> })).toEqual([]);
        expect(parseTokens({ mcpOAuth: [1, 2] })).toEqual([]);
    });

    it("skips malformed entries without dropping the valid ones", () => {
        const tokens = parseTokens({
            mcpOAuth: {
                broken: null,
                alsoBroken: "string",
                array: [1],
                fine: { serverName: "ok", serverUrl: "https://x.example.com/mcp", accessToken: "tok" },
            },
        });

        expect(tokens.map((t) => t.serverName)).toEqual(["ok"]);
    });
});

describe("isExpired", () => {
    it("treats a token within the 60s skew as stale, and no expiry as live", () => {
        expect(isExpired(token({ expiresAt: Date.now() + 30_000 }))).toBe(true);
        expect(isExpired(token({ expiresAt: Date.now() + 120_000 }))).toBe(false);
        expect(isExpired(token({ expiresAt: undefined }))).toBe(false);
    });
});

describe("matchToken", () => {
    it("matches origin + pathname, ignoring trailing slashes", () => {
        const tokens = [token({ serverUrl: "https://mcp.example.com/mcp/" })];

        expect(matchToken(tokens, "https://mcp.example.com/mcp")).toBeDefined();
        expect(matchToken(tokens, "https://mcp.example.com/other")).toBeUndefined();
        expect(matchToken(tokens, "https://other.example.com/mcp")).toBeUndefined();
    });
});
