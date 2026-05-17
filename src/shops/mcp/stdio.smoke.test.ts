import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: { protocolVersion?: string; capabilities?: Record<string, unknown> };
    error?: { code: number; message: string };
}

async function runInitializeAndListTools(): Promise<{ initialize: JsonRpcResponse; listTools: JsonRpcResponse }> {
    const proc = Bun.spawn(["bun", "src/shops/index.ts", "mcp"], {
        cwd: process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    const initRequest = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smoke-test", version: "1.0.0" },
        },
    };
    const listRequest = {
        jsonrpc: "2.0" as const,
        id: 2,
        method: "tools/list",
    };

    proc.stdin.write(`${SafeJSON.stringify(initRequest)}\n`);
    proc.stdin.write(`${SafeJSON.stringify(listRequest)}\n`);
    proc.stdin.end();

    const stdoutText = await new Response(proc.stdout).text();
    proc.kill();
    await proc.exited;

    const lines = stdoutText.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
        throw new Error(
            `Expected at least 2 JSON-RPC frames on stdout, got ${lines.length}: ${stdoutText.slice(0, 500)}`
        );
    }

    const initialize = SafeJSON.parse(lines[0]) as JsonRpcResponse;
    const listTools = SafeJSON.parse(lines[1]) as JsonRpcResponse;
    return { initialize, listTools };
}

describe("MCP stdio smoke", () => {
    it("boots the server, returns valid JSON-RPC frames, no stdout pollution", async () => {
        const { initialize, listTools } = await runInitializeAndListTools();
        expect(initialize.jsonrpc).toBe("2.0");
        expect(initialize.id).toBe(1);
        expect(initialize.result).toBeDefined();
        expect(initialize.result?.protocolVersion).toBeDefined();

        expect(listTools.jsonrpc).toBe("2.0");
        expect(listTools.id).toBe(2);
        const tools = (listTools.result as unknown as { tools: Array<{ name: string }> }).tools;
        expect(tools.length).toBe(8);
        expect(tools.every((t) => !t.name.startsWith("shops_ingest"))).toBe(true);
    }, 15_000);
});
