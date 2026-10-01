import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { MCPProviderName } from "@app/mcp-manager/utils/types.js";
import { logger } from "@genesiscz/utils/logger";

/**
 * MCP servers the gateway runs IN ITS OWN PROCESS, instead of each harness session spawning
 * one over stdio. A hosted server keeps its stdio definition in the unified config: that is
 * what every harness outside HOSTED_HTTP_PROVIDERS still gets, and what a rollback restores.
 */
export interface HostedServer {
    /**
     * Env keys of the stored stdio definition that become request headers in the http
     * projection, because a harness cannot pass env to a remote server.
     */
    envHeaders: Record<string, string>;
    /** Lazy, so the gateway pays the import only when a harness first calls the server. */
    load(): Promise<HostedHandler>;
}

export interface HostedPeer {
    clientPort: number;
    serverPort: number;
}

export type HostedHandler = (request: Request, peer: HostedPeer | null) => Promise<Response>;

/**
 * Harnesses whose MCP client the gateway can identify per request (the process that owns the
 * socket, plus its session file). Cursor sends no identity, and grok and copilot carry their
 * session ids only in a stdio child's env, so they keep stdio.
 */
export const HOSTED_HTTP_PROVIDERS: ReadonlySet<MCPProviderName> = new Set<MCPProviderName>(["claude", "codex"]);

const HOSTED: Record<string, HostedServer> = {
    "genesis-tools": {
        envHeaders: { GENESIS_TOOLS_MCP_CAPABILITIES: "X-Genesis-Mcp-Capabilities" },
        async load() {
            const [{ serveGenesisToolsHttp }, { resolveCallerFromPeer }] = await Promise.all([
                import("@app/genesis-tools-mcp/lib/http"),
                import("@app/genesis-tools-mcp/lib/http-caller"),
            ]);

            return (request, peer) => {
                const caller = peer
                    ? resolveCallerFromPeer(peer)
                    : { agent: "unknown" as const, sessionId: null, cwd: null, pid: null, processName: null };
                logger.debug(
                    { server: "genesis-tools", pid: caller.pid, agent: caller.agent, sessionId: caller.sessionId },
                    "gateway hosted call"
                );
                return serveGenesisToolsHttp(request, caller);
            };
        },
    },
};

export const HOSTABLE: readonly string[] = Object.keys(HOSTED);

export function hostedServer(name: string): HostedServer | undefined {
    return Object.hasOwn(HOSTED, name) ? HOSTED[name] : undefined;
}

/** The unified entry asks for the http projection, and the gateway can actually host it. */
export function isGatewayHosted(name: string, config: UnifiedMCPServerConfig | undefined): boolean {
    return config?._meta?.gatewayHosted === true && hostedServer(name) !== undefined;
}

const loaded = new Map<string, Promise<HostedHandler>>();

export function hostedHandler(name: string): Promise<HostedHandler> | undefined {
    const server = hostedServer(name);
    if (!server) {
        return undefined;
    }

    let handler = loaded.get(name);
    if (!handler) {
        handler = server.load();
        loaded.set(name, handler);
        handler.catch((error) => {
            logger.warn({ server: name, error }, "gateway could not load a hosted MCP server");
            loaded.delete(name);
        });
    }

    return handler;
}
