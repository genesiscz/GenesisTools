import { SafeJSON } from "@dashboard/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleMcpRequest } from "./mcp-handler";

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

/** A server shaped like createMcpServer() but with one tool and no database. */
function buildServer(): McpServer {
    const server = new McpServer({ name: "nexus-dashboard-test", version: "0.1.0" });
    server.registerTool(
        "echo",
        { description: "Echo the given text", inputSchema: z.object({ text: z.string() }) },
        async (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] })
    );
    return server;
}

async function post(body: unknown): Promise<{ status: number; frame: JsonRpcResponse }> {
    const request = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify(body),
    });
    const response = await handleMcpRequest(request, buildServer());
    return { status: response.status, frame: (await response.json()) as JsonRpcResponse };
}

const INITIALIZE = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "handler-test", version: "1.0.0" },
    },
};

describe("handleMcpRequest", () => {
    it("answers initialize with a negotiated protocol version", async () => {
        const { status, frame } = await post(INITIALIZE);

        expect(status).toBe(200);
        expect(frame.jsonrpc).toBe("2.0");
        expect(frame.id).toBe(1);
        expect(frame.error).toBeUndefined();
        expect(frame.result?.protocolVersion).toBeDefined();
    });

    it("returns a JSON-RPC error frame when the payload is not valid JSON", async () => {
        const request = new Request("http://localhost/api/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "not json",
        });

        const response = await handleMcpRequest(request, buildServer());
        const frame = (await response.json()) as JsonRpcResponse;

        expect(response.status).toBe(500);
        expect(frame.error?.code).toBe(-32603);
        expect(frame.id).toBeNull();
    });

    // Each POST builds its own server and transport pair, so tools/list and
    // tools/call arrive on a connection that never saw an initialize handshake.
    // The v2 server answers them anyway, which is what makes this route work.
    it("lists tools on a fresh per-request server", async () => {
        const { frame } = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });

        expect(frame.error).toBeUndefined();
        expect(frame.id).toBe(2);
        const tools = frame.result?.tools as Array<{ name: string }>;
        expect(tools.map((t) => t.name)).toEqual(["echo"]);
    });

    it("runs a tool and returns its content", async () => {
        const { frame } = await post({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "echo", arguments: { text: "hello" } },
        });

        expect(frame.error).toBeUndefined();
        expect(frame.id).toBe(3);
        expect(frame.result?.content).toEqual([{ type: "text", text: "hello" }]);
    });

    it("reports a tool argument that fails schema validation", async () => {
        const { frame } = await post({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "echo", arguments: { text: 42 } },
        });

        expect(frame.result?.isError).toBe(true);
    });
});
