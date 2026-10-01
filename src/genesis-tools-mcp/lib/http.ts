import { type AgentCaller, currentCaller, runAsCaller } from "@genesiscz/utils/agent/runtime";
import { logger } from "@genesiscz/utils/logger";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createGenesisToolsServer } from "./server";

const log = logger.child({ component: "genesis-tools-mcp:http" });

/**
 * The capability list over HTTP. A harness config cannot set env for a remote server, so
 * mcp-manager writes the stored GENESIS_TOOLS_MCP_CAPABILITIES value into this header.
 */
export const CAPABILITIES_HEADER = "X-Genesis-Mcp-Capabilities";

export function parseCapabilities(raw: string | null | undefined): string[] | undefined {
    const capabilities = (raw ?? "")
        .split(",")
        .map((capability) => capability.trim().toLowerCase())
        .filter((capability) => capability.length > 0);

    return capabilities.length > 0 ? capabilities : undefined;
}

const UNKNOWN_CALLER: AgentCaller = { agent: "unknown", sessionId: null, cwd: null };

let handler: McpHttpHandler | undefined;

/**
 * Stateless: every request gets a fresh server from the same registry, so a gateway restart
 * loses no session state and many harness sessions share one process. The factory runs inside
 * the request's caller scope (AsyncLocalStorage follows the awaits inside `fetch`); the caller
 * it reads there is pinned onto every tool handler of that request's server.
 */
function mcpHandler(): McpHttpHandler {
    if (!handler) {
        handler = createMcpHandler(
            async (ctx) => {
                const caller = currentCaller() ?? UNKNOWN_CALLER;
                const capabilities = parseCapabilities(ctx.requestInfo?.headers.get(CAPABILITIES_HEADER));
                const { server } = await createGenesisToolsServer({
                    capabilities,
                    runCall: (fn) => runAsCaller(caller, fn),
                });
                return server;
            },
            { onerror: (error) => log.warn({ error }, "genesis-tools http request failed") }
        );
    }

    return handler;
}

/** Serve one genesis-tools MCP request as `caller`. */
export function serveGenesisToolsHttp(request: Request, caller: AgentCaller): Promise<Response> {
    const mcp = mcpHandler();
    return runAsCaller(caller, () => mcp.fetch(request));
}
