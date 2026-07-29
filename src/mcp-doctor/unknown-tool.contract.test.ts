import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { Client, ProtocolErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SRC_ROOT = join(import.meta.dir, "..");

interface ServerUnderTest {
    name: string;
    /** Path relative to src/. */
    entry: string;
    args: string[];
    /**
     * True when the unknown-tool branch sits inside a try whose catch flattens
     * exceptions into an isError result. Those catches must re-throw
     * ProtocolError or they silently convert the protocol error back into a
     * tool error, which typechecks and looks fine in review.
     */
    catchWrapped: boolean;
    /** Extra env needed to boot. Never real credentials: no tool call leaves the process. */
    env?: Record<string, string>;
}

const SERVERS: ServerUnderTest[] = [
    { name: "shops", entry: "shops/index.ts", args: ["mcp"], catchWrapped: false },
    { name: "claude", entry: "claude/index.ts", args: ["mcp"], catchWrapped: false },
    { name: "har-analyzer", entry: "har-analyzer/index.ts", args: ["mcp"], catchWrapped: true },
    { name: "mcp-web-reader", entry: "mcp-web-reader/index.ts", args: ["--server"], catchWrapped: true },
    { name: "mcp-ripgrep", entry: "mcp-ripgrep/index.ts", args: [], catchWrapped: false },
    {
        name: "jenkins-mcp",
        entry: "jenkins-mcp/index.ts",
        args: [],
        catchWrapped: true,
        // readEnvAuth() throws unless all three are set, but it only reads them.
        // An unknown-tool call is rejected before any HTTP request is issued.
        env: {
            JENKINS_URL: "http://jenkins.invalid",
            JENKINS_USER: "contract-test",
            JENKINS_TOKEN: "not-a-real-token",
        },
    },
];

/** StdioClientTransport wants Record<string, string>; the process env is sparser than that. */
function definedEnv(): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(env.getProcessEnv())) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
}

async function callUnknownTool(server: ServerUnderTest): Promise<{ code?: number; message: string }> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", join(SRC_ROOT, server.entry), ...server.args],
        env: { ...definedEnv(), ...server.env },
    });
    const client = new Client({ name: "unknown-tool-contract", version: "1.0.0" });
    await client.connect(transport);

    try {
        await client.callTool({ name: "definitely_not_a_tool", arguments: {} });
        return { message: "__no_error_thrown__" };
    } catch (error) {
        const protocolError = error as { code?: number; message: string };
        return { code: protocolError.code, message: protocolError.message };
    } finally {
        await client.close();
    }
}

// A tool the server never advertised is a lookup failure, so it belongs in the
// JSON-RPC error channel, not in an isError CallToolResult. Every server below
// implements that branch independently, so it is asserted per server.
//
// This covers every in-repo stdio MCP server that can be booted hermetically.
// The one omission is mcp-tsc, whose MCP command builds a TypeScript LSP server
// bound to a cwd and tsconfig, so spawning it means starting a full LSP over the
// repo to assert a single throw.
describe("MCP servers reject unknown tools with MethodNotFound", () => {
    for (const server of SERVERS) {
        const label = server.catchWrapped ? `${server.name} (catch-wrapped)` : server.name;

        it(label, async () => {
            const { code, message } = await callUnknownTool(server);

            expect(code).toBe(ProtocolErrorCode.MethodNotFound);
            expect(message).toContain("definitely_not_a_tool");
        }, 30_000);
    }
});
