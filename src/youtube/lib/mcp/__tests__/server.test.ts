import { describe, expect, it } from "bun:test";
import { callMcpTool, MAX_TOOL_LIMIT, MCP_TOOLS, toolLimit } from "@app/youtube/lib/mcp/server";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

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

describe("MCP cost and output bounds", () => {
    // queue_add's default must stay on the free path: an MCP client asking to
    // "queue this video" has not asked to be billed for AI transcription.
    it("keeps paid transcription out of the advertised queue_add default", () => {
        const queueAdd = MCP_TOOLS.find((tool) => tool.name === "queue_add");

        expect(queueAdd?.description).toContain("transcribe");
        expect(queueAdd?.description).toMatch(/free stages/i);
    });

    it("bounds ask topK and the transcript window in the schema", () => {
        const ask = MCP_TOOLS.find((tool) => tool.name === "ask");
        const window = MCP_TOOLS.find((tool) => tool.name === "transcript_window");

        expect(ask?.inputSchema.properties).toMatchObject({ topK: { type: "integer", minimum: 1, maximum: 50 } });
        expect(window?.inputSchema.properties).toMatchObject({ windowSec: { minimum: 1, maximum: 600 } });
    });
});

/**
 * Handler-level, through `callMcpTool` rather than stdio: the SDK's framing is not
 * this module's code, but the argument validation and error shape are.
 */
describe("callMcpTool argument handling", () => {
    const listVideosCalls: Array<Record<string, unknown>> = [];
    const yt = {
        db: {
            listVideos: (opts: Record<string, unknown>) => {
                listVideosCalls.push(opts);
                return [];
            },
            getVideo: () => null,
            getTranscript: () => null,
        },
        qa: { keywordSearch: () => [] },
    } as unknown as Parameters<typeof callMcpTool>[0];

    it("raises MethodNotFound for an unknown tool instead of returning a result", async () => {
        await expect(callMcpTool(yt, "no_such_tool", {})).rejects.toMatchObject({
            code: ErrorCode.MethodNotFound,
        });
    });

    // Every one of these would previously have run with the literal string
    // "undefined" (or NaN) rather than refusing.
    it("refuses each required argument when it is missing", async () => {
        for (const [name, field] of [
            ["get_video", "videoId"],
            ["search_transcripts", "query"],
            ["transcript_window", "videoId"],
            ["ask", "question"],
            ["queue_add", "target"],
        ] as const) {
            const result = await callMcpTool(yt, name, {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain(field);
        }
    });

    it("rejects a non-finite atSec before touching the database", async () => {
        const result = await callMcpTool(yt, "transcript_window", { videoId: "abc123def45", atSec: "soon" });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("atSec");
    });

    it("canonicalises a bare channel handle before querying", async () => {
        listVideosCalls.length = 0;
        await callMcpTool(yt, "list_videos", { channel: "bridgemindai" });

        expect(listVideosCalls[0]).toMatchObject({ channel: "@bridgemindai" });
    });

    it("clamps a hostile limit at the handler, not the schema", async () => {
        listVideosCalls.length = 0;
        await callMcpTool(yt, "list_videos", { limit: -1 });
        await callMcpTool(yt, "list_videos", { limit: 10_000 });

        expect(listVideosCalls.map((opts) => opts.limit)).toEqual([50, MAX_TOOL_LIMIT]);
    });
});
