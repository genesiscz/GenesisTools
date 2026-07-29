import { describe, expect, it } from "bun:test";
import { MAX_TOOL_LIMIT, MCP_TOOLS, toolLimit } from "@app/youtube/lib/mcp/server";

/**
 * `toolLimit` is the security boundary, not the JSON schema: an MCP client can
 * send whatever it likes and the value lands in a SQLite `LIMIT ?`, where a
 * negative number means "no limit".
 */
describe("toolLimit", () => {
    it("passes a sane request through", () => {
        expect(toolLimit(25, 50)).toBe(25);
    });

    it("refuses a negative limit, which SQLite would read as unbounded", () => {
        expect(toolLimit(-1, 50)).toBe(50);
    });

    it("refuses zero and fractional limits", () => {
        expect(toolLimit(0, 50)).toBe(50);
        expect(toolLimit(1.5, 50)).toBe(50);
    });

    it("falls back for a missing or non-numeric limit", () => {
        expect(toolLimit(undefined, 20)).toBe(20);
        expect(toolLimit("100", 20)).toBe(20);
        expect(toolLimit(null, 20)).toBe(20);
        expect(toolLimit(Number.NaN, 20)).toBe(20);
    });

    it("caps an oversized request rather than rejecting it", () => {
        expect(toolLimit(10_000, 50)).toBe(MAX_TOOL_LIMIT);
    });
});

describe("MCP tool registration", () => {
    it("advertises exactly the curated tool set", () => {
        expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
            "list_videos",
            "get_video",
            "search_transcripts",
            "transcript_window",
            "ask",
            "queue_add",
            "queue_status",
        ]);
    });

    // The header calls an MCP client untrusted-ish; these are the verbs that would
    // let one spend money, mutate config or read another tenant's data.
    it("exposes no admin, billing, cache or config verb", () => {
        const forbidden = /admin|billing|credit|cache|config|user|token/i;

        expect(MCP_TOOLS.filter((tool) => forbidden.test(tool.name))).toEqual([]);
    });

    it("gives every tool a description and an object input schema", () => {
        for (const tool of MCP_TOOLS) {
            expect(tool.description.length).toBeGreaterThan(0);
            expect(tool.inputSchema.type).toBe("object");
        }
    });

    it("bounds both paging limits in the advertised schema", () => {
        const bounded = { limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_LIMIT } };

        expect(MCP_TOOLS.find((tool) => tool.name === "list_videos")?.inputSchema.properties).toMatchObject(bounded);
        expect(MCP_TOOLS.find((tool) => tool.name === "search_transcripts")?.inputSchema.properties).toMatchObject(
            bounded
        );
    });
});
