import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: { protocolVersion?: string; capabilities?: Record<string, unknown> };
    error?: { code: number; message: string };
}

interface JsonRpcFrame {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
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

    // Both pipes must be drained concurrently. The server logs to stderr, so
    // reading stdout alone would deadlock once the stderr pipe buffer fills:
    // the child blocks on write, never exits, and stdout never reaches EOF.
    const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    proc.kill();
    await proc.exited;

    const context = `\nstdout: ${stdoutText.slice(0, 500)}\nstderr: ${stderrText.slice(0, 500)}`;
    const lines = stdoutText.split("\n").filter((l) => l.trim().length > 0);

    // Every stdout line must be a JSON-RPC frame. This is the "no stdout
    // pollution" half of the contract: one stray console.log anywhere in the
    // server or its imports corrupts the stream for every client.
    const byId = new Map<number | string, JsonRpcResponse>();
    for (const [index, line] of lines.entries()) {
        let frame: JsonRpcFrame;

        try {
            frame = SafeJSON.parse(line) as JsonRpcFrame;
        } catch {
            throw new Error(`stdout line ${index + 1} is not JSON, so something polluted the stream: ${line}`);
        }

        if (frame.jsonrpc !== "2.0") {
            throw new Error(`stdout line ${index + 1} is not a JSON-RPC 2.0 frame: ${line}`);
        }

        // Notifications carry no id and need no correlation.
        if (frame.id === undefined) {
            continue;
        }

        byId.set(frame.id, frame as JsonRpcResponse);
    }

    const initialize = byId.get(1);
    const listTools = byId.get(2);
    if (!initialize || !listTools) {
        throw new Error(`Missing responses for ids 1 and 2, got ids [${[...byId.keys()].join(", ")}].${context}`);
    }

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
