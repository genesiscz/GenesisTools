import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: { protocolVersion?: string; capabilities?: Record<string, unknown> };
    error?: { code: number; message: string };
}

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: Record<string, unknown>;
}

const INITIALIZE: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
};

/** Boot the stdio server, write every frame, and return the responses keyed by request id. */
async function exchange(requests: JsonRpcRequest[]): Promise<Map<number, JsonRpcResponse>> {
    const proc = Bun.spawn(["bun", "src/shops/index.ts", "mcp"], {
        cwd: process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    for (const request of requests) {
        proc.stdin.write(`${SafeJSON.stringify(request)}\n`);
    }

    proc.stdin.end();

    const stdoutText = await new Response(proc.stdout).text();
    proc.kill();
    await proc.exited;

    const lines = stdoutText.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < requests.length) {
        throw new Error(
            `Expected ${requests.length} JSON-RPC frames on stdout, got ${lines.length}: ${stdoutText.slice(0, 500)}`
        );
    }

    const byId = new Map<number, JsonRpcResponse>();
    for (const line of lines) {
        const frame = SafeJSON.parse(line) as JsonRpcResponse;
        byId.set(Number(frame.id), frame);
    }

    return byId;
}

describe("MCP stdio smoke", () => {
    it("boots the server, returns valid JSON-RPC frames, no stdout pollution", async () => {
        const responses = await exchange([INITIALIZE, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);

        const initialize = responses.get(1);
        expect(initialize?.jsonrpc).toBe("2.0");
        expect(initialize?.result).toBeDefined();
        expect(initialize?.result?.protocolVersion).toBeDefined();

        const listTools = responses.get(2);
        expect(listTools?.jsonrpc).toBe("2.0");
        const tools = (listTools?.result as unknown as { tools: Array<{ name: string }> }).tools;
        expect(tools.length).toBe(8);
        expect(tools.every((t) => !t.name.startsWith("shops_ingest"))).toBe(true);
    }, 15_000);

    it("answers an unknown tool with a MethodNotFound protocol error, not an isError result", async () => {
        const responses = await exchange([
            INITIALIZE,
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "shops_definitely_not_a_tool", arguments: {} },
            },
        ]);

        const call = responses.get(2);
        expect(call?.result).toBeUndefined();
        expect(call?.error?.code).toBe(-32601);
        expect(call?.error?.message).toContain("shops_definitely_not_a_tool");
    }, 15_000);
});
