import { describe, expect, it } from "bun:test";
import { globMatch, matchesSelector, parseSelector } from "./match.ts";

const KNOWN = ["chrome-devtools-mcp", "genesis-tools", "x-docs", "a.b"];

describe("globMatch", () => {
    it("matches literally without a star, case-insensitive", () => {
        expect(globMatch("Genesis-Tools", "genesis-tools")).toBe(true);
        expect(globMatch("genesis", "genesis-tools")).toBe(false);
    });

    it("expands stars anywhere", () => {
        expect(globMatch("handoff_*", "handoff_list")).toBe(true);
        expect(globMatch("*.take_*", "x.take_screenshot")).toBe(true);
        expect(globMatch("take_*", "list_pages")).toBe(false);
    });

    it("escapes regex metacharacters in the pattern", () => {
        expect(globMatch("a.b", "axb")).toBe(false);
        expect(globMatch("a.b", "a.b")).toBe(true);
    });

    it("a literal space in the pattern is not a wildcard", () => {
        expect(globMatch("take *", "take screenshot")).toBe(true);
        expect(globMatch("take screen*", "take_XX_screenshot")).toBe(false);
    });
});

describe("parseSelector", () => {
    it("bare server name selects every tool", () => {
        expect(parseSelector("genesis-tools", KNOWN)).toEqual({
            raw: "genesis-tools",
            provider: "mcp",
            server: "genesis-tools",
            tool: "*",
        });
    });

    it("splits server.tool on the known-server boundary", () => {
        const s = parseSelector("genesis-tools.handoff_*", KNOWN);
        expect(s.server).toBe("genesis-tools");
        expect(s.tool).toBe("handoff_*");
    });

    it("a known server name containing a dot wins over the first-dot split", () => {
        const s = parseSelector("a.b.some_tool", KNOWN);
        expect(s.server).toBe("a.b");
        expect(s.tool).toBe("some_tool");
    });

    it("falls back to first-dot split for unknown servers", () => {
        const s = parseSelector("unknown-server.tool_name", []);
        expect(s.server).toBe("unknown-server");
        expect(s.tool).toBe("tool_name");
    });

    it("accepts the explicit mcp: provider prefix", () => {
        const s = parseSelector("mcp:genesis-tools.handoff_list", KNOWN);
        expect(s.provider).toBe("mcp");
        expect(s.server).toBe("genesis-tools");
        expect(s.tool).toBe("handoff_list");
    });

    it("rejects an unknown provider prefix, naming the known set", () => {
        expect(() => parseSelector("composio:GMAIL_SEND", KNOWN)).toThrow(/Unknown provider 'composio'.*mcp/);
    });

    it("a URL scheme is not a provider prefix", () => {
        expect(() => parseSelector("http://x", KNOWN)).not.toThrow();
        expect(parseSelector("http://x", KNOWN).provider).toBe("mcp");
    });

    it("a known server name containing a colon wins over provider parsing", () => {
        const s = parseSelector("docker:mcp.list", ["docker:mcp"]);
        expect(s.server).toBe("docker:mcp");
        expect(s.tool).toBe("list");
    });

    it("rejects empty and provider-only selectors", () => {
        expect(() => parseSelector("", KNOWN)).toThrow(/Empty selector/);
        expect(() => parseSelector("mcp:", KNOWN)).toThrow(/names a provider but nothing else/);
    });

    it("wildcard both halves", () => {
        const s = parseSelector("*.*", KNOWN);
        expect(s.server).toBe("*");
        expect(s.tool).toBe("*");
    });
});

describe("matchesSelector", () => {
    it("requires both halves to match", () => {
        const s = parseSelector("chrome-devtools-mcp.take_*", KNOWN);
        expect(matchesSelector(s, "chrome-devtools-mcp", "take_screenshot")).toBe(true);
        expect(matchesSelector(s, "chrome-devtools-mcp", "list_pages")).toBe(false);
        expect(matchesSelector(s, "genesis-tools", "take_screenshot")).toBe(false);
    });
});
