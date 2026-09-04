/**
 * Thin door to the shared chrome-devtools-mcp client
 * (`@genesiscz/utils/devtools/mcp-client`): call the real MCP tools against
 * ANY CDP port, with no session config edit and no restart.
 */
import { toolText, withDevtoolsClient } from "@genesiscz/utils/devtools/mcp-client";
import type { Client } from "@modelcontextprotocol/client";

export interface McpOpts {
    cdpUrl?: string;
    port?: number;
    /** How this client names itself to the server. Other tools' doors pass their own. */
    clientName?: string;
}

export function urlOf(opts: McpOpts): string {
    return opts.cdpUrl ?? `http://127.0.0.1:${opts.port ?? 9222}`;
}

export async function withMcp<T>(fn: (client: Client) => Promise<T>, opts: McpOpts = {}): Promise<T> {
    return withDevtoolsClient(fn, {
        cdpUrl: urlOf(opts),
        clientName: opts.clientName ?? "genesis-chrome-devtools",
    });
}

export async function callTool(name: string, args: Record<string, unknown> = {}, opts: McpOpts = {}) {
    return withMcp((c) => c.callTool({ name, arguments: args }), opts);
}

export async function listTools(opts: McpOpts = {}): Promise<string[]> {
    return withMcp(async (c) => (await c.listTools()).tools.map((t) => t.name), opts);
}

export { toolText };
